import './env';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import db from './db';
import { decryptSecret, encryptSecret } from './crypto';

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage() });

function fileToDataUrl(file: { buffer: Buffer; mimetype?: string }): string {
  const mime = file.mimetype || 'application/octet-stream';
  const b64 = file.buffer.toString('base64');
  return `data:${mime};base64,${b64}`;
}

function isDashScopeCompatible(endpoint: string): boolean {
  return endpoint.includes('dashscope.aliyuncs.com') || endpoint.includes('dashscope-intl.aliyuncs.com');
}

function normalizeEndpointForRequest(endpoint: string, kind: 'chat' | 'asr'): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return trimmed;

  // DashScope OpenAI compatible base URL often provided without the final path.
  // For both chat and audio-understanding models used here, we call /chat/completions.
  if (isDashScopeCompatible(trimmed) && trimmed.endsWith('/compatible-mode/v1')) {
    return `${trimmed}/chat/completions`;
  }

  return trimmed;
}

function isHuggingFaceInference(endpoint: string): boolean {
  return (
    endpoint.includes('api-inference.huggingface.co/models/') ||
    endpoint.includes('router.huggingface.co/hf-inference/models/')
  );
}

type CallMetrics = {
  latency_ms: number;
  ttft_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  tps?: number;
};

function buildMetrics(startMs: number, usage: any): CallMetrics {
  const latency_ms = Math.max(0, Date.now() - startMs);
  const prompt_tokens = usage?.prompt_tokens ?? usage?.input_tokens;
  const completion_tokens = usage?.completion_tokens ?? usage?.output_tokens;
  const total_tokens = usage?.total_tokens ?? (typeof prompt_tokens === 'number' && typeof completion_tokens === 'number' ? prompt_tokens + completion_tokens : undefined);
  const tps =
    typeof completion_tokens === 'number' && latency_ms > 0 ? completion_tokens / (latency_ms / 1000) : undefined;
  return {
    latency_ms,
    ttft_ms: latency_ms, // non-streaming approximation
    prompt_tokens: typeof prompt_tokens === 'number' ? prompt_tokens : undefined,
    completion_tokens: typeof completion_tokens === 'number' ? completion_tokens : undefined,
    total_tokens: typeof total_tokens === 'number' ? total_tokens : undefined,
    tps,
  };
}

function isDashScopeNative(endpoint: string): boolean {
  return endpoint.includes('/api/v1/services/aigc/');
}

function dashScopeApiKeyHeaders(apiKey: string): Record<string, string> {
  // DashScope native HTTP API uses ApiKeyAuth. In practice, Bearer works for compatible-mode;
  // for native, prefer "Authorization: Bearer" to keep one path.
  return { Authorization: `Bearer ${apiKey}` };
}

