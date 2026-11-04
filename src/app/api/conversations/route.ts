import {z} from "zod";
import {Store} from "@/lib/investigator/store";
import {Conversations} from "@/lib/conversation/store";
import {secureRoute} from "@/lib/security/boundary";
import {readJson} from "@/lib/agent/http";
export const runtime="nodejs";
const input=z.object({caseId:z.string().min(1),id:z.string().min(1).optional(),revision:z.number().int().positive().optional(),action:z.enum(["create","edit","delete_turn","clear_summary","delete"]).optional(),index:z.number().int().min(0).optional(),content:z.string().min(1).max(12000).optional()}).strict();
async function handle(request:Request){const store=new Store();try{const api=new Conversations(store.db);if(request.method==="GET"){const url=new URL(request.url),caseId=url.searchParams.get("caseId")??"",id=url.searchParams.get("id");return Response.json(url.searchParams.get("list")==="1"?api.list(caseId):id?api.get(caseId,id):api.latest(caseId));}const data=input.parse(await readJson(request));if(data.action==="create")return Response.json(api.create(data.caseId));if(!data.id||!data.revision)throw Error("Missing conversation revision");if(data.action==="delete"){api.remove(data.caseId,data.id,data.revision);return Response.json({deleted:true});}if(data.action==="clear_summary")return Response.json(api.clearSummary(data.caseId,data.id,data.revision));if(data.index===undefined)throw Error("Missing message index");if(data.action==="edit"&&data.content)return Response.json(api.edit(data.caseId,data.id,data.revision,data.index,data.content));if(data.action==="delete_turn")return Response.json(api.edit(data.caseId,data.id,data.revision,data.index));throw Error("Invalid action");}catch{return Response.json({error:"会话不存在、版本已变化或操作无效，请刷新后重试"},{status:409});}finally{store.close();}}
export const GET=secureRoute(handle);
export const POST=secureRoute(handle);
