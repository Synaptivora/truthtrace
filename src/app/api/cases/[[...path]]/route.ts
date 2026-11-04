import { secureRoute } from "@/lib/security/boundary";
import { handle } from "@/lib/investigator/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{path?:string[]}>};
async function rawGET(request:Request,context:Context){return handle(request,"cases",(await context.params).path||[]);}
async function rawPOST(request:Request,context:Context){return handle(request,"cases",(await context.params).path||[]);}

export const GET = secureRoute(rawGET);

export const POST = secureRoute(rawPOST);
