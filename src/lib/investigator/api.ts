import { z } from "zod";
import { readJson } from "../agent/http";
import { effectiveConnection as resolveConnection } from "./connections";
import { Store } from "./store";
import { EvidenceSchema } from "../contracts";
import { report } from "./runtime";

export async function handle(request:Request, kind:"cases"|"investigations", path:string[]) {
  const store=new Store();
  try {
    const [id,resource]=path;
    if(request.method==="GET") {
      if(kind==="cases") return Response.json(!id?{cases:store.cases()}:resource==="investigations"?{tasks:store.tasks(id)}:{case:store.case(id)});
      const task=store.task(id);
      if(resource==="events") {
        const after=Number(new URL(request.url).searchParams.get("after")||0);
        if(!Number.isSafeInteger(after)||after<0)throw new Error("无效事件游标");
        return Response.json({events:store.events(id,after)});
      }
      if(resource==="report") {
        const revision=Number(new URL(request.url).searchParams.get("revision")||task.revision);
        const row=store.db.prepare("SELECT body FROM reports WHERE task_id=? AND revision=?").get(id,revision) as {body:string}|undefined;
        return new Response(row?.body||report(task),{headers:{"Content-Type":"text/markdown; charset=utf-8","Content-Disposition":'attachment; filename="investigation.md"'}});
      }
      return Response.json({task});
    }
    const body=await readJson(request,100*1024*1024);
    if(kind==="cases") {
      if(!id) return Response.json({case:store.saveCase(body)});
      if(resource==="investigations") {
        const connection=resolveConnection(undefined,"investigation");if(!connection?.tools)throw new Error("请先配置支持工具调用的共享或调查模型");
        return Response.json({task:store.createTask(id,body)},{status:202});
      }
      if(resource==="evidence") {
        const data=z.object({evidence:z.array(EvidenceSchema)}).parse(body);
        const c=store.case(id);return Response.json({case:store.saveCase({...c,evidence:[...c.evidence.filter(e=>!data.evidence.some(n=>n.id===e.id)),...data.evidence]})});
      }
      return Response.json({case:store.saveCase({...store.case(id),...z.object({caseName:z.string().optional(),reviewNotes:z.record(z.string(),z.string()).optional()}).parse(body),caseId:id})});
    }
    if(resource==="actions") {
      const data=z.object({action:z.enum(["pause","resume","cancel","retry","revise"]),goal:z.string().trim().min(1).max(4000).optional()}).parse(body);
      return Response.json({task:store.action(id,data.action,data.goal)});
    }
    if(resource==="decisions") {
      const data=z.object({id:z.string(),value:z.enum(["accepted","rejected","modified","unverified"]),reason:z.string().min(1).max(4000)}).parse(body);
      return Response.json({task:store.decision(id,data)});
    }
    return Response.json({error:"未知操作"},{status:404});
  }catch(error){return Response.json({error:error instanceof z.ZodError?"请求字段不符合契约":error instanceof Error?error.message:"请求失败"},{status:400});}
  finally{store.close();}
}
