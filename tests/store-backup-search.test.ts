import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {backupStore,restoreStore} from '@/lib/investigator/backup';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
it('rejects incomplete manifests and parent directory symlink escapes before restoring',()=>{
 const root=mkdtempSync(join(tmpdir(),'tt-backup-sec-'));const s=new Store(join(root,'data'));
 try{s.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'e',kind:'text',mimeType:'text/plain',content:'refund old'}]});const b=join(root,'backup');backupStore(s,b);const file=join(b,'manifest.json');const original=JSON.parse(readFileSync(file,'utf8'));
 for(const files of [[],original.files.filter((x:{path:string})=>x.path!=='cases.sqlite'),original.files.filter((x:{path:string})=>!x.path.startsWith('objects/')),[...original.files,original.files[0]]]){writeFileSync(file,JSON.stringify({...original,files}));expect(()=>restoreStore(b,join(root,'restore'))).toThrow();}
 writeFileSync(file,JSON.stringify(original));renameSync(join(b,'objects'),join(root,'outside'));symlinkSync(join(root,'outside'),join(b,'objects'),process.platform==='win32'?'junction':'dir');expect(()=>restoreStore(b,join(root,'restore'))).toThrow();
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
it('searches a pinned task version and never substitutes newer evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'tt-search-store-'));const s=new Store(root);try{
 const save=(content:string)=>s.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'e',kind:'text',mimeType:'text/plain',content}]});save('old refund promise');const t=s.createTask('a',{goal:'fixture',idempotencyKey:'one'});save('new payment completed');
 expect(s.searchSnapshot(t,'refund').matches[0].version).toBe(1);expect(s.searchSnapshot(t,'completed').matches).toHaveLength(0);expect(s.searchCase('a','completed').hits[0].version).toBe(2);expect(s.searchCase('a','refund').hits).toHaveLength(0);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

it('binds legacy content to its matching historical version instead of MAX',()=>{
 const root=mkdtempSync(join(tmpdir(),'tt-legacy-version-'));const s=new Store(root);try{
 const input=(content:string)=>({caseId:'a',analysis,evidence:[{id:'e',name:'e',kind:'text',mimeType:'text/plain',content}]});s.saveCase(input('version one'));s.saveCase(input('version two'));
 s.db.prepare('UPDATE cases SET body=? WHERE id=?').run(JSON.stringify(input('version one')),'a');expect(s.snapshot('a')[0].version).toBe(1);expect(s.searchCase('a','one').hits[0].version).toBe(1);
 expect(s.saveCase(input('version one')).evidence[0].version).toBe(3);expect(s.snapshot('a')[0].version).toBe(3);
 s.db.prepare('UPDATE cases SET body=? WHERE id=?').run(JSON.stringify(input('unknown version')),'a');expect(()=>s.snapshot('a')).toThrow('确切历史版本');
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
