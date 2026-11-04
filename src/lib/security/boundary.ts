import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function localSecret(name = 'TRUTHTRACE_SESSION_SECRET'): string {
  const configured = process.env[name];
  if (configured && configured.length >= 32) return configured;
  const directory = join(process.cwd(), '.truthtrace');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name.toLowerCase()}.secret`);
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const secret = readFileSync(path, 'utf8');
  if (secret.length < 32) throw Error('Invalid local secret');
  return secret;
}
export function equal(a: string, b: string) { return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function trusted(request: Request) {
  if ((process.env.TRUTHTRACE_MODE || 'local') !== 'local') return false;
  const port = process.env.PORT || '3000';
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  const host = request.headers.get('host');
  return origins.some(origin => new URL(origin).host === host) && origins.includes(new URL(request.url).origin);
}
export function session() { const expires = String(Date.now() + 12 * 3600_000); return `${expires}.${createHmac('sha256', localSecret()).update(expires).digest('hex')}`; }
function validSession(request: Request) {
  const value = request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('tt_session='))?.slice(11) || '';
  const [expires, signature] = value.split('.');
  return /^\d+$/.test(expires || '') && Number(expires) > Date.now() && Number(expires) <= Date.now()+12*3600_000 && equal(signature || '', createHmac('sha256',localSecret()).update(expires).digest('hex'));
}
export function authorized(request: Request) {
  if (!trusted(request)) return false;
  const origin = request.headers.get('origin');
  if (origin === 'null' || (origin && origin !== `http://${request.headers.get('host')}`)) return false;
  const token = process.env.TRUTHTRACE_MACHINE_TOKEN;
  if (token && token.length >=32 && equal(request.headers.get('authorization') || '', `Bearer ${token}`)) return true;
  // Browser GETs commonly omit Origin; Fetch Metadata is required in that case.
  if (!origin && !(request.method==='GET' && request.headers.get('sec-fetch-site') === 'same-origin')) return false;
  return validSession(request);
}
const windows = new Map<string, { time: number; count: number }>();
export function secureRoute<C>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request?: Request, context?: C): Promise<Response> => {
    const fail = (status:number) => Response.json({error:status===413?'请求体超过限制':'请求未获允许或处理失败',code:`HTTP_${status}`,traceId:randomBytes(8).toString('hex'),retryable:status===429},{status,headers:{'Cache-Control':'no-store'}});
    try {
      if (!request || !authorized(request)) return fail(403);
      const key='local'; const now=Date.now(); let window=windows.get(key);
      if (!window || now-window.time>60_000) { window={time:now,count:0}; windows.set(key,window); }
      if (++window.count>600) return fail(429);
      const pathname=new URL(request.url).pathname;
      const limit = pathname.startsWith('/api/cases') || request.headers.get('content-type')?.includes('multipart/form-data') ? 25*1024*1024 : 2*1024*1024;
      const length=request.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length)>limit)) return fail(413);
      if (request.body) {
        const reader=request.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
        try { while(true) { const {done,value}=await reader.read(); if(done)break; total+=value.byteLength; if(total>limit){await reader.cancel();return fail(413);} chunks.push(value); } } finally {reader.releaseLock();}
        const headers=new Headers(request.headers); headers.set('content-length',String(total));
        request=new Request(request.url,{method:request.method,headers,body:Buffer.concat(chunks),signal:request.signal});
      }
      const response=await handler(request,context as C);
      if(response.status>=400) { await response.body?.cancel(); return fail(response.status); }
      response.headers.set('Cache-Control','no-store'); return response;
    } catch { return fail(500); }
  };
}
