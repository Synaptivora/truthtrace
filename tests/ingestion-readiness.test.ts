import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureIngestion, ingestionErrors, ingestionReady } from '../src/lib/ingestion/service';
import { safeError } from '../src/lib/security/safe-error';

const spawn = vi.hoisted(() => vi.fn(() => { throw Error('Unexpected spawn'); }));
vi.mock('node:child_process', () => ({ spawn }));
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  spawn.mockClear();
});
async function listen(status: number, body: unknown) {
  vi.stubEnv('TRUTHTRACE_INGESTION_TOKEN', 'test-token-'.repeat(5));
  server = createServer((req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
    expect(req.url).toBe('/health/auth');
    expect(req.headers.authorization).toBe(`Bearer ${'test-token-'.repeat(5)}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as {port: number};
  vi.stubEnv('INGESTION_SERVICE_URL', `http://127.0.0.1:${address.port}`);
}
it('rejects a live service with stale credentials without spawning another process', async () => {
  await listen(401, { error: 'Unauthorized' });
  expect(await ingestionReady()).toBe(false);
  await expect(ensureIngestion()).rejects.toThrow(ingestionErrors.auth);
  expect(spawn).not.toHaveBeenCalled();
  expect(safeError(ingestionErrors.auth).code).toBe('INGESTION_AUTH');
});
it.each([[404, {}], [200, {status:'ok'}], [503, {}]])('rejects incompatible occupied service %s', async (status, body) => {
  await listen(status as number, body);
  await expect(ensureIngestion()).rejects.toThrow(ingestionErrors.occupied);
  expect(spawn).not.toHaveBeenCalled();
});
it('accepts authenticated readiness and shares concurrent probes', async () => {
  await listen(200, {status:'ok', authenticated:true});
  expect(await ingestionReady()).toBe(true);
  await Promise.all([ensureIngestion(), ensureIngestion()]);
  expect(spawn).not.toHaveBeenCalled();
});
