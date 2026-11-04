import type { CaseAnalysis } from "../../components/truthtrace/api-client";
export function explicitDue(label:string):{dueAt:string|null;dueTimezone:string|null;duePrecision:"instant"|"unknown"} {
 const match=label.trim().match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/);
 if(!match||!Number.isFinite(Date.parse(match[0])))return {dueAt:null,dueTimezone:null,duePrecision:"unknown"};
 const day=match[0].slice(0,10),[y,m,d]=day.split("-").map(Number);
 if(new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)!==day)return {dueAt:null,dueTimezone:null,duePrecision:"unknown"};
 return {dueAt:new Date(match[0]).toISOString(),dueTimezone:match[1],duePrecision:"instant"};
}
export function commitmentProjection(c:CaseAnalysis,now=Date.now()) {
 return c.analysis.commitments.map(item=>{const due=explicitDue(item.dueLabel);return {schemaVersion:1 as const,id:item.id,caseId:c.caseId||null,caseName:c.caseName||c.analysis.caseTitle,personCandidateId:item.personId,text:item.commitment,dueLabel:item.dueLabel,...due,state:item.status,verificationStatus:"needs_review" as const,sourceRefs:item.evidenceRefs,revision:c.analysis.generatedAt,dueForReview:due.dueAt!==null&&Date.parse(due.dueAt)<=now&&item.status!=="fulfilled"};});
}
export type CommitmentProjection=ReturnType<typeof commitmentProjection>[number];
