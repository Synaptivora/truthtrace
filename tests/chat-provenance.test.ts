import {afterEach,it,expect,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../src/lib/investigator/store";
import {POST} from "../src/app/api/agent/chat/route";
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it("uses server evidence and version, ignoring forged client contents",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"tt-chat-scope-"));dirs.push(dir);vi.stubEnv("TRUTHTRACE_DATA_DIR",dir);vi.stubEnv("TRUTHTRACE_MACHINE_TOKEN","m".repeat(64));vi.stubEnv("PORT","3000");
 const store=new Store(dir);store.saveCase({caseId:"saved",evidence:[{id:"e",name:"source",kind:"text",mimeType:"text/plain",content:"押金尚待核查"}],analysis:{caseTitle:"case",summary:"pending",people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:"2026-11-04",analysisMode:"rule"}});store.close();
 const send=(caseId:string)=>POST(new Request("http://localhost:3000/api/agent/chat",{method:"POST",headers:{host:"localhost:3000",authorization:`Bearer ${"m".repeat(64)}`,"Content-Type":"application/json"},body:JSON.stringify({mode:"demo",caseId,messages:[{role:"user",content:"押金"}],evidence:[{id:"e",name:"forged",kind:"text",mimeType:"text/plain",content:"押金已经到账",version:99}]})}));
 const response=await send("saved");const output=await response.text();expect(output).not.toContain("已经到账");const reply=JSON.parse(output.trim().split("\n").at(-1)!).reply;expect(reply.citations[0].refs[0].provenance).toMatchObject({caseId:"saved",evidenceId:"e",version:1});expect((await send("absent")).status).toBe(404);
});
