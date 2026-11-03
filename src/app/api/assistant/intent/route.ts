import { z } from "zod";
import { readJson } from "@/lib/agent/http";
import { inferIntent } from "@/lib/investigator/intent";
export const runtime="nodejs";
export async function POST(request:Request){
  try {const input=z.object({goal:z.string().trim().min(1).max(4000),hasEvidence:z.boolean()}).parse(await readJson(request,20000));
    return Response.json(await inferIntent(input.goal,input.hasEvidence,request.signal));
  } catch {return Response.json({error:"暂时无法判断下一步，请重试或直接提问。"},{status:400});}
}
