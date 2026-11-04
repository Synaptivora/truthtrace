// Real local Python service; temporary credentials/data; never reads user settings.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'tt-readiness-'));
const host = process.argv.includes('--ipv6') ? '::1' : '127.0.0.1';
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, host, resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = crypto.randomUUID() + crypto.randomUUID();
Object.assign(process.env, {
  INGESTION_SERVICE_URL: `http://${host === '::1' ? '[::1]' : host}:${port}`,
  TRUTHTRACE_INGESTION_TOKEN: token,
  TRUTHTRACE_DATA_DIR: directory,
  TRUTHTRACE_HANDLE_DIR: join(directory, 'handles'),
});
const originalSpawn = childProcess.spawn;
const children = [];
childProcess.spawn = (...args) => { const child = originalSpawn(...args); children.push(child); return child; };
syncBuiltinESMExports();
try {
  const { ensureIngestion, ingestionReady, ingestionErrors } = await import('../src/lib/ingestion/service.ts');
  await Promise.all([ensureIngestion(), ensureIngestion()]);
  assert.equal(children.length, 1);
  assert.equal(await ingestionReady(), true);
  process.env.TRUTHTRACE_INGESTION_TOKEN = crypto.randomUUID() + crypto.randomUUID();
  assert.equal(await ingestionReady(), false);
  await assert.rejects(ensureIngestion, { message: ingestionErrors.auth });
  assert.equal(children.length, 1);
  process.env.TRUTHTRACE_INGESTION_TOKEN = token;
  assert.equal(await ingestionReady(), true);
  console.log('PASS: real Python cold start, shared startup, authenticated readiness, stale-token rejection without duplicate spawn.');
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const child of children) child.kill();
}
