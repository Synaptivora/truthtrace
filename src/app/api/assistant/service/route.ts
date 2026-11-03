import { readJson } from "@/lib/agent/http";
import { ensureWorker,serviceStatus } from "@/lib/investigator/service";
export const runtime="nodejs";
export async function GET(){return Response.json(serviceStatus(),{headers:{"Cache-Control":"no-store"}});}
export async function POST(request:Request){try{
  const host=new URL(`http://${request.headers.get("host")||""}`).hostname;
  if(!["localhost","127.0.0.1","[::1]"].includes(host))return Response.json({error:"请在本机启动调查服务"},{status:403});
  await readJson(request,1000);await ensureWorker();return Response.json(serviceStatus());
}catch(e){return Response.json({error:e instanceof Error?e.message:"启动失败"},{status:400});}}
