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
const PORT = Number(process.env.PORT || 3000);
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

function getUploadedFile(req: any, fieldNames: string[]): { buffer: Buffer; mimetype?: string; originalname?: string } | null {
  if (req?.file) return req.file;
  const files: any[] = (req?.files as any[]) || [];
  if (!Array.isArray(files) || files.length === 0) return null;
  for (const name of fieldNames) {
    const f = files.find((x) => x?.fieldname === name);
    if (f) return f;
  }
  return files[0] || null;
}

function buildOmniUserContent(params: { file: { buffer: Buffer; mimetype?: string }; text?: string }) {
  const { file, text } = params;
  const mime = (file.mimetype || '').toLowerCase();
  const dataUrl = fileToDataUrl({ buffer: file.buffer, mimetype: file.mimetype });
  const parts: any[] = [];
  if (mime.startsWith('audio/')) {
    parts.push({ type: 'input_audio', input_audio: { data: dataUrl } });
  } else if (mime.startsWith('image/')) {
    parts.push({ type: 'image_url', image_url: { url: dataUrl } });
  } else if (mime.startsWith('video/')) {
    parts.push({ type: 'video_url', video_url: { url: dataUrl } });
  } else {
    // best effort: treat as binary via video_url (DashScope compatible accepts data URLs)
    parts.push({ type: 'video_url', video_url: { url: dataUrl } });
  }
  if (text && String(text).trim()) {
    parts.push({ type: 'text', text: String(text) });
  }
  return parts;
}

// Build the chat messages array for an OMNI call. Accepts text-only input (no
// file), audio/image/video file (with optional accompanying text), and an
// optional system prompt from the agent UI. When voice reply is on we
// additionally pin the spoken language to English so the chatbot voice output
// is consistent regardless of the input language.
function buildOmniMessages(params: {
  file?: { buffer: Buffer; mimetype?: string } | null;
  text?: string;
  systemPrompt?: string;
  voiceEnglish?: boolean;
}) {
  const { file, text, systemPrompt, voiceEnglish } = params;
  const messages: any[] = [];
  if (voiceEnglish) {
    messages.push({
      role: 'system',
      content:
        'Always respond in clear, natural conversational English. When you generate audio output, speak English regardless of the input language.',
    });
  }
  if (systemPrompt && String(systemPrompt).trim()) {
    messages.push({ role: 'system', content: String(systemPrompt) });
  }
  if (file) {
    messages.push({
      role: 'user',
      content: buildOmniUserContent({ file, text: text ?? '' }),
    });
  } else {
    messages.push({ role: 'user', content: String(text ?? '') });
  }
  return messages;
}

function extFromName(name?: string): string {
  const n = String(name || '').trim().toLowerCase();
  const i = n.lastIndexOf('.');
  if (i === -1) return '';
  return n.slice(i + 1);
}

function assertAllowedUpload(params: { model: any; file: { originalname?: string; mimetype?: string } }) {
  const { model, file } = params;
  const ext = extFromName(file.originalname);
  const mime = String(file.mimetype || '').toLowerCase();

  if (model?.type === 'ASR' && model?.name === 'qwen3-asr-flash') {
    const allowed = new Set([
      'aac','amr','avi','aiff','flac','flv','mkv','mp3','mpeg','mpg','ogg','opus','wav','webm','wma','wmv','m4a','mp4','mov'
    ]);
    if (!ext || !allowed.has(ext)) {
      throw new Error(`Unsupported file type .${ext || '(none)'} for qwen3-asr-flash`);
    }
    return;
  }

  if (model?.type === 'ASR' && model?.name === 'whisper-large-v3') {
    const allowed = new Set(['wav','mp3','webm','ogg','opus','flac','m4a','mp4']);
    if (!ext || !allowed.has(ext)) {
      throw new Error(`Unsupported file type .${ext || '(none)'} for whisper-large-v3`);
    }
    return;
  }

  if (model?.type === 'OMNI') {
    // Omni supports audio/image/video; enforce by mimetype first, ext as fallback.
    if (mime.startsWith('audio/') || mime.startsWith('image/') || mime.startsWith('video/')) return;
    const allowed = new Set([
      // audio
      'aac','amr','aiff','flac','mp3','mpeg','mpg','ogg','opus','wav','webm','wma','m4a','mp4',
      // image
      'jpg','jpeg','png','webp','gif','bmp','heic',
      // video
      'mp4','mov','mkv','avi','flv','wmv','webm','mpeg','mpg'
    ]);
    if (!ext || !allowed.has(ext)) {
      throw new Error(`Unsupported media type .${ext || '(none)'} for OMNI`);
    }
    return;
  }
}

