import { boundedBody } from '../security/boundary';
export async function readJson(request:Request,limit=2*1024*1024):Promise<unknown>{
 if(!request.headers.get('content-type')?.includes('application/json'))throw Error('请发送 JSON 请求。');
 const origin=request.headers.get('origin');const url=new URL(request.url);
 if(origin&&origin!==`${url.protocol}//${request.headers.get('host')||url.host}`)throw Error('不接受跨站请求。');
 return JSON.parse(new TextDecoder().decode(await boundedBody(request,Math.min(limit,25*1024*1024))));
}
