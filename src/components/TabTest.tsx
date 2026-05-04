import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../context/I18nContext';
import { Send, Upload, Mic, Square, Loader2, FileAudio } from 'lucide-react';
import { PcmStreamPlayer, base64PcmToWavBlob, pickUploadFilename } from '../utils/audio';

export default function TabTest() {
  const { t } = useI18n();
  const [models, setModels] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [inputText, setInputText] = useState('');
  const [enableThinking, setEnableThinking] = useState(false);
  const [stream, setStream] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [output, setOutput] = useState('');
  const [metrics, setMetrics] = useState<any | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [omniVoice, setOmniVoice] = useState(false);
  const [omniAudioUrl, setOmniAudioUrl] = useState<string>('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioPlayerRef = useRef<PcmStreamPlayer | null>(null);

  useEffect(() => {
    return () => {
      audioPlayerRef.current?.stop();
      audioPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    fetch('/api/models').then(res => res.json()).then(setModels);
  }, []);

  const handleExecute = async () => {
    if (!selectedModel) return;
    setIsLoading(true);
    setOutput('');
    setMetrics(null);
    if (omniAudioUrl) URL.revokeObjectURL(omniAudioUrl);
    setOmniAudioUrl('');

    const model = models.find(m => m.id === parseInt(selectedModel));
    const isOmniFlashSelected = model?.name === 'qwen3-omni-flash';
    const formData = new FormData();
      formData.append('model_id', selectedModel);
    const isWhisperSelected = model?.name === 'whisper-large-v3';
    const effectiveStream = isWhisperSelected ? false : (isOmniFlashSelected ? true : stream);
    const effectiveThinking = enableThinking && effectiveStream;
    formData.append('enable_thinking', String(effectiveThinking));
    formData.append('stream', String(effectiveStream));
    if (model?.type === 'OMNI') {
      formData.append('omni_voice', String(omniVoice && effectiveStream));
    }

    if (model.type === 'LLM') {
      formData.append('input_text', inputText);
    } else {
      if (model.type === 'OMNI') {
        formData.append('input_text', inputText);
        // OMNI now accepts text-only input (great for chatbot voice replies),
        // an uploaded media file, or both. Only require something to send.
        if (!audioBlob && !inputText.trim()) {
          setIsLoading(false);
          return alert('Please provide text or upload media (audio / image / video)');
        }
      } else {
        if (!audioBlob) {
          setIsLoading(false);
          return alert('Please provide audio');
        }
      }
      if (audioBlob) {
        const field = model.type === 'OMNI' ? 'media' : 'audio';
        formData.append(field, audioBlob, pickUploadFilename(audioBlob, 'recording'));
      }
    }

    try {
      if (!effectiveStream) {
        const res = await fetch('/api/test', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
          setOutput(data.output);
          setMetrics(data.metrics || null);
        } else {
          setOutput(`Error: ${data.error}`);
        }
      } else {
        const startedAt = performance.now();
        let firstTokenAt: number | null = null;
        let audioB64 = '';

        // Spin up a live PCM player synchronously inside this user-gesture click
        // handler so Safari/Chrome let the AudioContext start without unlocking.
        const wantsLivePlayback = model?.type === 'OMNI' && omniVoice;
        if (wantsLivePlayback) {
          audioPlayerRef.current?.stop();
          const player = new PcmStreamPlayer(24000, 1);
          player.start();
          audioPlayerRef.current = player;
        }

        const res = await fetch('/api/test/stream', { method: 'POST', body: formData });
        if (!res.ok || !res.body) {
          const text = await res.text();
          setOutput(`Error: ${text || res.statusText}`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let full = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE frames separated by blank line (\n\n or \r\n\r\n).
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
            // IMPORTANT: do NOT trim leading spaces; deltas may start with a space token.
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
              try {
                setMetrics(JSON.parse(data));
              } catch {
                // ignore
              }
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
    } catch (err) {
      alert('Microphone access denied');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() || '' : '';
    const model = models.find(m => m.id === parseInt(selectedModel));
    if (model?.type === 'ASR' && model?.name === 'qwen3-asr-flash') {
      const allowed = new Set(['aac','amr','avi','aiff','flac','flv','mkv','mp3','mpeg','mpg','ogg','opus','wav','webm','wma','wmv','m4a','mp4','mov']);
      if (!allowed.has(ext)) return alert(`Unsupported file type .${ext || '(none)'} for qwen3-asr-flash`);
    }
    setAudioBlob(file);
  };

  const activeModel = models.find(m => m.id === parseInt(selectedModel));
  const isOmniFlash = activeModel?.name === 'qwen3-omni-flash';
  const isWhisper = activeModel?.name === 'whisper-large-v3';
  const streamRequired = isOmniFlash;
  const effectiveStream = isWhisper ? false : (streamRequired ? true : stream);
  const thinkingEnabled = enableThinking && effectiveStream;

  return (
    <div className="grid grid-rows-[auto,1fr] gap-6 h-full">
      {/* Configuration Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-8">
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              {t('selectModel')}
            </label>
            <select 
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="min-w-[280px] bg-white border border-slate-200 text-slate-900 text-sm rounded-lg px-4 py-2 outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
            >
              <option value="">-- {t('selectModel')} --</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.type})</option>
              ))}
            </select>
          </div>
          
          <div className="hidden md:block w-[1px] h-10 bg-slate-200"></div>

          {activeModel && (
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Type</label>
              <div className="flex gap-2">
                 <span className={`px-4 py-1 rounded-lg text-xs font-semibold ${
                   activeModel.type === 'LLM' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 border border-slate-200'
                 }`}>
                   {activeModel.type}
                 </span>
              </div>
            </div>
          )}

          {activeModel && (
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Options</label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 select-none">
                  <input
                    type="checkbox"
                    checked={effectiveStream}
                    onChange={(e) => setStream(e.target.checked)}
                    disabled={streamRequired || isWhisper}
                    className="accent-indigo-600"
                  />
                  Streaming {isWhisper ? '(not supported)' : streamRequired ? '(required)' : ''}
                </label>
                <label className={`flex items-center gap-2 text-xs select-none ${effectiveStream ? 'text-slate-700' : 'text-slate-400'}`}>
                  <input
                    type="checkbox"
                    checked={thinkingEnabled}
                    onChange={(e) => setEnableThinking(e.target.checked)}
                    disabled={!effectiveStream || activeModel.type !== 'LLM'}
                    className="accent-indigo-600"
                  />
                  Thinking {activeModel.type !== 'LLM' ? '(LLM only)' : effectiveStream ? '' : '(streaming only)'}
                </label>
                {activeModel.type === 'OMNI' && (
                  <label className={`flex items-center gap-2 text-xs select-none ${effectiveStream ? 'text-slate-700' : 'text-slate-400'}`}>
                    <input
                      type="checkbox"
                      checked={omniVoice && effectiveStream}
                      onChange={(e) => setOmniVoice(e.target.checked)}
                      disabled={!effectiveStream}
                      className="accent-indigo-600"
                    />
                    Voice reply {effectiveStream ? '' : '(streaming only)'}
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleExecute}
          disabled={isLoading || !selectedModel}
          className="h-10 px-8 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-200 disabled:text-slate-500 text-white font-bold text-xs rounded-lg shadow-sm flex items-center gap-2 transition-all active:scale-95"
        >
          {isLoading ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
          {t('execute').toUpperCase()}
        </button>
      </div>

      {/* Main Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0 pb-6">
        {/* Input Area */}
        <div className="bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-white/70">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
              {t('inputText')}
            </h3>
            {activeModel?.type === 'LLM' && (
              <span className="text-[10px] text-slate-500 font-mono">CHARS: {inputText.length}</span>
            )}
          </div>
          
          <div className="flex-1 p-6 overflow-hidden">
            {activeModel?.type === 'LLM' ? (
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                className="w-full h-full bg-transparent resize-none outline-none text-sm text-slate-800 placeholder:text-slate-400 font-mono leading-relaxed px-0"
                placeholder="Enter model instructions or prompt context here..."
              />
            ) : (activeModel?.type === 'ASR' || activeModel?.type === 'OMNI') ? (
              <div className="h-full flex flex-col gap-6">
                 <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 group hover:border-indigo-300 transition-colors relative">
                    <input
                      type="file"
                    accept={activeModel?.type === 'OMNI' ? 'audio/*,image/*,video/*' : 'audio/*'}
                      onChange={handleFileUpload}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <Upload className="text-slate-500 group-hover:text-indigo-600 mb-2" size={32} />
                    <span className="text-sm font-medium text-slate-500">
                      {audioBlob
                        ? (audioBlob as any).name || 'Recorded audio'
                        : activeModel?.type === 'OMNI'
                          ? 'Optional: drop audio / image / video'
                          : 'Drop audio file here'}
                    </span>
                 </div>

                 {activeModel?.type === 'OMNI' && (
                   <div className="border border-slate-200 rounded-xl bg-white p-4">
                     <div className="flex items-center justify-between mb-2">
                       <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                         Text {audioBlob ? '(optional)' : '(or speak via mic / upload)'}
                       </span>
                       <span className="text-[10px] text-slate-500 font-mono">CHARS: {inputText.length}</span>
                     </div>
                     <textarea
                       value={inputText}
                       onChange={(e) => setInputText(e.target.value)}
                       className="w-full min-h-[90px] bg-transparent resize-none outline-none text-sm text-slate-800 placeholder:text-slate-400 font-mono leading-relaxed"
                       placeholder="Type a message — OMNI can answer in text or voice without any audio input..."
                     />
                   </div>
                 )}
                 
                 <button
                   onClick={isRecording ? stopRecording : startRecording}
                   className={`h-24 flex flex-col items-center justify-center rounded-xl border border-slate-200 transition-all ${
                     isRecording 
                       ? 'bg-red-500/10 border-red-500/50 text-red-500' 
                       : 'bg-white hover:bg-slate-50 text-slate-600'
                   }`}
                 >
                   {isRecording ? <Square size={24} className="animate-pulse" /> : <Mic size={24} />}
                   <span className="text-[10px] uppercase font-bold mt-2 tracking-widest">
                     {isRecording ? t('stop') : t('record')}
                   </span>
                 </button>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600 font-mono italic text-sm">
                Select a model to begin configuration...
              </div>
            )}
          </div>
        </div>

        {/* Output Area */}
        <div className="bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-white/70">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${output ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-slate-300'}`}></div>
              {t('output')}
            </h3>
            <div className="flex gap-2 items-center">
              {activeModel?.name && (
                <span className="text-[10px] bg-white px-2 py-0.5 rounded text-slate-700 border border-slate-200 font-mono max-w-[360px] truncate">
                  {activeModel.name}
                </span>
              )}
              {output && (
                <span className="text-[10px] bg-slate-100 px-2 py-0.5 rounded text-indigo-600 border border-slate-200">COMPLETED</span>
              )}
            </div>
          </div>
          
          <div className="flex-1 p-6 bg-slate-50 overflow-y-auto font-mono text-sm leading-relaxed text-slate-800">
            {output ? (
              <div className="space-y-4">
                {metrics && (
                  <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500 border border-slate-200 bg-white rounded-lg px-3 py-2">
                    <span className="mr-4">LATENCY: {metrics.latency_ms}ms</span>
                    {typeof metrics.ttft_ms === 'number' && <span className="mr-4">TTFT: {metrics.ttft_ms}ms</span>}
                    {typeof metrics.total_tokens === 'number' && <span className="mr-4">TOKENS: {metrics.total_tokens}</span>}
                    {typeof metrics.tps === 'number' && <span>TPS: {metrics.tps.toFixed(2)}</span>}
                  </div>
                )}
                {isLoading && effectiveStream && (
                  <div className="flex items-center gap-2 text-xs text-indigo-600 font-sans">
                    <Loader2 className="animate-spin" size={14} />
                    Streaming...
                  </div>
                )}
                {omniAudioUrl && (
                  <audio className="w-full" controls src={omniAudioUrl} />
                )}
                <div className="whitespace-pre-wrap">{output}</div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-500 italic border-2 border-dashed border-slate-200 rounded-xl">
                Ready for model evaluation
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
