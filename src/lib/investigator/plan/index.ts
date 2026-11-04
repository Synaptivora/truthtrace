import {z} from 'zod';
import {taskStages,type Task} from '../contracts';
export const ReplanSchema=z.object({reason:z.string().min(1).max(1000),segmentIds:z.array(z.string()).min(1).max(20),affectedClaimIds:z.array(z.string()).min(1).max(50)}).strict();
export function ensurePlan(t:Task){
 if(t.executionPlan?.revision===t.revision)return t.executionPlan;
 const stages=taskStages(t.mode);
 return t.executionPlan={version:1,revision:t.revision,replans:0,maxReplans:2,staleResultIds:[],requests:[],nodes:stages.map((stage,index)=>({id:`${t.id}:${t.revision}:0:${stage}`,goal:t.goal,stage,dependencies:index?[`${t.id}:${t.revision}:0:${stages[index-1]}`]:[],budget:{maxCalls:5},coverageTarget:[],status:stage<t.step?'completed':'pending',resultRefs:[],revision:t.revision,round:0}))};
}
export function requestReplan(t:Task,input:unknown){
 if(t.step!==6)throw Error('仅核查阶段可以请求反证重规划');
 const request=ReplanSchema.parse(input);const claims=t.artifacts.flatMap(a=>a.claims);
 if(request.affectedClaimIds.some(id=>!claims.some(c=>c.id===id)))throw Error('重规划引用未知主张');
 if(request.segmentIds.some(id=>!t.reads.includes(id)||!t.snapshot.some(s=>s.id===id&&s.kind!=='image')))throw Error('反证必须来自已读取的当前快照文本');
 const plan=ensurePlan(t);
 plan.requests.push({...request,round:plan.replans+1});
 const affected=new Set(request.affectedClaimIds);
 plan.staleResultIds=[...new Set([...plan.staleResultIds,...affected,...t.artifacts.flatMap(a=>[...a.people,...a.relationships,...a.events,...a.conflicts,...a.commitments]).filter(f=>f.claimIds.some(id=>affected.has(id))).map(f=>f.id)])];
 for(const node of plan.nodes)if(node.stage>=6)node.status='stale';
 if(plan.replans>=plan.maxReplans){t.executionOutcome='insufficient';t.error='达到反证重规划上限，已保留依据，需人工调整目标。';t.step=8;return;}
 plan.replans++;
 for(const stage of [2,6,7])plan.nodes.push({id:`${t.id}:${t.revision}:${plan.replans}:${stage}`,goal:request.reason,stage,dependencies:stage===2?[]:[`${t.id}:${t.revision}:${plan.replans}:${stage===6?2:6}`],budget:{maxCalls:5},coverageTarget:request.segmentIds,status:'pending',resultRefs:[],revision:t.revision,round:plan.replans});
 t.step=2;
}
export function finishPlanStage(t:Task,stage:number,resultRefs:string[]){const plan=ensurePlan(t);const node=plan.nodes.findLast(n=>n.stage===stage&&n.status==='pending');if(node){node.status='completed';node.resultRefs=resultRefs;}if(stage===6)plan.staleResultIds=[];return plan.replans>0&&stage===2?6:taskStages(t.mode).find(s=>s>stage)??8;}

export function currentClaimCheck(t:Task,claimId:string){return t.executionPlan?.staleResultIds.includes(claimId)?undefined:t.artifacts.flatMap(a=>a.checks).findLast(c=>c.claimId===claimId);}