async function callLlm(model: any, inputText: string, prompt?: string, file?: { buffer: Buffer; mimetype?: string; originalname?: string }): Promise<{ output: string; metrics: CallMetrics }> {
  const enableThinking = (model as any)?._enable_thinking === true;
  const apiKey = decryptSecret(model.api_key || '');
  if (!apiKey) throw new Error('Model API key not configured');

  const endpoint: string = normalizeEndpointForRequest(model.endpoint, 'chat');
  const headers: Record<string, string> = isDashScopeNative(endpoint) ? dashScopeApiKeyHeaders(apiKey) : { Authorization: `Bearer ${apiKey}` };
  let body: any;

  const userText = inputText ?? '';
  const sys = (prompt ?? '').trim();

  const startMs = Date.now();

  if (isDashScopeNative(endpoint)) {
    headers['Content-Type'] = 'application/json';
    const content: any[] = [];
    if (userText) content.push({ text: userText });
    if (file) {
      // Best-effort: DashScope multimodal content supports image; audio support varies by model.
      // Use data URL to align with compatible-mode audio encoding expectations.
      content.push({ audio: fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype }) });
    }

    const messages: any[] = [];
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: content.length ? content : userText });

    const payload: any = {
      model: model.name,
      input: { messages },
      parameters: { result_format: 'message' },
    };
    // Some reasoning-capable models require explicit thinking switch.
    payload.parameters.enable_thinking = enableThinking;

    body = JSON.stringify(payload);
    const resp = await fetch(endpoint, { method: 'POST', headers, body });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
    const data = raw ? JSON.parse(raw) : {};
    const out =
      data?.output?.choices?.[0]?.message?.content ??
      data?.output?.text ??
      data?.output_text ??
      data?.text ??
      JSON.stringify(data);
    return { output: out, metrics: buildMetrics(startMs, data?.usage) };
  }

  if (endpoint.includes('/chat/completions')) {
    headers['Content-Type'] = 'application/json';
    const messages: any[] = [];
    if (sys) messages.push({ role: 'system', content: sys });
    if (file) {
      const dataUrl = fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype });
      messages.push({
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: dataUrl } },
          ...(userText ? [{ type: 'text', text: userText }] : []),
        ],
      });
    } else {
      messages.push({ role: 'user', content: userText });
    }
    const payload: any = { model: model.name, messages };
    // Huawei ModelArts MaaS DeepSeek: disable "thinking" (reasoning content) by default.
    if (endpoint.includes('modelarts-maas.com')) {
      payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: enableThinking };
    }
    // DashScope compatible-mode: set enable_thinking explicitly (required for non-streaming).
    if (isDashScopeCompatible(endpoint)) {
      payload.enable_thinking = enableThinking;
    }
    body = JSON.stringify(payload);
  } else if (endpoint.includes('/responses')) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      model: model.name,
      input: sys ? `${sys}\n\n${userText}` : userText,
    });
  } else {
    headers['Content-Type'] = 'application/json';
    const payload: any = { model: model.name, input: sys ? `${sys}\n\n${userText}` : userText };
    if (endpoint.includes('modelarts-maas.com')) {
      payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: enableThinking };
    }
    if (isDashScopeCompatible(endpoint)) {
      payload.enable_thinking = enableThinking;
    }
    body = JSON.stringify(payload);
  }

  const resp = await fetch(endpoint, { method: 'POST', headers, body });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
  const data = raw ? JSON.parse(raw) : {};
  const out = (
    data?.output_text ??
    data?.text ??
    data?.output ??
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data)
  );
  return { output: out, metrics: buildMetrics(startMs, data?.usage) };
}

async function callAsr(model: any, file: { buffer: Buffer; mimetype?: string; originalname?: string }): Promise<{ output: string; metrics: CallMetrics }> {
  const apiKey = decryptSecret(model.api_key || '');
  if (!apiKey) throw new Error('Model API key not configured');

  const endpoint: string = normalizeEndpointForRequest(model.endpoint, 'asr');
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };

  const startMs = Date.now();
  let resp: Response;
  if (isHuggingFaceInference(endpoint)) {
    headers['Content-Type'] = file.mimetype || 'application/octet-stream';
    resp = await fetch(endpoint, { method: 'POST', headers, body: file.buffer as any });
  } else if (isDashScopeCompatible(endpoint) && endpoint.includes('/chat/completions')) {
    headers['Content-Type'] = 'application/json';
    const dataUrl = fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype });
    const body = JSON.stringify({
      model: model.name,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
        },
      ],
    });
    resp = await fetch(endpoint, { method: 'POST', headers, body });
  } else {
    const fd = new FormData();
    const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
    fd.append('file', blob, file.originalname || 'audio');
    fd.append('model', model.name || 'whisper-1');
    resp = await fetch(endpoint, { method: 'POST', headers, body: fd as any });
  }

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
  const data = raw ? JSON.parse(raw) : {};
  const out = (
    data?.text ??
    data?.[0]?.generated_text ??
    data?.output_text ??
    data?.output ??
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data)
  );
  return { output: out, metrics: buildMetrics(startMs, data?.usage) };
}

