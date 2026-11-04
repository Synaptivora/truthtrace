import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeError } from './safe-error';

export function localSecret(name = 'TRUTHTRACE_SESSION_SECRET'): string {
  const configured = process.env[name];
  if (configured && configured.length >= 32) return configured;
  const directory = resolve(process.env.TRUTHTRACE_DATA_DIR || '.truthtrace');
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
let activeRequests=0, reservedBytes=0;
export class BodyLimitError extends Error { constructor(public status:number){super('Request body rejected');} }
export async function boundedBody(request:Request,limit:number,timeoutMs=15_000):Promise<Uint8Array> {
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();
 const chunks:Uint8Array[]=[];let size=0;let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new BodyLimitError(408));void reader.cancel().catch(()=>{});},timeoutMs);});
 try {while(true){const {value,done}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});throw new BodyLimitError(413);}chunks.push(value);}return Buffer.concat(chunks,size);}
 finally{clearTimeout(timer);reader.releaseLock();}
}
export function secureRoute(handler:(request:Request)=>Promise<Response>):(request:Request)=>Promise<Response>;
export function secureRoute<C>(handler:(request:Request,context:C)=>Promise<Response>):(request:Request,context:C)=>Promise<Response>;
export function secureRoute<C>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C): Promise<Response> => {
    const fail = (status:number) => Response.json({error:status===413?'请求体超过限制':'请求未获允许或处理失败',code:`HTTP_${status}`,traceId:randomBytes(8).toString('hex'),retryable:status===429},{status,headers:{'Cache-Control':'no-store'}});
    let reserved=0;let acquired=false;
    const release=()=>{if(acquired){activeRequests--;reservedBytes-=reserved;acquired=false;}};
    try {
      if (!request || !authorized(request)) return fail(403);
      const key='local'; const now=Date.now(); let window=windows.get(key);
      if (!window || now-window.time>60_000) { window={time:now,count:0}; windows.set(key,window); }
      if (++window.count>600) return fail(429);
      const pathname=new URL(request.url).pathname;
      const limit = pathname.startsWith('/api/cases') || request.headers.get('content-type')?.includes('multipart/form-data') ? 25*1024*1024 : 2*1024*1024;
      const length=request.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length)>limit)) return fail(413);
      reserved=request.body?limit*3:0;
      if(activeRequests>=8||reservedBytes+reserved>150*1024*1024)return fail(429);
      activeRequests++;reservedBytes+=reserved;acquired=true;
      if (request.body) {
        const body=await boundedBody(request,limit);
        const headers=new Headers(request.headers);headers.set('content-length',String(body.byteLength));
        request=new Request(request.url,{method:request.method,headers,body:body as BodyInit,signal:request.signal});
      }
      const response=await handler(request,context as C);
      if(response.status>=400) { const detail=await response.json().catch(()=>null);const safe=safeError(detail?.error);return Response.json({...safe,traceId:randomBytes(8).toString('hex'),retryable:response.status===429},{status:response.status,headers:{'Cache-Control':'no-store'}}); }
      response.headers.set('Cache-Control','no-store');
      if(response.body) {
        const reader=response.body.getReader();let streamReleased=false;
        const finish=()=>{if(!streamReleased){streamReleased=true;activeRequests--;reservedBytes-=reserved;}};
        void reader.closed.then(finish,finish);
        acquired=false;
        const stream=new ReadableStream({async pull(controller){try{const {done,value}=await reader.read();if(done){finish();controller.close();}else controller.enqueue(value);}catch{finish();controller.error(new Error('Stream failed'));}},async cancel(reason){try{await reader.cancel(reason);}finally{finish();}}});
        return new Response(stream,{status:response.status,headers:response.headers});
      }
      return response;
    } catch(error) { return fail(error instanceof BodyLimitError?error.status:500); } finally {release();}
  };
}
