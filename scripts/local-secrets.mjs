import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function localSecret(name = 'TRUTHTRACE_SESSION_SECRET', env = process.env) {
  const configured = env[name];
  if (configured && configured.length >= 32) return configured;
  const directory = resolve(/* turbopackIgnore: true */ env.TRUTHTRACE_DATA_DIR || '.truthtrace');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name.toLowerCase()}.secret`);
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = readFileSync(path, 'utf8');
  if (secret.length < 32) throw Error('Invalid local secret');
  return secret;
}
