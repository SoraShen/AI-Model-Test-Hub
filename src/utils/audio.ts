// DashScope Qwen-Omni streams audio output as base64-encoded raw PCM int16 mono
// samples at 24 kHz (the `format: "wav"` request flag is misleading: the bytes
// have no RIFF header). Wrap them in a real WAV container so <audio> can play it.
export function pcm16ToWavBlob(
  pcmBytes: Uint8Array,
  sampleRate = 24000,
  channels = 1
): Blob {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function base64PcmToWavBlob(
  base64: string,
  sampleRate = 24000,
  channels = 1
): Blob | null {
  if (!base64) return null;
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return pcm16ToWavBlob(bytes, sampleRate, channels);
  } catch {
    return null;
  }
}

// Pick a filename that the upstream model service will accept. When the user
// uploaded a real File the original name (with its real extension, e.g. .m4a)
// is best. For anonymous Blobs from MediaRecorder we derive an extension from
// the MIME type; we never fall back to the literal "audio" extension because
// the server's ext-allowlists reject it.
export function pickUploadFilename(blob: Blob | File, fallbackBase = 'recording'): string {
  const f = blob as File;
  const name = typeof (f as any)?.name === 'string' ? (f as any).name : '';
  if (name && name.includes('.')) return name;

  const t = (blob.type || '').toLowerCase();
  const ext = t.includes('webm')
    ? 'webm'
    : t.includes('wav') || t.includes('wave')
      ? 'wav'
      : t.includes('x-m4a') || t.includes('mp4a') || t.includes('aac')
        ? 'm4a'
        : t.includes('mp4')
          ? 'mp4'
          : t.includes('mpeg') || t.includes('mp3')
            ? 'mp3'
            : t.includes('ogg') || t.includes('opus')
              ? 'ogg'
              : t.includes('flac')
                ? 'flac'
                : 'webm'; // safe default for browser MediaRecorder

  return `${fallbackBase}.${ext}`;
}

// Streaming PCM player. Decodes base64 int16-LE chunks (mono, 24 kHz by default)
// and schedules them on a single AudioContext so playback is gapless and starts
// as soon as the first chunk arrives. Designed for chatbot-style voice replies.
export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private active = false;
  private readonly sampleRate: number;
  private readonly channels: number;
  private endedAt: number | null = null;

  constructor(sampleRate = 24000, channels = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  /** Lazily create the AudioContext on first use (must be inside a user gesture handler). */
  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
      this.active = true;
    }
    return this.ctx;
  }

  start(): void {
    this.ensureCtx();
  }

  enqueueBase64Pcm16(base64: string): void {
    if (!base64) return;
    const ctx = this.ensureCtx();
    if (!ctx || !this.active) return;

    let bin: string;
    try {
      bin = atob(base64);
    } catch {
      return;
    }
    const totalBytes = bin.length;
    const numSamples = (totalBytes - (totalBytes % 2)) / 2;
    if (numSamples === 0) return;

    const float32 = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      let s = (hi << 8) | lo;
      if (s >= 0x8000) s -= 0x10000;
      float32[i] = s / 32768;
    }

    const buffer = ctx.createBuffer(this.channels, numSamples, this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.endedAt = this.nextStartTime;
  }

  /** ms of buffered audio remaining ahead of the playback cursor. */
  bufferedAheadMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.nextStartTime - this.ctx.currentTime) * 1000);
  }

  /** Stop accepting new chunks and tear down. Existing scheduled chunks are cut. */
  async stop(): Promise<void> {
    this.active = false;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
    this.nextStartTime = 0;
    this.endedAt = null;
  }
}
