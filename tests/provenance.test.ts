import {describe,it,expect} from "vitest";
import {EvidenceRefSchema,EvidenceSchema} from "../src/lib/contracts";
import {createEvidenceRef,validateEvidenceRef,type EvidenceContext} from "../src/lib/evidence/provenance";
import {analysisSources,resolveAnalysisSources} from "../src/lib/ai/shared-model";
import {makeTools} from "../src/lib/agent/runner";
const evidence={id:"e",name:"chat",kind:"text" as const,mimeType:"text/plain",content:"重复\r\n\r\n重复\n尾部"};
const context:EvidenceContext={caseId:"c",evidence:[evidence],segments:[{id:"s",evidenceId:"e",version:2,start:0,end:evidence.content.length,content:evidence.content,kind:"text"}]};
describe("versioned provenance",()=>{
 it("preserves CRLF blank lines and duplicate quote offsets",()=>{const sources=analysisSources([evidence],context);expect(sources.map(s=>s.start)).toEqual([0,6,9]);for(const s of sources)expect(evidence.content.slice(s.start,s.end)).toBe(s.quote);expect(sources[1].ref.provenance).toMatchObject({version:2,caseId:"c",locator:{start:6,end:8}});});
 it("keeps legacy refs unresolved without inventing identity",()=>{const ref=validateEvidenceRef({evidenceId:"e",quote:"重复",locator:"R1"},[evidence]);expect(ref.provenance).toBeUndefined();expect(ref.citationValidation).toBe("legacy_unresolved");expect(EvidenceSchema.parse({...evidence,version:3}).version).toBe(3);});
 it("rejects cross-case version offset and text tampering",()=>{const ref=createEvidenceRef(evidence,6,8,context);expect(validateEvidenceRef(ref,[evidence],context).citationValidation).toBe("validated");for(const patch of [{caseId:"other"},{version:3},{segmentId:"other"},{locator:{type:"text_range",start:8,end:10}}])expect(()=>validateEvidenceRef({...ref,provenance:{...ref.provenance,...patch}},[evidence],context)).toThrow();expect(()=>validateEvidenceRef({...ref,quote:"捏造"},[evidence],context)).toThrow();expect(()=>validateEvidenceRef(ref,[evidence])).toThrow();});
 it("rejects unknown critical fields rather than stripping",()=>{expect(()=>EvidenceRefSchema.parse({evidenceId:"e",quote:"重复",version:9})).toThrow();expect(()=>resolveAnalysisSources({people:[{evidenceRefs:[{sourceId:"R1",evidenceId:"fake"}]}]},analysisSources([evidence]))).toThrow();});
 it("does not certify image quotes as exact text",()=>{const image={...evidence,kind:"image" as const,content:"data:image/png;base64,aA=="};const imageContext={...context,evidence:[image],segments:[{...context.segments[0],kind:"image",content:image.content,end:image.content.length}]};const ref=createEvidenceRef(image,0,image.content.length,imageContext);expect(ref.citationValidation).toBe("visual_unverified");expect(ref.provenance?.verificationMethod).toBe("visual_unverified");});
 it("retains multiple read ranges and reports unread coverage",()=>{const long={...evidence,content:"a".repeat(12001)};const ctx={...context,evidence:[long],segments:[{...context.segments[0],content:long.content,end:long.content.length}]};const tools=makeTools({mode:"demo",allowImages:false,evidence:[long],messages:[{role:"user",content:"read"}]},ctx);tools.execute("read_evidence",{id:"E1",offset:0});tools.execute("read_evidence",{id:"E1",offset:6000});expect(tools.seen.get("E1")?.refs).toHaveLength(2);expect(tools.coverage().truncated).toBe(true);tools.execute("read_evidence",{id:"E1",offset:12000});expect(tools.coverage().truncated).toBe(false);});
});
it("searches Chinese alternatives within trusted versions without marking hits read",()=>{
 const e={...evidence,content:"昨天说退钱，今天仍未入账。"};const ctx={...context,evidence:[e],segments:[{...context.segments[0],content:e.content,end:e.content.length}]};
 const tools=makeTools({mode:"demo",allowImages:false,evidence:[e],messages:[{role:"user",content:"退款"}]},ctx);
 const found=tools.execute("search_evidence",{query:"退款"}) as {hits:{id:string;offset:number}[];queries:string[]};expect(found.hits).toHaveLength(1);expect(found.queries).toContain("退钱");expect(tools.seen.size).toBe(0);
 tools.execute("read_evidence",{id:found.hits[0].id,offset:found.hits[0].offset});expect(tools.seen.get("E1")?.refs?.[0].provenance?.version).toBe(2);
 expect(()=>tools.execute("case_overview",{caseId:"foreign"})).toThrow();
});
it("keeps temporary search identities out of persistent citations",()=>{
 const tools=makeTools({mode:"demo",allowImages:false,evidence:[{...evidence,content:"退钱"}],messages:[{role:"user",content:"退款"}]});const found=tools.execute("search_evidence",{query:"退款"}) as {hits:{id:string;offset:number}[]};expect(found.hits).toHaveLength(1);tools.execute("read_evidence",{id:found.hits[0].id,offset:found.hits[0].offset});expect(tools.seen.get("E1")?.refs?.[0].provenance).toBeUndefined();
});
