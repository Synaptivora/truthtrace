import { afterEach, expect, test, vi } from 'vitest';
import { authorized, secureRoute, session } from '../src/lib/security/boundary';
afterEach(()=>vi.unstubAllEnvs());
function request(extra:Record<string,string>={},body?:string) { return new Request('http://127.0.0.1:3000/api/test',{method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:3000',...extra},body}); }
test('browser session and origin gates',()=>{
 vi.stubEnv('TRUTHTRACE_SESSION_SECRET','s'.repeat(64));vi.stubEnv('PORT','3000');
 const cookie=`tt_session=${session()}`;
 expect(authorized(request())).toBe(false);
 expect(authorized(request({cookie,'sec-fetch-site':'same-origin'}))).toBe(true);
 expect(authorized(request({cookie,'sec-fetch-site':'same-origin'},'{}'))).toBe(false);
 expect(authorized(request({cookie,origin:'http://127.0.0.1:3000'},'{}'))).toBe(true);
 expect(authorized(request({cookie,origin:'null'}))).toBe(false);
 expect(authorized(request({cookie,origin:'https://evil.example'}))).toBe(false);
 expect(authorized(request({cookie,host:'evil.example','sec-fetch-site':'same-origin'}))).toBe(false);
 vi.stubEnv('TRUTHTRACE_MODE','remote');expect(authorized(request({cookie,'sec-fetch-site':'same-origin'}))).toBe(false);
});
test('machine authentication, byte counting and sanitized errors',async()=>{
 vi.stubEnv('TRUTHTRACE_MACHINE_TOKEN','m'.repeat(64));vi.stubEnv('PORT','3000');
 const headers={authorization:`Bearer ${'m'.repeat(64)}`};const handler=vi.fn(async()=>Response.json({ok:true}));const route=secureRoute(handler);
 expect((await route(request(headers,'{}'))).status).toBe(200);
 expect((await route(request(headers,'x'.repeat(2*1024*1024+1)))).status).toBe(413);
 expect(handler).toHaveBeenCalledTimes(1);
 const error=await secureRoute(async()=>Response.json({error:'secret-private-upstream'},{status:422}))(request(headers));
 expect(error.status).toBe(422);expect(await error.text()).not.toContain('secret-private-upstream');
});
