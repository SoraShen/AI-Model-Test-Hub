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
    type TEXT NOT NULL CHECK (type IN ('LLM', 'ASR', 'OMNI')),
    endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_models (
    user_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, model_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
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

const migrateExpandModelTypes = () => {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'models'")
    .get() as { sql?: string } | undefined;
  const sql = row?.sql || '';
  if (sql.includes("'OMNI'")) return;

  // Expand models.type CHECK constraint to include OMNI.
  // SQLite doesn't support altering CHECK constraints in-place; recreate the table.
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  try {
    db.exec('ALTER TABLE models RENAME TO models_old;');
    db.exec(`
      CREATE TABLE models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('LLM', 'ASR', 'OMNI')),
        endpoint TEXT NOT NULL,
        api_key TEXT NOT NULL
      );
    `);
    db.exec(`INSERT INTO models (id, name, type, endpoint, api_key) SELECT id, name, type, endpoint, api_key FROM models_old;`);
    db.exec('DROP TABLE models_old;');
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
};

const migrateFixBrokenModelForeignKeys = () => {
  // If models was renamed in the past (models -> models_old), SQLite may have rewritten
  // foreign key references in other tables to point to models_old. If models_old is gone,
  // inserts will fail with: "no such table: main.models_old".
  const tables = ['history', 'user_models'];
  for (const t of tables) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t) as { sql?: string } | undefined;
    const sql = row?.sql || '';
    if (!sql.includes('models_old')) continue;

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN;');
    try {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_old;`);
      if (t === 'history') {
        db.exec(`
          CREATE TABLE history (
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
        db.exec(`
          INSERT INTO history (id, user_id, model_id, input, output, type, timestamp)
          SELECT id, user_id, model_id, input, output, type, timestamp FROM history_old;
        `);
      } else if (t === 'user_models') {
        db.exec(`
          CREATE TABLE user_models (
            user_id INTEGER NOT NULL,
            model_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, model_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
          );
        `);
        db.exec(`
          INSERT INTO user_models (user_id, model_id)
          SELECT user_id, model_id FROM user_models_old;
        `);
      }
      db.exec(`DROP TABLE ${t}_old;`);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
};

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
  const templates: Array<{ name: string; type: 'LLM' | 'ASR' | 'OMNI'; endpoint: string }> = [
    // Alibaba Cloud DashScope (OpenAI compatible mode)
    { name: 'qwen3-asr-flash', type: 'ASR', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { name: 'qwen3-omni-30b-a3b-captioner', type: 'ASR', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    // Omni model (audio/image/video understanding)
    { name: 'qwen3-omni-flash', type: 'OMNI', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },

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

  // Ensure qwen3-omni-flash exists and is marked as OMNI.
  db.prepare('UPDATE models SET name = ? WHERE name = ?').run('qwen3-omni-flash', 'qwen3-omni-instruct');
  const omniExists = db.prepare('SELECT id FROM models WHERE name = ?').get('qwen3-omni-flash');
  if (!omniExists) {
    db.prepare('INSERT INTO models (name, type, endpoint, api_key) VALUES (?, ?, ?, ?)').run(
      'qwen3-omni-flash',
      'OMNI',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ''
    );
  } else {
    db.prepare('UPDATE models SET endpoint = ? WHERE name = ?').run('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3-omni-flash');
    db.prepare('UPDATE models SET type = ? WHERE name = ?').run('OMNI', 'qwen3-omni-flash');
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

const seedDefaultUserModelAccess = () => {
  // Keep existing installs working: if the seeded "user" has no explicit grants yet,
  // grant access to all current models.
  const user: any = db.prepare('SELECT id FROM users WHERE username = ?').get('user');
  if (!user?.id) return;

  const hasAny = db.prepare('SELECT 1 FROM user_models WHERE user_id = ? LIMIT 1').get(user.id);
  if (hasAny) return;

  const modelIds: Array<{ id: number }> = db.prepare('SELECT id FROM models').all() as any;
  const ins = db.prepare('INSERT OR IGNORE INTO user_models (user_id, model_id) VALUES (?, ?)');
  const tx = db.transaction((ids: Array<{ id: number }>) => {
    for (const m of ids) ins.run(user.id, m.id);
  });
  tx(modelIds);
};

seedUsers();
migrateExpandModelTypes();
migrateFixBrokenModelForeignKeys();
purgeInternalModels();
migrateModelTemplates();
seedModels();
migrateAndEncryptExternalKeys();
seedDefaultUserModelAccess();

export default db;
