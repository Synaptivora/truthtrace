import { describe,it,expect } from "vitest";
import { createServer } from "node:http";
import { publicModelAddress,secureModelRequest } from "../src/lib/agent/transport";
describe("model destination security",()=>{
 it("blocks nonpublic addresses",()=>{for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.0.1","192.168.1.1","::1","::ffff:127.0.0.1","fc00::1","2002:7f00:1::"])expect(publicModelAddress(ip)).toBe(false);expect(publicModelAddress("8.8.8.8")).toBe(true);});
 it("blocks private HTTPS",async()=>{await expect(secureModelRequest(new URL("https://127.0.0.1"),{},"",new AbortController().signal)).rejects.toThrow();});
 it("allows explicit local origins without redirecting",async()=>{let count=0;const server=createServer((_req,res)=>{count++;res.writeHead(302,{Location:"http://127.0.0.1:1/secret"});res.end("redirect");});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;const previous=process.env.TRUTHTRACE_MODEL_PRIVATE_ORIGINS;process.env.TRUTHTRACE_MODEL_PRIVATE_ORIGINS=origin;try{const response=await secureModelRequest(new URL(origin),{},"{}",new AbortController().signal);expect(response.status).toBe(302);expect(count).toBe(1);}finally{if(previous===undefined)delete process.env.TRUTHTRACE_MODEL_PRIVATE_ORIGINS;else process.env.TRUTHTRACE_MODEL_PRIVATE_ORIGINS=previous;await new Promise<void>(r=>server.close(()=>r()));}});
});

it("does not expose caller abort reasons",async()=>{const controller=new AbortController();controller.abort(new Error("private-secret"));await expect(secureModelRequest(new URL("https://example.com"),{},"",controller.signal)).rejects.toMatchObject({code:"MODEL_CANCELLED",retryable:false});});
