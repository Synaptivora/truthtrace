import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {backupStore,restoreStore} from '@/lib/investigator/backup';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
it('fences same-owner reclaimed leases, keeps lifetime budgets, versions and backup',()=>{
 const root=mkdtempSync(join(tmpdir(),'tt-store-'));const s=new Store(join(root,'data'));let second:Store|undefined;
 try{
 const save=(content:string)=>s.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'fixture',kind:'text',mimeType:'text/plain',content,version:999}]});
 save('one');save('two');save('one');expect(s.evidenceVersions('a','e')).toHaveLength(3);expect(s.evidenceVersion('a','e',3).evidence.content).toBe('one');
 const t=s.createTask('a',{goal:'fixture',idempotencyKey:'one'});const first=s.claim('same')!;const old=s.lease(first);s.owned(old,x=>{x.modelCalls++;});s.db.prepare('UPDATE tasks SET lease=0 WHERE id=?').run(t.id);second=new Store(join(root,'data'));const next=second.claim('same')!;
 expect(s.owned(old,x=>{x.step=8;})).toBe(false);expect(second.owned(second.lease(next),x=>{x.modelCalls++;})).toBe(true);
 const revised=s.action(t.id,'revise');expect(revised.modelCalls).toBe(0);expect(revised.lifetimeModelCalls).toBe(2);save('new');expect(s.task(t.id).stale).toBeDefined();
 const before=s.db.prepare('SELECT body FROM tasks WHERE id=?').get(t.id);s.action(t.id,'resume');const current=s.claim('third')!;const raw=s.db.prepare('SELECT body FROM tasks WHERE id=?').get(t.id);expect(s.renewLease(s.lease(current),Date.now(),2000)).toBe(true);expect(s.db.prepare('SELECT body FROM tasks WHERE id=?').get(t.id)).toEqual(raw);expect(before).toBeDefined();
 backupStore(s,join(root,'backup'));restoreStore(join(root,'backup'),join(root,'restored'));const restored=new Store(join(root,'restored'));expect(restored.evidenceVersions('a','e')).toHaveLength(4);expect(restored.task(t.id).snapshot).toHaveLength(1);restored.close();
 }finally{second?.close();s.close();rmSync(root,{recursive:true,force:true});}
});

