import './env';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { encryptSecret, hasEncryptionKey, isEncrypted } from './crypto';

const db = new Database('platform.db');

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user'))
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('LLM', 'ASR')),
    endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    type TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (model_id) REFERENCES models(id)
  );
`);

// Seed initial users if they don't exist
const seedUsers = () => {
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', adminHash, 'admin');
  }

  const userExists = db.prepare('SELECT id FROM users WHERE username = ?').get('user');
  if (!userExists) {
    const userHash = bcrypt.hashSync('user123', 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('user', userHash, 'user');
  }
};

// Seed initial models if they don't exist
const seedModels = () => {
  const templates: Array<{ name: string; type: 'LLM' | 'ASR'; endpoint: string }> = [
    // Alibaba Cloud DashScope (OpenAI compatible mode)
    { name: 'qwen3-asr-flash', type: 'ASR', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { name: 'qwen3-omni-30b-a3b-captioner', type: 'ASR', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    // qwen3-omni-flash is an omni model (supports audio input). We treat it as ASR/Audio-understanding here.
    { name: 'qwen3-omni-flash', type: 'ASR', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },

    // HuggingFace Whisper (default placeholder; you will need to set endpoint/token)
    { name: 'whisper-large-v3', type: 'ASR', endpoint: 'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3' },
  ];

  for (const t of templates) {
    const exists = db.prepare('SELECT id FROM models WHERE name = ?').get(t.name);
    if (!exists) {
      // api_key is required for execution; leave empty so admin must configure
      db.prepare('INSERT INTO models (name, type, endpoint, api_key) VALUES (?, ?, ?, ?)').run(t.name, t.type, t.endpoint, '');
    }
  }
};

const purgeInternalModels = () => {
  // Historical migration: remove old "internal" Gemini models.
  db.prepare("DELETE FROM models WHERE endpoint = 'internal'").run();
};

const migrateModelTemplates = () => {
  // Normalize Whisper model name to user preference.
  db.prepare('UPDATE models SET name = ? WHERE name = ?').run('whisper-large-v3', 'openai/whisper-large-v3');

  // Update Whisper endpoint to HuggingFace Router recommendation.
  db.prepare("UPDATE models SET endpoint = ? WHERE name = ? AND endpoint = ?").run(
    'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3',
    'whisper-large-v3',
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3'
  );

  // DashScope keys are endpoint/region sensitive. If user is using intl key (works for qwen3-asr-flash),
  // unify Qwen endpoints to dashscope-intl to avoid 401 invalid_api_key.
  db.prepare('UPDATE models SET endpoint = ? WHERE name = ? AND endpoint = ?').run(
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'qwen3-omni-30b-a3b-captioner',
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  // Replace legacy instruct entry with qwen3-omni-flash.
  db.prepare("DELETE FROM models WHERE name = 'qwen3-omni-30b-a3b-instruct'").run();
  const omniFlashExists = db.prepare('SELECT id FROM models WHERE name = ?').get('qwen3-omni-flash');
  if (!omniFlashExists) {
    db.prepare('INSERT INTO models (name, type, endpoint, api_key) VALUES (?, ?, ?, ?)').run(
      'qwen3-omni-flash',
      'ASR',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ''
    );
  } else {
    db.prepare('UPDATE models SET endpoint = ? WHERE name = ?').run('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3-omni-flash');
    db.prepare('UPDATE models SET type = ? WHERE name = ?').run('ASR', 'qwen3-omni-flash');
  }

  // Add DeepSeek v4 (Huawei ModelArts MaaS) template if missing.
  const deepseekExists = db.prepare('SELECT id FROM models WHERE name = ?').get('deepseek-v4-flash');
  if (!deepseekExists) {
    db.prepare('INSERT INTO models (name, type, endpoint, api_key) VALUES (?, ?, ?, ?)').run(
      'deepseek-v4-flash',
      'LLM',
      'https://api-ap-southeast-1.modelarts-maas.com/v2/chat/completions',
      ''
    );
  }
};

const migrateAndEncryptExternalKeys = () => {
  if (!hasEncryptionKey()) {
    const row = db
      .prepare("SELECT COUNT(1) as c FROM models WHERE endpoint != 'internal' AND api_key != '' AND api_key NOT LIKE 'enc:%'")
      .get() as { c?: number } | undefined;
    const hasExternalPlaintext = (row?.c ?? 0) > 0;
    if (hasExternalPlaintext) {
      console.warn(
        'ENCRYPTION_KEY is not set; external model API keys remain unencrypted. Set ENCRYPTION_KEY to enable encryption-at-rest.'
      );
    }
    return;
  }
  const rows: any[] = db.prepare('SELECT id, endpoint, api_key FROM models').all();
  for (const row of rows) {
    if (row.endpoint === 'internal') continue;
    if (!row.api_key) continue;
    if (isEncrypted(row.api_key)) continue;
    const enc = encryptSecret(row.api_key);
    db.prepare('UPDATE models SET api_key = ? WHERE id = ?').run(enc, row.id);
  }
};

seedUsers();
purgeInternalModels();
migrateModelTemplates();
seedModels();
migrateAndEncryptExternalKeys();

export default db;
