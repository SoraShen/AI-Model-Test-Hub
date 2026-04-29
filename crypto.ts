import crypto from 'node:crypto';

const PREFIX = 'enc:gcm:v1:';

export function hasEncryptionKey(): boolean {
  try {
    const raw = process.env.ENCRYPTION_KEY;
    if (!raw) return false;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32;
  } catch {
    return false;
  }
}

function getKeyOrThrow(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is required to encrypt/decrypt model api keys');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 for exactly 32 bytes (AES-256-GCM)');
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const key = getKeyOrThrow();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return `${PREFIX}${payload}`;
}

export function decryptSecret(value: string): string {
  if (!value) return value;
  if (!isEncrypted(value)) return value;

  const key = getKeyOrThrow();
  const payload = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext;
}

