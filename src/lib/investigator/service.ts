import { spawn } from "node:child_process";
import { join } from "node:path";
import { Store } from "./store";
import { effectiveConnection } from "./connections";
export function serviceStatus(){
  const store=new Store();
  try {let model=false;try{model=!!effectiveConnection(undefined,"investigation")?.tools;}catch{/* An incomplete connection is repairable through model settings. */}return {worker:store.workerReady(),model};}
  finally {store.close();}
}
const state=globalThis as typeof globalThis & {truthtraceStartingWorker?:Promise<void>};
export async function ensureWorker(){
  if(serviceStatus().worker)return;
  if(state.truthtraceStartingWorker)return state.truthtraceStartingWorker;
  state.truthtraceStartingWorker=(async()=>{
    const child=spawn(process.execPath,["--import","tsx",join(process.cwd(),"scripts","investigator-worker.ts")],{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:"ignore"});
    let error:Error|undefined;child.on("error",e=>{error=e;});child.unref();
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,250));if(error)throw new Error("调查服务未能启动，请检查本机安装是否完整。");if(serviceStatus().worker)return;}
    throw new Error("调查服务暂未就绪，请点击重试；目标和材料已保留。");
  })().finally(()=>{state.truthtraceStartingWorker=undefined;});
  return state.truthtraceStartingWorker;
}
