import { createHash } from 'node:crypto';
export type VersionScope = { caseId:string; evidenceId:string; version:number };
export type IndexedSegment = VersionScope & {id:string;content:string;start:number;end:number;kind:string;source:string;page:number|null;messageId:string|null};
export type EvidenceInput = VersionScope & {content:string;kind:string;source?:string;anchors?:{start:number;end:number;page?:number;messageId?:string}[]};
/** Offsets refer to the supplied canonical original, in UTF-16 half-open units. */
export function segmentEvidence(input:EvidenceInput,maxChars=1200):IndexedSegment[] {
 if(!Number.isInteger(maxChars)||maxChars<2||maxChars>10000)throw Error('Invalid segment size');
 if(!input.caseId||!input.evidenceId||!Number.isInteger(input.version)||input.version<1)throw Error('Invalid version identity');
 if(input.kind==='image')return []; // No invented OCR, text offsets or regions.
 const anchors=input.anchors??Array.from(input.content.matchAll(/[^\r\n]+(?:\r?\n|$)/g),m=>({start:m.index!,end:m.index!+m[0].length}));
 const result:IndexedSegment[]=[];let previousEnd=0;
 for(const anchor of anchors){
  if(!Number.isInteger(anchor.start)||!Number.isInteger(anchor.end)||anchor.start<previousEnd||anchor.end<=anchor.start||anchor.end>input.content.length)throw Error('Invalid original anchor');
  if('page' in anchor && (!Number.isInteger(anchor.page)||Number(anchor.page)<1))throw Error('Invalid page');
  previousEnd=anchor.end;
  for(let start=anchor.start;start<anchor.end;){let end=Math.min(start+maxChars,anchor.end);
   if(end<anchor.end&&/[\uD800-\uDBFF]/.test(input.content[end-1]))end--;
   const id=createHash('sha256').update(JSON.stringify([input.caseId,input.evidenceId,input.version,start,end])).digest('hex');
   result.push({id,caseId:input.caseId,evidenceId:input.evidenceId,version:input.version,content:input.content.slice(start,end),start,end,kind:input.kind,source:input.source??'',page:'page' in anchor?Number(anchor.page):null,messageId:'messageId' in anchor?String(anchor.messageId):null});start=end;
  }
 }
 return result;
}