function isDashScopeCompatible(endpoint: string): boolean {
  return endpoint.includes('dashscope.aliyuncs.com') || endpoint.includes('dashscope-intl.aliyuncs.com');
}

// DashScope Qwen-Omni audio output uses different default voices per model family.
// qwen3-omni-flash: Cherry (default), Ethan, Chelsie, Aiden, ...
// qwen-omni-turbo / qwen3.5-omni-*: Tina (default), Cherry, Ethan, ...
function pickOmniVoice(modelName: string): string {
  const n = String(modelName || '').toLowerCase();
  if (n.startsWith('qwen3-omni')) return 'Cherry';
  return 'Cherry';
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

function getAuthorizedModelById(user: any, modelId: any): any | null {
  const id = Number(modelId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (user?.role === 'admin') {
    return db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
  }
  return db
    .prepare(
      `
      SELECT m.*
      FROM models m
      JOIN user_models um ON um.model_id = m.id
      WHERE um.user_id = ? AND m.id = ?
      LIMIT 1
      `
    )
    .get(user?.id, id) as any;
}

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
  const isAdmin = req.user?.role === 'admin';
  const models = isAdmin
    ? db.prepare('SELECT id, name, type, endpoint FROM models').all()
    : db
        .prepare(
          `
          SELECT m.id, m.name, m.type, m.endpoint
          FROM models m
          JOIN user_models um ON um.model_id = m.id
          WHERE um.user_id = ?
          ORDER BY m.id ASC
          `
        )
        .all(req.user.id);
  res.json(models);
});

// Admin: manage customer accounts + model visibility
app.get('/api/admin/users', authenticate, isAdmin, (req: any, res) => {
  const users = db.prepare('SELECT id, username, role FROM users ORDER BY id ASC').all();
  res.json(users);
});

app.post('/api/admin/users', authenticate, isAdmin, (req: any, res) => {
  const { username, password, role } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username/password' });
  const nextRole = role === 'admin' ? 'admin' : 'user';
  const hash = bcrypt.hashSync(String(password), 10);
  try {
    const r = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(String(username), hash, nextRole);
    res.json({ id: r.lastInsertRowid, username, role: nextRole });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Failed to create user' });
  }
});

app.get('/api/admin/users/:id/models', authenticate, isAdmin, (req: any, res) => {
  const userId = Number(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });
  const rows = db.prepare('SELECT model_id FROM user_models WHERE user_id = ? ORDER BY model_id ASC').all(userId) as any[];
  res.json({ model_ids: rows.map((r) => r.model_id) });
});