// Auth Middleware
const authenticate = (req: any, res: any, next: any) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const isAdmin = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
};

// API Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user: any = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
  });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
  });
  res.json({ success: true });
});

app.get('/api/me', authenticate, (req: any, res) => {
  res.json({ user: req.user });
});

// Models
app.get('/api/models', authenticate, (req: any, res) => {
  // Hide API keys for users
  const models = db.prepare('SELECT id, name, type, endpoint FROM models').all();
  res.json(models);
});

app.post('/api/models', authenticate, isAdmin, (req, res) => {
  const { name, type, endpoint, api_key } = req.body;
  if (!name || !type || !endpoint || !api_key) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const storedKey = encryptSecret(api_key);
  db.prepare('INSERT INTO models (name, type, endpoint, api_key) VALUES (?, ?, ?, ?)')
    .run(name, type, endpoint, storedKey);
  res.json({ success: true });
});

app.put('/api/models/:id', authenticate, isAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, type, endpoint, api_key } = req.body ?? {};
  if (!id || !name || !type || !endpoint) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const existing: any = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Model not found' });

  // If api_key omitted or empty string, keep existing key.
  const nextKey =
    typeof api_key === 'string' && api_key.trim().length > 0 ? encryptSecret(api_key.trim()) : existing.api_key;

  db.prepare('UPDATE models SET name = ?, type = ?, endpoint = ?, api_key = ? WHERE id = ?').run(
    name,
    type,
    endpoint,
    nextKey,
    id
  );
  res.json({ success: true });
});

app.delete('/api/models/:id', authenticate, isAdmin, (req, res) => {
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Test Execution
app.post('/api/test', authenticate, upload.single('audio'), async (req: any, res) => {
  const { model_id, input_text, enable_thinking, stream } = req.body;
  const user_id = req.user.id;

  const model: any = db.prepare('SELECT * FROM models WHERE id = ?').get(model_id);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  model._enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';
  model._stream = String(stream ?? '').toLowerCase() === 'true';

  let output = '';
  let metrics: CallMetrics | null = null;
  let input_save = input_text || 'Audio File';

  try {
    if (model.type === 'LLM') {
      const r = await callLlm(model, input_text ?? '');
      output = r.output;
      metrics = r.metrics;
    } else if (model.type === 'ASR') {
      const file = req.file;
      if (!file) throw new Error('Audio file required');
      const r = await callAsr(model, file);
      output = r.output;
      metrics = r.metrics;
    }

    // Save to history
    db.prepare('INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)')
      .run(user_id, model_id, input_save, output, model.type);

    // Return latest-call metrics (best effort). For now, approximate TTFT for non-streaming.
    // (Call-specific metrics are computed inside callLlm/callAsr; we attach the last computed one.)
    res.json({ output, metrics });
  } catch (error: any) {
    console.error('Test Error:', error);
    res.status(500).json({ error: error.message || 'Model execution failed' });
  }
});

function sseWrite(res: any, event: string, data: string) {
  res.write(`event: ${event}\n`);
  for (const line of data.split('\n')) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

function extractOpenAiDelta(obj: any): string {
  return (
    obj?.choices?.[0]?.delta?.content ??
    obj?.choices?.[0]?.delta?.text ??
    obj?.choices?.[0]?.message?.content ??
    obj?.output_text ??
    obj?.text ??
    ''
  );
}

async function proxySseToText(
  upstream: Response,
  onDelta: (delta: string) => void,
  onDone: () => void
) {
  if (!upstream.body) return onDone();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
      const lines = frame.split('\n').map((l) => l.trimEnd());
      // IMPORTANT: preserve leading spaces in SSE data payload (token deltas can start with space).
      const dataLines = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => (l.startsWith('data: ') ? l.slice(6) : l.slice(5)));
      const data = dataLines.join('\n').trim();
      if (!data) continue;
      if (data === '[DONE]') {
        onDone();
        return;
      }
      try {
        const obj = JSON.parse(data);
        const delta = extractOpenAiDelta(obj);
        if (delta) onDelta(delta);
      } catch {
        // ignore parse errors
      }
    }
  }
  onDone();
}

