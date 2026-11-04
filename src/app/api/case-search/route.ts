import { secureRoute } from '@/lib/security/boundary';
import { readJson } from '@/lib/agent/http';
import { Store } from '@/lib/investigator/store';
import { searchCases,updateMetadata } from '@/components/truthtrace/case-search/server';
export const runtime='nodejs';
export const GET=secureRoute(async(request:Request)=>{const store=new Store();try{return Response.json(searchCases(store,Object.fromEntries(new URL(request.url).searchParams)));}catch{return Response.json({error:'请缩小检索范围或检查筛选条件'},{status:400});}finally{store.close();}});
export const POST=secureRoute(async(request:Request)=>{const store=new Store();try{return Response.json(updateMetadata(store,await readJson(request,16000)));}catch{return Response.json({error:'标签或归档设置无效'},{status:400});}finally{store.close();}});
