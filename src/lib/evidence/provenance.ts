import { EvidenceRefSchema, type Evidence, type EvidenceRef } from "../contracts";
export type EvidenceContext={caseId:string;evidence:Evidence[];segments:{id:string;evidenceId:string;version:number;start:number;end:number;content:string;kind:string}[]};
// Context is server-owned, never deserialized from model/client JSON.
export function createEvidenceRef(e:Evidence,start:number,end:number,context?:EvidenceContext):EvidenceRef {
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>e.content.length)throw Error("引用范围无效");
  const image=e.kind==="image";
  const ref:EvidenceRef={evidenceId:e.id,quote:image?"图像识别未经逐字核验":e.content.slice(start,end),citationValidation:image?"visual_unverified":"legacy_unresolved"};
  if(!context)return ref;
  const original=context.evidence.find(x=>x.id===e.id);
  if(!original||original.content.slice(start,end)!==e.content.slice(start,end)||original.kind!==e.kind)throw Error("引用不属于授权原文");
  const segments=context.segments.filter(s=>s.evidenceId===e.id);
  const versions=new Set(segments.map(s=>s.version));
  if(versions.size!==1||!segments.length)throw Error("引用版本无法确定");
  const version=segments[0].version;
  if(!Number.isInteger(version)||version<1||e.version!==undefined&&e.version!==version)throw Error("引用版本不匹配");
  const segment=segments.find(s=>s.start<=start&&s.end>=end);
  ref.provenance={schemaVersion:2,caseId:context.caseId,evidenceId:e.id,version,segmentId:segment?.id??null,originalHash:original.originalHash??null,parserVersion:original.parserVersion??null,locator:image?{type:"whole_file"}:{type:"text_range",start,end},verificationMethod:image?"visual_unverified":"exact_text"};
  ref.citationValidation=image?"visual_unverified":"validated";
  return EvidenceRefSchema.parse(ref);
}
export function validateEvidenceRef(raw:unknown,evidence:Evidence[],context?:EvidenceContext):EvidenceRef {
 const ref=EvidenceRefSchema.parse(raw),e=evidence.find(e=>e.id===ref.evidenceId);
 if(!e)throw Error("引用了不存在的证据");
 if(ref.provenance){
  const p=ref.provenance;if(!context||p.caseId!==context.caseId||p.evidenceId!==ref.evidenceId)throw Error("引用案件身份无效");
  if(p.locator.type==="text_range"){
   if(e.kind==="image"||p.verificationMethod!=="exact_text")throw Error("图像不能作为逐字引用");
   const expected=createEvidenceRef(e,p.locator.start,p.locator.end,context);
   if(expected.quote!==ref.quote||expected.provenance?.version!==p.version||expected.provenance?.segmentId!==p.segmentId||expected.provenance?.originalHash!==p.originalHash||expected.provenance?.parserVersion!==p.parserVersion)throw Error("引用版本或范围不匹配");
   return {...ref,citationValidation:"validated"};
  }
  if(e.kind!=="image"||p.verificationMethod!=="visual_unverified")throw Error("引用定位方式无效");
  const expected=createEvidenceRef(e,0,e.content.length,context);
  if(JSON.stringify(expected.provenance)!==JSON.stringify(p))throw Error("图像引用身份不匹配");
  return {...ref,citationValidation:"visual_unverified"};
 }
 if(e.kind!=="image"&&!e.content.includes(ref.quote))throw Error("引用原文不存在于证据");
 return {...ref,citationValidation:e.kind==="image"?"visual_unverified":"legacy_unresolved"};
}
