import {test,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/lib/investigator/store';
import {searchCases,updateMetadata} from '../src/components/truthtrace/case-search/server';
import {GET} from '../src/app/api/case-search/route';
test('global search filters and metadata persist without cross-case result mixing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-global-search-'));const store=new Store(dir);
 try{const analysis={caseTitle:'虚构',summary:'待核查',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
 for(const id of ['a','b'])store.saveCase({caseId:id,caseName:id,analysis,evidence:[{id:'e',kind:'text',name:'聊天',mimeType:'text/plain',source:'微信',content:`2026-11-04 ${id} 退款尚未到账`}]});
 expect(searchCases(store,{q:'退款'}).total).toBe(2);
 updateMetadata(store,{caseId:'b',tags:['复核'],archived:true});expect(searchCases(store,{q:'退款'}).total).toBe(1);
 const archived=searchCases(store,{q:'退款',archived:'yes',tag:'复核',source:'微信',from:'2026-11-04',to:'2026-11-04'});expect(archived.total).toBe(1);expect(archived.hits[0].caseId).toBe('b');expect(archived.hits[0].version).toBe(1);
 expect(searchCases(store,{q:'退款',caseId:'unknown',archived:'all'}).total).toBe(0);
 expect(searchCases(store,{q:'退款',from:'2026-11-05'}).total).toBe(0);
 expect(()=>searchCases(store,{q:'退款',authorizedVersions:[]})).toThrow();
 expect(()=>updateMetadata(store,{caseId:'missing',tags:[],archived:false})).toThrow();
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('global search denies anonymous and remote modes',async()=>{
 const request=new Request('http://127.0.0.1:3000/api/case-search',{headers:{host:'127.0.0.1:3000'}});
 expect((await GET(request)).status).toBe(403);vi.stubEnv('TRUTHTRACE_MODE','remote');
 try{expect((await GET(request)).status).toBe(403);}finally{vi.unstubAllEnvs();}
});