// Streaming test (SSE)
app.post('/api/test/stream', authenticate, upload.single('audio'), async (req: any, res) => {
  const { model_id, input_text, enable_thinking } = req.body;
  const model: any = db.prepare('SELECT * FROM models WHERE id = ?').get(model_id);
  if (!model) return res.status(404).send('Model not found');

  const isOmniFlash = model.name === 'qwen3-omni-flash';
  const enableThinking = String(enable_thinking ?? '').toLowerCase() === 'true';
  model._enable_thinking = enableThinking;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const startMs = Date.now();
  let firstDeltaMs: number | null = null;

  try {
    const apiKey = decryptSecret(model.api_key || '');
    if (!apiKey) throw new Error('Model API key not configured');
    const endpoint = normalizeEndpointForRequest(model.endpoint, 'chat');
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    let upstreamPayload: any;

    if (model.type === 'LLM') {
      upstreamPayload = {
        model: model.name,
        messages: [{ role: 'user', content: input_text ?? '' }],
        stream: true,
      };
      if (isDashScopeCompatible(endpoint)) {
        upstreamPayload.enable_thinking = enableThinking;
      }
      if (endpoint.includes('modelarts-maas.com')) {
        upstreamPayload.chat_template_kwargs = {
          ...(upstreamPayload.chat_template_kwargs || {}),
          enable_thinking: enableThinking,
        };
      }
    } else {
      const file = req.file;
      if (!file) throw new Error('Audio file required');
      const dataUrl = fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype });
      upstreamPayload = {
        model: model.name,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] }],
        stream: true,
      };
      if (isDashScopeCompatible(endpoint)) {
        upstreamPayload.enable_thinking = enableThinking;
      }
      if (endpoint.includes('modelarts-maas.com')) {
        upstreamPayload.chat_template_kwargs = {
          ...(upstreamPayload.chat_template_kwargs || {}),
          enable_thinking: enableThinking,
        };
      }
    }

    // Some omni models only support streaming; enforce it here.
    if (isOmniFlash) upstreamPayload.stream = true;

    const upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(upstreamPayload) });
    if (!upstream.ok) {
      const raw = await upstream.text();
      sseWrite(res, 'error', raw || `Upstream error (${upstream.status})`);
      res.end();
      return;
    }

    let full = '';
    await proxySseToText(
      upstream,
      (delta) => {
        if (firstDeltaMs === null) firstDeltaMs = Date.now();
        full += delta;
        sseWrite(res, 'delta', delta);
      },
      () => {}
    );

    const metrics = {
      latency_ms: Math.max(0, Date.now() - startMs),
      ttft_ms: firstDeltaMs ? Math.max(0, firstDeltaMs - startMs) : null,
    };
    sseWrite(res, 'metrics', JSON.stringify(metrics));
    sseWrite(res, 'done', '');
    res.end();
  } catch (e: any) {
    sseWrite(res, 'error', e?.message || 'Stream failed');
    res.end();
  }
});

