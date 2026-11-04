import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '@/lib/investigator/store';
import {DatabaseSync} from 'node:sqlite';
const analysis={caseTitle:'fixture',summary:'fixture',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
it('migrates legacy inline snapshots idempotently',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-migrate-'));let s=new Store(dir);s.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'e',kind:'text',mimeType:'text/plain',content:'old'}]});const task=s.createTask('a',{goal:'fixture',idempotencyKey:'one'});s.close();
 const db=new DatabaseSync(join(dir,'cases.sqlite'));db.prepare('UPDATE tasks SET body=?').run(JSON.stringify({...task,schemaVersion:undefined,snapshotId:undefined}));db.exec('PRAGMA user_version=0');db.close();
 try{for(let i=0;i<2;i++){s=new Store(dir);expect(s.task(task.id).snapshot[0].content).toBe('old');expect(s.task(task.id).schemaVersion).toBe(2);s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
it.each([100,1000,10000])('benchmarks %i segments with bounded heartbeat writes',count=>{
 const dir=mkdtempSync(join(tmpdir(),'tt-pressure-'));const s=new Store(dir);try{
 s.saveCase({caseId:'a',analysis,evidence:[{id:'e',name:'e',kind:'text',mimeType:'text/plain',content:'x'.repeat(4000*count)}]});
 const start=performance.now();s.createTask('a',{goal:'fixture',idempotencyKey:'one'});const task=s.claim('worker')!;const buildMs=performance.now()-start;const wal=join(dir,'cases.sqlite-wal');const before=statSync(wal).size;const timings=[];
 for(let i=0;i<30;i++){const t=performance.now();expect(s.renewLease(s.lease(task),Date.now(),1)).toBe(true);timings.push(performance.now()-t);}timings.sort((a,b)=>a-b);
 const listStart=performance.now();const summaries=s.taskSummaries('a');const listMs=performance.now()-listStart;expect(JSON.stringify(summaries).length).toBeLessThan(2000);console.log(JSON.stringify({segments:count,buildMs,heartbeatP50:timings[15],heartbeatP95:timings[28],walGrowth:statSync(wal).size-before,listMs,rss:process.memoryUsage().rss}));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
},30000);
