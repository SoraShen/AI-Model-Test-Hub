import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { Loader2, Mic, Square, Upload, Wand2 } from 'lucide-react';
import { PcmStreamPlayer, base64PcmToWavBlob, pickUploadFilename } from '../utils/audio';

type Pipeline = 'llm' | 'asr_llm' | 'omni';

export default function TabAgent() {
  const { t } = useI18n();
  const [models, setModels] = useState<any[]>([]);
  const [pipeline, setPipeline] = useState<Pipeline>('llm');

  const [llmModelId, setLlmModelId] = useState<string>('');
  const [asrModelId, setAsrModelId] = useState<string>('');
  const [omniModelId, setOmniModelId] = useState<string>('');

  const [prompt, setPrompt] = useState(
    'You are a customer support agent. Answer clearly, ask clarifying questions when needed, and keep a helpful tone.'
  );
  const [inputText, setInputText] = useState('');
  const [enableThinking, setEnableThinking] = useState(false);
  const [stream, setStream] = useState(false);
  const [omniVoice, setOmniVoice] = useState(false);
  const [omniAudioUrl, setOmniAudioUrl] = useState<string>('');

  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioPlayerRef = useRef<PcmStreamPlayer | null>(null);

  useEffect(() => {
    return () => {
      audioPlayerRef.current?.stop();
      audioPlayerRef.current = null;
    };
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [output, setOutput] = useState('');
  const [steps, setSteps] = useState<Array<{ title: string; content: string }>>([]);
  const [metrics, setMetrics] = useState<any | null>(null);

  useEffect(() => {
    fetch('/api/models').then((res) => res.json()).then(setModels);
  }, []);

  // The "LLM Model" dropdown (used both in the LLM pipeline and as the answer
  // generator in the ASR -> LLM pipeline) accepts both LLM and OMNI models;
  // OMNI models can do plain text-in / text-out as well as voice reply.
  const llmModels = useMemo(
    () => models.filter((m) => m.type === 'LLM' || m.type === 'OMNI'),
    [models]
  );
  const asrModels = useMemo(() => models.filter((m) => m.type === 'ASR'), [models]);
  const omniModels = useMemo(
    () => models.filter((m) => m.type === 'OMNI' || String(m.name || '').toLowerCase().includes('omni')),
    [models]
  );

  const selectedLlm = useMemo(
    () => models.find((m) => String(m.id) === String(llmModelId)),
    [models, llmModelId]
  );
  const selectedAsr = useMemo(
    () => models.find((m) => String(m.id) === String(asrModelId)),
    [models, asrModelId]
  );
  const selectedOmni = useMemo(
    () => models.find((m) => String(m.id) === String(omniModelId)),
    [models, omniModelId]
  );

  const outputModelLabel = useMemo(() => {
    if (pipeline === 'llm') return selectedLlm?.name || '';
    if (pipeline === 'asr_llm') {
      const a = selectedAsr?.name;
      const l = selectedLlm?.name;
      return a || l ? `${a || 'ASR'} → ${l || 'LLM'}` : '';
    }
    if (pipeline === 'omni') return selectedOmni?.name || '';
    return '';
  }, [pipeline, selectedAsr?.name, selectedLlm?.name, selectedOmni?.name]);

  // True when the user picked an OMNI model from the "LLM Model" dropdown of
  // the LLM pipeline. In that case we expand the input area to look like the
  // omni pipeline (mic + upload + voice reply) and the server routes it
  // through the OMNI chat path.
  const isLlmOmni = pipeline === 'llm' && selectedLlm?.type === 'OMNI';
  const omniLikePipeline = pipeline === 'omni' || isLlmOmni;

  useEffect(() => {
    // Basic auto-select to reduce clicks.
    if (!llmModelId && llmModels.length) setLlmModelId(String(llmModels[0].id));
    if (!asrModelId && asrModels.length) setAsrModelId(String(asrModels[0].id));
    if (!omniModelId && omniModels.length) setOmniModelId(String(omniModels[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  useEffect(() => {
    // Low-latency defaults:
    // - Streaming on (better perceived latency / TTFT)
    // - Thinking off by default (often increases latency)
    if (pipeline === 'llm' || pipeline === 'asr_llm' || pipeline === 'omni') {
      setStream(true);
      setEnableThinking(false);
    } else {
      setStream(false);
      setEnableThinking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() || '' : '';
    if (pipeline === 'asr_llm') {
      const asr = models.find((m) => String(m.id) === String(asrModelId));
      if (asr?.type === 'ASR' && asr?.name === 'qwen3-asr-flash') {
        const allowed = new Set(['aac','amr','avi','aiff','flac','flv','mkv','mp3','mpeg','mpg','ogg','opus','wav','webm','wma','wmv','m4a','mp4','mov']);
        if (!allowed.has(ext)) return alert(`Unsupported file type .${ext || '(none)'} for qwen3-asr-flash`);
      }
    }
    setAudioBlob(file);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType =
        MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : '';
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mediaRecorder;
      const chunks: BlobPart[] = [];
      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
      mediaRecorder.onstop = () => {
        const recordedBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        setAudioBlob(recordedBlob);
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      alert('Microphone access denied');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  const run = async () => {
    setIsLoading(true);
    setOutput('');
    setSteps([]);
    setMetrics(null);
    if (omniAudioUrl) URL.revokeObjectURL(omniAudioUrl);
    setOmniAudioUrl('');

    const fd = new FormData();
    fd.append('pipeline', pipeline);
    fd.append('prompt', prompt);
    fd.append('input_text', inputText);
    fd.append('stream', String(stream));
    fd.append('enable_thinking', String(enableThinking && stream));
    if (omniLikePipeline) fd.append('omni_voice', String(omniVoice && stream));
    if (llmModelId) fd.append('llm_model_id', llmModelId);
    if (asrModelId) fd.append('asr_model_id', asrModelId);
    if (omniModelId) fd.append('omni_model_id', omniModelId);

    if (audioBlob && (pipeline === 'asr_llm' || omniLikePipeline)) {
      const field = omniLikePipeline ? 'media' : 'audio';
      fd.append(field, audioBlob, pickUploadFilename(audioBlob, 'recording'));
    }

    try {
      if (!stream) {
        const res = await fetch('/api/agent/run', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
          setOutput(`Error: ${data.error || 'Agent run failed'}`);
        } else {
          setSteps(data.steps || []);
          setOutput(data.output || '');
          setMetrics(data.metrics || null);
        }
      } else {
        const startedAt = performance.now();
        let firstTokenAt: number | null = null;

        const wantsLivePlayback = omniLikePipeline && omniVoice;
        if (wantsLivePlayback) {
          audioPlayerRef.current?.stop();
          const player = new PcmStreamPlayer(24000, 1);
          player.start();
          audioPlayerRef.current = player;
        }

        const res = await fetch('/api/agent/run/stream', { method: 'POST', body: fd });
        if (!res.ok || !res.body) {
          const text = await res.text();
          setOutput(`Error: ${text || res.statusText}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let full = '';
        let audioB64 = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while (true) {
            const idxLf = buf.indexOf('\n\n');
            const idxCrLf = buf.indexOf('\r\n\r\n');
            if (idxLf === -1 && idxCrLf === -1) break;
            idx = idxLf !== -1 ? idxLf : idxCrLf;
            const sepLen = idxLf !== -1 ? 2 : 4;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + sepLen);
            const lines = frame.split('\n').map(l => l.trimEnd());
            const eventLine = lines.find(l => l.startsWith('event:'));
            // IMPORTANT: preserve leading spaces in SSE payload
            const dataLines = lines
              .filter(l => l.startsWith('data:'))
              .map(l => (l.startsWith('data: ') ? l.slice(6) : l.slice(5)));
            const event = eventLine ? eventLine.slice('event:'.length).trim() : 'message';
            const data = dataLines.join('\n');
            if (event === 'delta') {
              if (firstTokenAt === null) firstTokenAt = performance.now();
              full += data;
              setOutput(full);
            } else if (event === 'audio') {
              audioB64 += data;
              audioPlayerRef.current?.enqueueBase64Pcm16(data);
            } else if (event === 'metrics') {
              try { setMetrics(JSON.parse(data)); } catch {}
            } else if (event === 'steps') {
              try { setSteps(JSON.parse(data) || []); } catch {}
            } else if (event === 'error') {
              setOutput(`Error: ${data}`);
            }
          }
        }
        const wavBlob = base64PcmToWavBlob(audioB64, 24000, 1);
        if (wavBlob) {
          setOmniAudioUrl(URL.createObjectURL(wavBlob));
        }
        const endAt = performance.now();
        if (!metrics) {
          setMetrics({
            latency_ms: Math.round(endAt - startedAt),
            ttft_ms: firstTokenAt ? Math.round(firstTokenAt - startedAt) : null,
          });
        }
      }
    } catch {
      setOutput('Execution failed');
    } finally {
      setIsLoading(false);
    }
  };

  // Audio inputs are needed for ASR->LLM (always), the OMNI pipeline (when no
  // text is given), and for an OMNI model selected in the LLM pipeline (when
  // no text is given). Text-only OMNI is allowed.
  const needsAudio = pipeline === 'asr_llm' || omniLikePipeline;
  const canRun =
    !isLoading &&
    (pipeline === 'llm'
      ? !!llmModelId && (isLlmOmni
          ? !!audioBlob || !!inputText.trim()
          : true)
      : pipeline === 'asr_llm'
        ? !!asrModelId && !!llmModelId && !!audioBlob
        : !!omniModelId && (!!audioBlob || !!inputText.trim()));

  return (
    <div className="grid grid-rows-[auto,1fr] gap-4 md:gap-6 min-h-0 flex-1">
      <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-6 flex flex-col md:flex-row md:flex-wrap md:items-end md:justify-between gap-4 md:gap-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:flex-wrap md:items-end gap-4 md:gap-6 w-full md:w-auto">
          <div className="space-y-2 w-full md:w-auto">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Pipeline</label>
            <select
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value as Pipeline)}
              className="w-full md:min-w-[240px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
            >
              <option value="llm">LLM (text → text)</option>
              <option value="asr_llm">ASR → LLM (audio → text → answer)</option>
              <option value="omni">OMNI (audio understanding → text)</option>
            </select>
          </div>

          {pipeline === 'llm' && (
            <div className="space-y-2 w-full md:w-auto">
              <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">LLM / OMNI Model</label>
              <select
                value={llmModelId}
                onChange={(e) => setLlmModelId(e.target.value)}
                className="w-full md:min-w-[320px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
              >
                <option value="">-- Select --</option>
                {llmModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.type})
                  </option>
                ))}
              </select>
            </div>
          )}

          {pipeline === 'asr_llm' && (
            <>
              <div className="space-y-2 w-full md:w-auto">
                <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">ASR Model</label>
                <select
                  value={asrModelId}
                  onChange={(e) => setAsrModelId(e.target.value)}
                  className="w-full md:min-w-[320px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
                >
                  <option value="">-- Select --</option>
                  {asrModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2 w-full md:w-auto">
                <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">LLM / OMNI Model</label>
                <select
                  value={llmModelId}
                  onChange={(e) => setLlmModelId(e.target.value)}
                  className="w-full md:min-w-[320px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
                >
                  <option value="">-- Select --</option>
                  {llmModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.type})
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {pipeline === 'omni' && (
            <div className="space-y-2 w-full md:w-auto">
              <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">OMNI Model</label>
              <select
                value={omniModelId}
                onChange={(e) => setOmniModelId(e.target.value)}
                className="w-full md:min-w-[360px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
              >
                <option value="">-- Select --</option>
                {omniModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(pipeline === 'llm' || pipeline === 'asr_llm' || pipeline === 'omni') && (
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Options</label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 select-none">
                  <input
                    type="checkbox"
                    checked={stream}
                    onChange={(e) => setStream(e.target.checked)}
                    className="accent-indigo-600"
                  />
                  Streaming
                </label>
                {(pipeline === 'llm' || pipeline === 'asr_llm') && !isLlmOmni && (
                  <label className={`flex items-center gap-2 text-xs select-none ${stream ? 'text-slate-700' : 'text-slate-400'}`}>
                    <input
                      type="checkbox"
                      checked={enableThinking && stream}
                      onChange={(e) => setEnableThinking(e.target.checked)}
                      disabled={!stream}
                      className="accent-indigo-600"
                    />
                    Thinking {stream ? '' : '(streaming only)'}
                  </label>
                )}
                {omniLikePipeline && (
                  <label className={`flex items-center gap-2 text-xs select-none ${stream ? 'text-slate-700' : 'text-slate-400'}`}>
                    <input
                      type="checkbox"
                      checked={omniVoice && stream}
                      onChange={(e) => setOmniVoice(e.target.checked)}
                      disabled={!stream}
                      className="accent-indigo-600"
                    />
                    Voice reply (English) {stream ? '' : '(streaming only)'}
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={run}
          disabled={!canRun}
          className="h-11 md:h-10 w-full md:w-auto px-6 md:px-8 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-200 disabled:text-slate-500 text-white font-bold text-xs rounded-lg shadow-sm flex items-center justify-center gap-2 transition-all active:scale-95"
        >
          {isLoading ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
          RUN
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 min-h-0 pb-2 md:pb-6 flex-1 lg:items-stretch lg:min-h-0">
        <div className="bg-white rounded-xl border border-slate-200 flex flex-col min-h-0 lg:max-h-[calc(100dvh-10rem)] shadow-sm">
          <div className="shrink-0 p-3 md:p-4 border-b border-slate-200 flex justify-between items-center bg-white/70">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
              Prompt
            </h3>
            <span className="text-[10px] text-slate-500 font-mono">CHARS: {prompt.length}</span>
          </div>
          <div className="shrink-0 p-4 md:p-6 border-b border-slate-200">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full min-h-[100px] md:min-h-[120px] bg-transparent resize-y outline-none text-sm text-slate-800 placeholder:text-slate-400 font-mono leading-relaxed"
              placeholder="System prompt / agent instructions..."
            />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            {!needsAudio ? (
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                className="w-full min-h-[200px] lg:min-h-[280px] bg-transparent resize-y outline-none text-sm text-slate-800 placeholder:text-slate-400 font-mono leading-relaxed"
                placeholder="Customer message / context..."
              />
            ) : (
              <div className="flex flex-col gap-4 md:gap-6">
                <div className="min-h-[140px] md:min-h-[168px] shrink-0 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 group hover:border-indigo-300 transition-colors relative p-4 text-center">
                  <input
                    type="file"
                    accept={omniLikePipeline ? 'audio/*,image/*,video/*' : 'audio/*'}
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />
                  <Upload className="text-slate-500 group-hover:text-indigo-600 mb-2" size={28} />
                  <span className="text-sm font-medium text-slate-500 break-all px-2">
                    {audioBlob
                      ? (audioBlob as any).name || 'Recorded audio'
                      : omniLikePipeline
                        ? 'Tap to choose audio / image / video (optional)'
                        : 'Tap to choose an audio file'}
                  </span>
                </div>

                {omniLikePipeline && (
                  <div className="border border-slate-200 rounded-xl bg-white p-4 shrink-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                        {t('inputText')} {audioBlob ? '(optional)' : '(or speak via mic / upload)'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">CHARS: {inputText.length}</span>
                    </div>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      className="w-full min-h-[90px] bg-transparent resize-none outline-none text-sm text-slate-800 placeholder:text-slate-400 font-mono leading-relaxed"
                      placeholder={
                        isLlmOmni
                          ? 'Type your message – the OMNI model can answer in text or voice...'
                          : 'Add context or instructions for omni (optional)...'
                      }
                    />
                  </div>
                )}

                <div className="grid shrink-0 grid-cols-2 gap-3 md:gap-4">
                  <button
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`h-20 md:h-24 flex flex-col items-center justify-center rounded-xl border border-slate-200 transition-all active:scale-95 ${
                      isRecording
                        ? 'bg-red-500/10 border-red-500/50 text-red-500'
                        : 'bg-white hover:bg-slate-50 text-slate-600'
                    }`}
                  >
                    {isRecording ? <Square size={22} className="animate-pulse" /> : <Mic size={22} />}
                    <span className="text-[10px] uppercase font-bold mt-2 tracking-widest">
                      {isRecording ? t('stop') : 'MIC'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudioBlob(null)}
                    className="h-20 md:h-24 flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-all active:scale-95"
                  >
                    <span className="text-[10px] uppercase font-bold mt-2 tracking-widest">CLEAR AUDIO</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 flex flex-col min-h-0 lg:max-h-[calc(100dvh-10rem)] shadow-sm">
          <div className="shrink-0 p-3 md:p-4 border-b border-slate-200 flex justify-between items-center bg-white/70 gap-2">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 shrink-0">
              <div className={`w-2 h-2 rounded-full ${output ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-slate-300'}`}></div>
              Output
            </h3>
            {outputModelLabel && (
              <span className="text-[10px] bg-white px-2 py-0.5 rounded text-slate-700 border border-slate-200 font-mono max-w-[55vw] md:max-w-[420px] truncate">
                {outputModelLabel}
              </span>
            )}
          </div>

          <div className="flex-1 min-h-0 p-4 md:p-6 bg-slate-50 overflow-y-auto font-mono text-sm leading-relaxed text-slate-800 space-y-4 md:space-y-6 min-h-[200px]">
            <>
                {metrics && (
                  <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500 border border-slate-200 bg-white rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span>LATENCY: {metrics.latency_ms}ms</span>
                    {typeof metrics.ttft_ms === 'number' && <span>TTFT: {metrics.ttft_ms}ms</span>}
                    {typeof metrics.total_tokens === 'number' && <span>TOKENS: {metrics.total_tokens}</span>}
                    {typeof metrics.tps === 'number' && <span>TPS: {metrics.tps.toFixed(2)}</span>}
                  </div>
                )}
                {isLoading && stream && (
                  <div className="flex items-center gap-2 text-xs text-indigo-600 font-sans">
                    <Loader2 className="animate-spin" size={14} />
                    Streaming...
                  </div>
                )}
                {isLoading && !stream && (
                  <div className="flex items-center gap-2 text-xs text-indigo-600 font-sans">
                    <Loader2 className="animate-spin" size={14} />
                    Running pipeline...
                  </div>
                )}
                {steps.length > 0 && (
                  <div className="space-y-3">
                    {steps.map((s, idx) => (
                      <div key={idx} className="border border-slate-200 rounded-lg bg-white">
                        <div className="px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-slate-500 border-b border-slate-200">
                          {s.title}
                        </div>
                        <div className="p-4 whitespace-pre-wrap break-words text-slate-800">{s.content}</div>
                      </div>
                    ))}
                  </div>
                )}

                {omniAudioUrl && (
                  <audio className="w-full" controls src={omniAudioUrl} />
                )}
                {output ? (
                  <div className="whitespace-pre-wrap break-words">{output}</div>
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-500 italic border-2 border-dashed border-slate-200 rounded-xl">
                    Ready to test agent behavior
                  </div>
                )}
              </>
          </div>
        </div>
      </div>
    </div>
  );
}