// Agent Playground
app.post('/api/agent/run', authenticate, upload.single('audio'), async (req: any, res) => {
  const { pipeline, prompt, input_text, llm_model_id, asr_model_id, omni_model_id, enable_thinking, stream } = req.body ?? {};
  const user_id = req.user.id;

  const steps: Array<{ title: string; content: string }> = [];
  let metrics: CallMetrics | null = null;

  try {
    if (pipeline === 'llm') {
      const llm: any = db.prepare('SELECT * FROM models WHERE id = ?').get(llm_model_id);
      if (!llm) return res.status(404).json({ error: 'LLM model not found' });
      llm._enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';
      const r = await callLlm(llm, input_text ?? '', prompt);
      const out = r.output;
      metrics = r.metrics;
      steps.push({ title: 'LLM Input', content: input_text ?? '' });
      steps.push({ title: 'LLM Output', content: out });
      return res.json({ output: out, steps, metrics });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Audio file required' });

    if (pipeline === 'asr_llm') {
      const asr: any = db.prepare('SELECT * FROM models WHERE id = ?').get(asr_model_id);
      const llm: any = db.prepare('SELECT * FROM models WHERE id = ?').get(llm_model_id);
      if (!asr) return res.status(404).json({ error: 'ASR model not found' });
      if (!llm) return res.status(404).json({ error: 'LLM model not found' });
      llm._enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';

      const asrR = await callAsr(asr, file);
      const transcript = asrR.output;
      steps.push({ title: 'ASR Transcript', content: transcript });

      const llmR = await callLlm(llm, transcript, prompt);
      const out = llmR.output;
      metrics = llmR.metrics;
      steps.push({ title: 'LLM Output', content: out });

      // Save history as a single record (LLM-type)
      db.prepare('INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)').run(
        user_id,
        llm.id,
        `ASR(${asr.name}) -> LLM(${llm.name})\n\n${transcript}`,
        out,
        'LLM'
      );

      return res.json({ output: out, steps, metrics });
    }

    if (pipeline === 'omni') {
      const omni: any = db.prepare('SELECT * FROM models WHERE id = ?').get(omni_model_id);
      if (!omni) return res.status(404).json({ error: 'OMNI model not found' });

      const r = await callAsr(omni, file);
      const out = r.output;
      metrics = r.metrics;
      steps.push({ title: 'OMNI Output', content: out });

      db.prepare('INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)').run(
        user_id,
        omni.id,
        'Agent OMNI audio input',
        out,
        'ASR'
      );

      return res.json({ output: out, steps, metrics });
    }

    return res.status(400).json({ error: 'Unknown pipeline' });
  } catch (error: any) {
    console.error('Agent Run Error:', error);
    return res.status(500).json({ error: error.message || 'Agent run failed' });
  }
});

// Agent Playground (streaming output for the final LLM/OMNI step)
app.post('/api/agent/run/stream', authenticate, upload.single('audio'), async (req: any, res) => {
  const { pipeline, prompt, input_text, llm_model_id, asr_model_id, omni_model_id, enable_thinking } = req.body ?? {};

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const startMs = Date.now();
  let firstDeltaMs: number | null = null;

  try {
    const steps: Array<{ title: string; content: string }> = [];

    if (pipeline === 'llm') {
      const llm: any = db.prepare('SELECT * FROM models WHERE id = ?').get(llm_model_id);
      if (!llm) {
        sseWrite(res, 'error', 'LLM model not found');
        return res.end();
      }

      const apiKey = decryptSecret(llm.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(llm.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const payload: any = {
        model: llm.name,
        messages: [
          ...(prompt ? [{ role: 'system', content: prompt }] : []),
          { role: 'user', content: input_text ?? '' },
        ],
        stream: true,
      };
      if (isDashScopeCompatible(endpoint)) payload.enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';
      if (endpoint.includes('modelarts-maas.com')) {
        payload.chat_template_kwargs = {
          ...(payload.chat_template_kwargs || {}),
          enable_thinking: String(enable_thinking ?? '').toLowerCase() === 'true',
        };
      }

      const upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!upstream.ok) {
        sseWrite(res, 'error', await upstream.text());
        return res.end();
      }

      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          sseWrite(res, 'delta', delta);
        },
        () => {}
      );

      sseWrite(res, 'steps', JSON.stringify(steps));
      sseWrite(
        res,
        'metrics',
        JSON.stringify({
          latency_ms: Math.max(0, Date.now() - startMs),
          ttft_ms: firstDeltaMs ? Math.max(0, firstDeltaMs - startMs) : null,
        })
      );
      sseWrite(res, 'done', '');
      return res.end();
    }

    const file = req.file;
    if (!file) throw new Error('Audio file required');

    if (pipeline === 'asr_llm') {
      const asr: any = db.prepare('SELECT * FROM models WHERE id = ?').get(asr_model_id);
      const llm: any = db.prepare('SELECT * FROM models WHERE id = ?').get(llm_model_id);
      if (!asr) throw new Error('ASR model not found');
      if (!llm) throw new Error('LLM model not found');

      const asrR = await callAsr(asr, file);
      steps.push({ title: 'ASR Transcript', content: asrR.output });

      // Stream the LLM final answer
      const apiKey = decryptSecret(llm.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(llm.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const payload: any = {
        model: llm.name,
        messages: [
          ...(prompt ? [{ role: 'system', content: prompt }] : []),
          { role: 'user', content: asrR.output },
        ],
        stream: true,
      };
      if (isDashScopeCompatible(endpoint)) payload.enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';
      if (endpoint.includes('modelarts-maas.com')) {
        payload.chat_template_kwargs = {
          ...(payload.chat_template_kwargs || {}),
          enable_thinking: String(enable_thinking ?? '').toLowerCase() === 'true',
        };
      }

      const upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!upstream.ok) {
        sseWrite(res, 'error', await upstream.text());
        return res.end();
      }

      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          sseWrite(res, 'delta', delta);
        },
        () => {}
      );

      sseWrite(res, 'steps', JSON.stringify(steps));
      sseWrite(
        res,
        'metrics',
        JSON.stringify({
          latency_ms: Math.max(0, Date.now() - startMs),
          ttft_ms: firstDeltaMs ? Math.max(0, firstDeltaMs - startMs) : null,
        })
      );
      sseWrite(res, 'done', '');
      return res.end();
    }

    if (pipeline === 'omni') {
      const omni: any = db.prepare('SELECT * FROM models WHERE id = ?').get(omni_model_id);
      if (!omni) throw new Error('OMNI model not found');

      // Stream omni output via /api/test/stream-like logic
      const apiKey = decryptSecret(omni.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(omni.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const dataUrl = fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype });
      const payload: any = {
        model: omni.name,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] }],
        stream: true,
      };
      if (isDashScopeCompatible(endpoint)) payload.enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';
      if (endpoint.includes('modelarts-maas.com')) {
        payload.chat_template_kwargs = {
          ...(payload.chat_template_kwargs || {}),
          enable_thinking: String(enable_thinking ?? '').toLowerCase() === 'true',
        };
      }

      const upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!upstream.ok) {
        sseWrite(res, 'error', await upstream.text());
        return res.end();
      }

      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          sseWrite(res, 'delta', delta);
        },
        () => {}
      );

      sseWrite(res, 'steps', JSON.stringify(steps));
      sseWrite(
        res,
        'metrics',
        JSON.stringify({
          latency_ms: Math.max(0, Date.now() - startMs),
          ttft_ms: firstDeltaMs ? Math.max(0, firstDeltaMs - startMs) : null,
        })
      );
      sseWrite(res, 'done', '');
      return res.end();
    }

    sseWrite(res, 'error', 'Unknown pipeline');
    res.end();
  } catch (e: any) {
    sseWrite(res, 'error', e?.message || 'Stream failed');
    res.end();
  }
});

// History
app.get('/api/history', authenticate, (req: any, res) => {
  let history;
  if (req.user.role === 'admin') {
    history = db.prepare(`
      SELECT h.*, u.username, m.name as model_name 
      FROM history h 
      JOIN users u ON h.user_id = u.id 
      JOIN models m ON h.model_id = m.id 
      ORDER BY h.timestamp DESC
    `).all();
  } else {
    history = db.prepare(`
      SELECT h.*, u.username, m.name as model_name 
      FROM history h 
      JOIN users u ON h.user_id = u.id 
      JOIN models m ON h.model_id = m.id 
      WHERE h.user_id = ? 
      ORDER BY h.timestamp DESC
    `).all(req.user.id);
  }
  res.json(history);
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
