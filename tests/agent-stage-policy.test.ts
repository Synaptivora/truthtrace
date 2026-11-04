import {describe,it,expect} from "vitest";
import {validateStageCall,investigationTools} from "../src/lib/investigator/runtime";
describe("server stage policy",()=>{
 it("rejects tools not offered in plan or forced submission",()=>{
  expect(()=>validateStageCall(0,"read_evidence",{segmentId:"s"})).toThrow();
  expect(()=>validateStageCall(2,"read_evidence",{segmentId:"s"},true)).toThrow();
  expect(()=>validateStageCall(2,"unknown",{})).toThrow();
 });
 it("validates compatibility submission with the same strict fields",()=>{
  for(const name of ["update_plan","submit_artifact"]){
   expect(()=>validateStageCall(0,name,{summary:"plan",plan:["read"]})).not.toThrow();
   for(const field of ["claims","checks","answer"])
    expect(()=>validateStageCall(0,name,{summary:"plan",[field]:[]})).toThrow();
  }
 });
 it("rejects cross-stage named tools and nested injection fields",()=>{
  expect(()=>validateStageCall(2,"finalize_investigation",{summary:"x"})).toThrow();
  expect(()=>validateStageCall(2,"extract_claims",{summary:"x",claims:[{id:"c",content:"x",kind:"statement",refs:[{evidenceId:"e",version:1,segmentId:"s",quote:"x",caseId:"other"}]}]})).toThrow();
  expect(()=>validateStageCall(2,"read_evidence",{segmentId:"s",caseId:"other"})).toThrow();
 });
 it("advertises all eight stage-specific submission schemas",()=>{
  for(let stage=0;stage<8;stage++){
   const tool=investigationTools(stage,true)[0];
   expect(()=>validateStageCall(stage,tool.name,{summary:"x"})).not.toThrow();
   expect(tool.parameters.additionalProperties).toBe(false);
  }
 });
});
