import { localSecret } from "../security/boundary";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { toolEnvironment } from "../../../scripts/setup.mjs";

export function ingestionUrl(){const url=new URL(process.env.INGESTION_SERVICE_URL||"http://127.0.0.1:8000");if(url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password||url.pathname!=="/")throw Error("Untrusted ingestion endpoint");return url.origin;}
export async function ingestionFetch(input:string,init:RequestInit={}) {const url=new URL(input);if(url.origin!==ingestionUrl())throw Error("Untrusted ingestion endpoint");const headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${localSecret("TRUTHTRACE_INGESTION_TOKEN")}`);let body=init.body;if(body instanceof FormData){const encoded=new Response(body);headers.set("Content-Type",encoded.headers.get("content-type")!);body=await encoded.arrayBuffer();}if(body!=null){const bytes=typeof body==="string"?Buffer.from(body):body instanceof ArrayBuffer?Buffer.from(body):body;if(!(bytes instanceof Uint8Array))throw Error("Unsupported body");if(bytes.byteLength>25*1024*1024)throw Error("Request too large");headers.set("Content-Length",String(bytes.byteLength));body=bytes;}return fetch(url,{...init,body,headers,redirect:"error"});}
export const ingestionErrors = {
  auth: "材料服务凭据不匹配，请停止旧解析服务后使用 npm run start:local 重新启动。",
  occupied: "材料服务端口已有不兼容或无响应的服务，请停止旧服务后重新启动。",
};
type Probe = "ready" | "unavailable" | "auth" | "occupied";
async function probeIngestion(): Promise<Probe> {
  try {
    const response=await ingestionFetch(ingestionUrl()+"/health/auth", {signal:AbortSignal.timeout(1200),cache:"no-store"});
    if(response.status===401 || response.status===403)return "auth";
    if(!response.ok)return "occupied";
    const result=await response.json();
    return result.status==="ok" && result.authenticated===true ? "ready" : "occupied";
  } catch(error) {
    const cause=(error as {cause?:{code?:string}})?.cause;
    return cause?.code==="ECONNREFUSED" ? "unavailable" : "occupied";
  }
}
export async function ingestionReady(){return await probeIngestion()==="ready";}
const state=globalThis as typeof globalThis&{truthtraceStartingIngestion?:Promise<void>};
export async function ensureIngestion(){
  if(state.truthtraceStartingIngestion)return state.truthtraceStartingIngestion;
  state.truthtraceStartingIngestion=(async()=>{
    const initial=await probeIngestion();
    if(initial==="ready")return;
    if(initial!=="unavailable")throw new Error(ingestionErrors[initial]);
    const url=new URL(ingestionUrl());
    const env=toolEnvironment({PORT:url.port||"80",INGESTION_HOST:url.hostname.replace(/^\[|\]$/g,""),TRUTHTRACE_INGESTION_TOKEN:localSecret("TRUTHTRACE_INGESTION_TOKEN")});
    const child=spawn(/* turbopackIgnore: true */ env.SYNAPSE_PYTHON||(process.platform==="win32"?"python":"python3"),[join(process.cwd(),"services","ingestion","server.py")],{cwd:join(process.cwd(),"services","ingestion"),env,windowsHide:true,detached:true,stdio:"ignore"});
    let failed=false;child.on("error",()=>{failed=true;});child.on("exit",()=>{failed=true;});child.unref();
    try {
      for(let i=0;i<30;i++){
        const probe=await probeIngestion();
        if(probe==="ready")return;
        if(probe!=="unavailable")throw new Error(ingestionErrors[probe]);
        if(failed)throw new Error("材料服务启动失败，请确认已安装 Python 及解析依赖；可在连接设置中修复安装。");
        await new Promise(r=>setTimeout(r,300));
      }
      throw new Error("材料服务启动超时，请重试连接；已导入材料不会丢失。");
    } catch(error) {child.kill();throw error;}
  })().finally(()=>{state.truthtraceStartingIngestion=undefined;});
  return state.truthtraceStartingIngestion;
}
