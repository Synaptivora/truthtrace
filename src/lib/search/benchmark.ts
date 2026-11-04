import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { EvidenceIndex } from './index';
import { segmentEvidence } from '../evidence-index/segments';
for(const count of [100,1000,10000]){
 const db=new DatabaseSync(':memory:');const index=new EvidenceIndex(db);const scope={caseId:'fictional',evidenceId:'synthetic',version:1};
 const content=Array.from({length:count},(_,i)=>`虚构消息${i}：${i%10===0?'退款尚未到账':'约定下周交货'}，金额100元。`).join('\n');
 const start=performance.now();index.replaceVersion(scope,segmentEvidence({...scope,kind:'chat',content}));const buildMs=performance.now()-start;
 const times:number[]=[];for(let n=0;n<30;n++){const start=performance.now();index.search('未到账',{authorizedVersions:[scope]});times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);console.log(JSON.stringify({count,buildMs,queryP50Ms:times[15],queryP95Ms:times[28],rssBytes:process.memoryUsage().rss,storage:'memory',dataset:'synthetic-search-v1',realModel:false}));db.close();
}
