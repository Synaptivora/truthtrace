import { secureRoute } from "@/lib/security/boundary";
import { Store } from "@/lib/investigator/store";
import { effectiveConnection } from "@/lib/investigator/connections";
import { analyzeEvidence } from "@/lib/ai/provider";
import { readJson } from "@/lib/agent/http";
export const runtime="nodejs";
export const maxDuration=300;
async function rawPOST(request:Request,{params}:{params:Promise<{id:string}>}) {
  const store=new Store();
  try{
    await readJson(request,1000);
    if(!effectiveConnection(undefined,"analysis"))return Response.json({error:"还未连接分析模型，请先在助手设置中保存模型连接。"},{status:409});
    const {id}=await params,c=store.case(id),snapshot=JSON.stringify(c.evidence);
    const outcome=await analyzeEvidence(c.evidence);
    const saved=store.transaction(()=>{
      const current=store.case(id);
      if(JSON.stringify(current.evidence)!==snapshot)throw new Error("分析期间材料已更新，请重新分析最新材料。");
      store.db.prepare("INSERT INTO analysis_history(case_id,at,body) VALUES(?,?,?)").run(id,new Date().toISOString(),JSON.stringify(current.analysis));
      return store.saveCase({...current,analysis:outcome.analysis,notice:{...current.notice,note:"已用模型重新分析；原分析已保留备份。",droppedImages:outcome.meta.droppedImages,truncatedChars:outcome.meta.truncated}},true);
    });
    return Response.json({case:saved,meta:outcome.meta});
  }catch(e){const message=e instanceof Error?e.message:"";return Response.json({error:message.startsWith("模型服务 HTTP")||/分析期间|当前分析连接/.test(message)?message:"模型分析未完成，原材料和原分析已保留。请检查连接后重试。"},{status:502});}
  finally{store.close();}
}

export const POST = secureRoute(rawPOST);