app.put('/api/admin/users/:id/models', authenticate, isAdmin, (req: any, res) => {
  const userId = Number(req.params.id);
  const model_ids = (req.body?.model_ids ?? []) as any;
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });
  if (!Array.isArray(model_ids)) return res.status(400).json({ error: 'model_ids must be an array' });

  const normalized = Array.from(
    new Set(
      model_ids
        .map((x: any) => Number(x))
        .filter((n: number) => Number.isFinite(n) && n > 0)
    )
  );

  const del = db.prepare('DELETE FROM user_models WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_models (user_id, model_id) VALUES (?, ?)');
  const tx = db.transaction((ids: number[]) => {
    del.run(userId);
    for (const mid of ids) ins.run(userId, mid);
  });
  tx(normalized);
  res.json({ success: true, model_ids: normalized });
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
app.post('/api/test', authenticate, upload.any(), async (req: any, res) => {
  const { model_id, input_text, enable_thinking, stream } = req.body;
  const user_id = req.user.id;

  const model: any = getAuthorizedModelById(req.user, model_id);
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
      const file = getUploadedFile(req, ['audio', 'media']);
      if (!file) throw new Error('Audio file required');
      assertAllowedUpload({ model, file });
      const r = await callAsr(model, file);
      output = r.output;
      metrics = r.metrics;
      input_save = file.originalname || input_save;
    } else if (model.type === 'OMNI') {
      const file = getUploadedFile(req, ['media', 'audio']);
      if (!file && !String(input_text ?? '').trim()) {
        throw new Error('Provide text input or a media file (audio/image/video) for OMNI');
      }
      if (file) assertAllowedUpload({ model, file });

      const apiKey = decryptSecret(model.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(model.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

      const payload: any = {
        model: model.name,
        messages: buildOmniMessages({ file, text: input_text ?? '' }),
        stream: false,
      };
      if (isDashScopeCompatible(endpoint)) payload.enable_thinking = false;

      const startMs = Date.now();
      const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
      const data = raw ? JSON.parse(raw) : {};
      output =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        data?.output_text ??
        data?.text ??
        JSON.stringify(data);
      metrics = buildMetrics(startMs, data?.usage);
      input_save = file?.originalname || (input_text ? input_text : 'OMNI media');
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

function extractOpenAiAudioDelta(obj: any): string {
  const a = obj?.choices?.[0]?.delta?.audio;
  return a?.data ?? a?.["data"] ?? '';
}

async function proxySseToText(
  upstream: Response,
  onDelta: (delta: string) => void,
  onAudioDelta: ((audioBase64: string) => void) | null,
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
        const a = extractOpenAiAudioDelta(obj);
        if (a && onAudioDelta) onAudioDelta(a);
      } catch {
        // ignore parse errors
      }
    }
  }
  onDone();
}

// Streaming test (SSE)
app.post('/api/test/stream', authenticate, upload.any(), async (req: any, res) => {
  const { model_id, input_text, enable_thinking, omni_voice } = req.body;
  const user_id = req.user.id;
  const model: any = getAuthorizedModelById(req.user, model_id);
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
  let inputSave = input_text || (model.type === 'LLM' ? '' : 'Media File');

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
    } else if (model.type === 'ASR') {
      const file = getUploadedFile(req, ['audio', 'media']);
      if (!file) throw new Error('Audio file required');
      assertAllowedUpload({ model, file });
      inputSave = file.originalname || 'Audio File';
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
    } else if (model.type === 'OMNI') {
      const file = getUploadedFile(req, ['media', 'audio']);
      if (!file && !String(input_text ?? '').trim()) {
        throw new Error('Provide text input or a media file (audio/image/video) for OMNI');
      }
      if (file) assertAllowedUpload({ model, file });
      inputSave = file?.originalname || (input_text ? String(input_text) : 'OMNI media');
      const wantsVoice = String(omni_voice ?? '').toLowerCase() === 'true';
      upstreamPayload = {
        model: model.name,
        messages: buildOmniMessages({
          file,
          text: input_text ?? '',
          voiceEnglish: wantsVoice,
        }),
        stream: true,
        ...(wantsVoice
          ? {
              modalities: ['text', 'audio'],
              audio: { voice: pickOmniVoice(model.name), format: 'wav' },
              stream_options: { include_usage: true },
            }
          : {}),
      };
      if (isDashScopeCompatible(endpoint)) {
        upstreamPayload.enable_thinking = enableThinking;
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
      (audioB64) => {
        sseWrite(res, 'audio', audioB64);
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

    if (full) {
      try {
        db.prepare(
          'INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)'
        ).run(user_id, model.id, inputSave || '', full, model.type);
      } catch (err) {
        console.error('Failed to save streaming history:', err);
      }
    }
  } catch (e: any) {
    sseWrite(res, 'error', e?.message || 'Stream failed');
    res.end();
  }
});

// Agent Playground
app.post('/api/agent/run', authenticate, upload.any(), async (req: any, res) => {
  const { pipeline, prompt, input_text, llm_model_id, asr_model_id, omni_model_id, enable_thinking, stream } = req.body ?? {};
  const user_id = req.user.id;

  const steps: Array<{ title: string; content: string }> = [];
  let metrics: CallMetrics | null = null;

  try {
    if (pipeline === 'llm') {
      const llm: any = getAuthorizedModelById(req.user, llm_model_id);
      if (!llm) return res.status(404).json({ error: 'LLM model not found' });
      llm._enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';

      // If the user selected an OMNI model from the LLM dropdown, use the
      // OMNI chat path so optional audio input + optional voice reply work.
      if (llm.type === 'OMNI') {
        const file = getUploadedFile(req, ['media', 'audio']);
        if (file) assertAllowedUpload({ model: llm, file });
        if (!file && !String(input_text ?? '').trim()) {
          return res.status(400).json({ error: 'Provide text input or speak/upload audio for OMNI' });
        }

        const apiKey = decryptSecret(llm.api_key || '');
        if (!apiKey) throw new Error('Model API key not configured');
        const endpoint = normalizeEndpointForRequest(llm.endpoint, 'chat');
        const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        const payload: any = {
          model: llm.name,
          messages: buildOmniMessages({ file, text: input_text ?? '', systemPrompt: prompt }),
          stream: false,
        };
        if (isDashScopeCompatible(endpoint)) payload.enable_thinking = false;

        const startMs = Date.now();
        const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
        const raw = await resp.text();
        if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
        const data = raw ? JSON.parse(raw) : {};
        const out =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ??
          data?.output_text ??
          data?.text ??
          JSON.stringify(data);
        metrics = buildMetrics(startMs, data?.usage);
        steps.push({ title: 'LLM Input', content: file?.originalname ? `[audio] ${file.originalname}\n${input_text ?? ''}` : input_text ?? '' });
        steps.push({ title: 'LLM Output', content: out });

        try {
          db.prepare(
            'INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)'
          ).run(user_id, llm.id, file?.originalname || input_text || '', out, 'OMNI');
        } catch (err) {
          console.error('Failed to save agent llm-omni history:', err);
        }

        return res.json({ output: out, steps, metrics });
      }

      const r = await callLlm(llm, input_text ?? '', prompt);
      const out = r.output;
      metrics = r.metrics;
      steps.push({ title: 'LLM Input', content: input_text ?? '' });
      steps.push({ title: 'LLM Output', content: out });

      try {
        db.prepare(
          'INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)'
        ).run(user_id, llm.id, input_text ?? '', out, 'LLM');
      } catch (err) {
        console.error('Failed to save agent llm history:', err);
      }

      return res.json({ output: out, steps, metrics });
    }

    const file = getUploadedFile(req, ['audio', 'media']);
    if (pipeline === 'asr_llm' && !file) {
      return res.status(400).json({ error: 'Audio file required' });
    }
    if (pipeline === 'omni' && !file && !String(input_text ?? '').trim()) {
      return res.status(400).json({ error: 'Provide text input or a media file (audio/image/video) for OMNI' });
    }

    if (pipeline === 'asr_llm') {
      const asr: any = getAuthorizedModelById(req.user, asr_model_id);
      const llm: any = getAuthorizedModelById(req.user, llm_model_id);
      if (!asr) return res.status(404).json({ error: 'ASR model not found' });
      if (!llm) return res.status(404).json({ error: 'LLM model not found' });
      if (!file) return res.status(400).json({ error: 'Audio file required' });
      llm._enable_thinking = String(enable_thinking ?? '').toLowerCase() === 'true';

      assertAllowedUpload({ model: asr, file });
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
      const omni: any = getAuthorizedModelById(req.user, omni_model_id);
      if (!omni) return res.status(404).json({ error: 'OMNI model not found' });
      if (file) assertAllowedUpload({ model: omni, file });

      if (omni.type === 'OMNI') {
        const apiKey = decryptSecret(omni.api_key || '');
        if (!apiKey) throw new Error('Model API key not configured');
        const endpoint = normalizeEndpointForRequest(omni.endpoint, 'chat');
        const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        const startMs = Date.now();
        const payload: any = {
          model: omni.name,
          messages: buildOmniMessages({ file, text: input_text ?? '', systemPrompt: prompt }),
          stream: false,
        };
        if (isDashScopeCompatible(endpoint)) payload.enable_thinking = false;
        const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
        const raw = await resp.text();
        if (!resp.ok) throw new Error(`Upstream error (${resp.status}): ${raw.slice(0, 4000)}`);
        const data = raw ? JSON.parse(raw) : {};
        const out =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ??
          data?.output_text ??
          data?.text ??
          JSON.stringify(data);
        metrics = buildMetrics(startMs, data?.usage);
        steps.push({ title: 'OMNI Output', content: out });
        db.prepare('INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)').run(
          user_id,
          omni.id,
          file?.originalname || (input_text ? String(input_text) : 'Agent OMNI input'),
          out,
          'OMNI'
        );
        return res.json({ output: out, steps, metrics });
      }

      // Backward compatible: treat ASR-type omni-like models as audio understanding (still need file)
      if (!file) return res.status(400).json({ error: 'Audio file required for ASR-style omni' });
      const r = await callAsr(omni, file);
      const out = r.output;
      metrics = r.metrics;
      steps.push({ title: 'OMNI Output', content: out });

      db.prepare('INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)').run(
        user_id,
        omni.id,
        file.originalname || 'Agent OMNI audio input',
        out,
        omni.type
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
app.post('/api/agent/run/stream', authenticate, upload.any(), async (req: any, res) => {
  const { pipeline, prompt, input_text, llm_model_id, asr_model_id, omni_model_id, enable_thinking, omni_voice } = req.body ?? {};
  const user_id = req.user.id;
  const safeInsertHistory = (model_id: number, input: string, output: string, type: string) => {
    if (!output) return;
    try {
      db.prepare(
        'INSERT INTO history (user_id, model_id, input, output, type) VALUES (?, ?, ?, ?, ?)'
      ).run(user_id, model_id, input || '', output, type);
    } catch (err) {
      console.error('Failed to save agent stream history:', err);
    }
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const startMs = Date.now();
  let firstDeltaMs: number | null = null;

  try {
    const steps: Array<{ title: string; content: string }> = [];

    if (pipeline === 'llm') {
      const llm: any = getAuthorizedModelById(req.user, llm_model_id);
      if (!llm) {
        sseWrite(res, 'error', 'LLM model not found');
        return res.end();
      }

      const apiKey = decryptSecret(llm.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(llm.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

      // OMNI-in-LLM-pipeline branch: optional audio + optional voice reply.
      if (llm.type === 'OMNI') {
        const file = getUploadedFile(req, ['media', 'audio']);
        if (file) assertAllowedUpload({ model: llm, file });
        if (!file && !String(input_text ?? '').trim()) {
          sseWrite(res, 'error', 'Provide text input or speak/upload audio for OMNI');
          return res.end();
        }

        const wantsVoice = String(omni_voice ?? '').toLowerCase() === 'true';
        const omniPayload: any = {
          model: llm.name,
          messages: buildOmniMessages({
            file,
            text: input_text ?? '',
            systemPrompt: prompt,
            voiceEnglish: wantsVoice,
          }),
          stream: true,
          ...(wantsVoice
            ? {
                modalities: ['text', 'audio'],
                audio: { voice: pickOmniVoice(llm.name), format: 'wav' },
                stream_options: { include_usage: true },
              }
            : {}),
        };
        if (isDashScopeCompatible(endpoint)) omniPayload.enable_thinking = false;

        const upstreamOmni = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(omniPayload) });
        if (!upstreamOmni.ok) {
          sseWrite(res, 'error', await upstreamOmni.text());
          return res.end();
        }

        let omniFull = '';
        await proxySseToText(
          upstreamOmni,
          (delta) => {
            if (firstDeltaMs === null) firstDeltaMs = Date.now();
            omniFull += delta;
            sseWrite(res, 'delta', delta);
          },
          (audioB64) => {
            sseWrite(res, 'audio', audioB64);
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
        res.end();
        safeInsertHistory(llm.id, file?.originalname || input_text || '', omniFull, 'OMNI');
        return;
      }

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

      let llmFull = '';
      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          llmFull += delta;
          sseWrite(res, 'delta', delta);
        },
        null,
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
      res.end();
      safeInsertHistory(llm.id, input_text ?? '', llmFull, 'LLM');
      return;
    }

    const file = getUploadedFile(req, ['audio', 'media']);
    if (pipeline === 'asr_llm' && !file) throw new Error('Audio file required');
    if (pipeline === 'omni' && !file && !String(input_text ?? '').trim()) {
      throw new Error('Provide text input or a media file (audio/image/video) for OMNI');
    }

    if (pipeline === 'asr_llm') {
      const asr: any = getAuthorizedModelById(req.user, asr_model_id);
      const llm: any = getAuthorizedModelById(req.user, llm_model_id);
      if (!asr) throw new Error('ASR model not found');
      if (!llm) throw new Error('LLM model not found');
      if (!file) throw new Error('Audio file required');
      assertAllowedUpload({ model: asr, file });

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

      let llmFull = '';
      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          llmFull += delta;
          sseWrite(res, 'delta', delta);
        },
        null,
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
      res.end();
      safeInsertHistory(
        llm.id,
        `ASR(${asr.name}) -> LLM(${llm.name})\n\n${asrR.output}`,
        llmFull,
        'LLM'
      );
      return;
    }

    if (pipeline === 'omni') {
      const omni: any = getAuthorizedModelById(req.user, omni_model_id);
      if (!omni) throw new Error('OMNI model not found');
      if (file) assertAllowedUpload({ model: omni, file });
      if (omni.type !== 'OMNI' && !file) {
        throw new Error('Audio file required for ASR-style omni');
      }

      // Stream omni output via /api/test/stream-like logic
      const apiKey = decryptSecret(omni.api_key || '');
      if (!apiKey) throw new Error('Model API key not configured');
      const endpoint = normalizeEndpointForRequest(omni.endpoint, 'chat');
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const wantsVoice = omni.type === 'OMNI' && String(omni_voice ?? '').toLowerCase() === 'true';
      const payload: any = {
        model: omni.name,
        messages:
          omni.type === 'OMNI'
            ? buildOmniMessages({
                file,
                text: input_text ?? '',
                systemPrompt: prompt,
                voiceEnglish: wantsVoice,
              })
            : [
                {
                  role: 'user',
                  content: [{ type: 'input_audio', input_audio: { data: fileToDataUrl({ buffer: file!.buffer, mimetype: file!.mimetype }) } }],
                },
              ],
        stream: true,
      };
      if (wantsVoice) {
        payload.modalities = ['text', 'audio'];
        payload.audio = { voice: pickOmniVoice(omni.name), format: 'wav' };
        payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
      }
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

      let omniFull = '';
      await proxySseToText(
        upstream,
        (delta) => {
          if (firstDeltaMs === null) firstDeltaMs = Date.now();
          omniFull += delta;
          sseWrite(res, 'delta', delta);
        },
        (audioB64) => {
          sseWrite(res, 'audio', audioB64);
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
      res.end();
      safeInsertHistory(
        omni.id,
        file?.originalname || (input_text ? String(input_text) : 'Agent OMNI input'),
        omniFull,
        omni.type === 'OMNI' ? 'OMNI' : omni.type
      );
      return;
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
