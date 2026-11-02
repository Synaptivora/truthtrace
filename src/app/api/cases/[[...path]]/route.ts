import { handle } from "@/lib/investigator/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{path?:string[]}>};
export async function GET(request:Request,context:Context){return handle(request,"cases",(await context.params).path||[]);}
export async function POST(request:Request,context:Context){return handle(request,"cases",(await context.params).path||[]);}
