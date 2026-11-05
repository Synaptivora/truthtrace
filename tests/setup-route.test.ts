import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../scripts/setup.mjs", () => ({
  detect: vi.fn(async () => ({ ready: true })),
  runSetup: vi.fn(), actionDingtalkLogin: vi.fn(), actionCaptureWechatKey: vi.fn(),
}));
vi.mock("@/lib/ingestion/service",()=>({ensureIngestion:vi.fn(async()=>{})}));
import { GET, POST } from "../src/app/api/setup/route";
import { detect, runSetup, actionDingtalkLogin } from "../scripts/setup.mjs";

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv("TRUTHTRACE_MACHINE_TOKEN","t".repeat(64)); });
function request(host = "localhost:3000", extra = {}, body?: string) {
  return new Request(`http://${host}/api/setup`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host, authorization:`Bearer ${"t".repeat(64)}`, ...extra }, body,
  });
}
it("rejects remote hosts and cross-origin reads before detection", async () => {
  for (const req of [request("example.com"), request("localhost:3000", { origin: "https://evil.example" })]) {
    expect((await GET(req)).status).toBe(403);
  }
  expect(detect).not.toHaveBeenCalled();
});
it("supports IPv6 loopback", async () => {
  expect((await GET(request("[::1]:3000"))).status).toBe(200);
});
it("accepts a real loopback Origin when Next internally uses localhost",async()=>{
  const req=new Request("http://localhost:3000/api/setup",{headers:{authorization:`Bearer ${"t".repeat(64)}`,host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000"}});
  expect((await GET(req)).status).toBe(200);
  expect((await GET(new Request("http://localhost:3000/api/setup",{headers:{authorization:`Bearer ${"t".repeat(64)}`,host:"127.0.0.1:3000",origin:"http://localhost:3000"}}))).status).toBe(403);
});
it("disables reads and writes with the configuration switch", async () => {
  vi.stubEnv("SYNAPSE_SETUP_ENABLED", "0");
  expect((await GET(request())).status).toBe(403);
  expect((await POST(request("localhost:3000", {}, '{"action":"install"}'))).status).toBe(403);
});
it("never installs on malformed or missing action", async () => {
  for (const body of ["null", "{}", "broken", '{"action":"unknown"}']) {
    expect((await POST(request("localhost:3000", {}, body))).status).toBe(400);
  }
  expect(runSetup).not.toHaveBeenCalled();
});
it("rejects cross-site writes", async () => {
  expect((await POST(request("localhost:3000", { "sec-fetch-site": "cross-site" }, '{"action":"install"}'))).status).toBe(403);
  expect(runSetup).not.toHaveBeenCalled();
});
it("does not expose raw setup job logs, paths or exceptions",async()=>{
 const state=globalThis as typeof globalThis & {__ttSetupJobs:Map<string,unknown>};
 state.__ttSetupJobs.set('test-private-job',{id:'test-private-job',action:'install',status:'failed',steps:[{id:'private-secret',label:'private-secret',detail:'C:/private-secret',status:'failed'}],lines:['private-secret'],startedAt:1,note:'private-secret',error:'private-secret'});
 try{const response=await GET(new Request('http://localhost:3000/api/setup?job=test-private-job',{headers:{host:'localhost:3000',authorization:`Bearer ${'t'.repeat(64)}`}}));
 expect(response.status).toBe(200);const data=await response.json();expect(data.status).toBe('failed');expect(data.steps).toHaveLength(1);expect(JSON.stringify(data)).not.toContain('private-secret');
 }finally{state.__ttSetupJobs.delete('test-private-job');}
});
it('returns structured device URL for the existing QR flow, never arbitrary logs',async()=>{
 const state=globalThis as typeof globalThis & {__ttSetupJobs:Map<string,unknown>};
 const authUrl='https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST';
 state.__ttSetupJobs.set('auth-fixture',{id:'auth-fixture',action:'install',status:'running',steps:[],lines:['private-token',authUrl],startedAt:1});
 try{const response=await GET(new Request('http://localhost:3000/api/setup?job=auth-fixture',{headers:{host:'localhost:3000',authorization:`Bearer ${'t'.repeat(64)}`}}));const data=await response.json();expect(data.authUrl).toBe(authUrl);expect(JSON.stringify(data.lines)).not.toContain('private-token');}
 finally{state.__ttSetupJobs.delete('auth-fixture');}
});

async function installAndWait() {
 const response = await POST(request("localhost:3000", {}, '{"action":"install"}'));
 expect(response.status).toBe(200);
 const { jobId } = await response.json();
 const state=globalThis as typeof globalThis & {__ttSetupJobs:Map<string,{status:string}>};
 await vi.waitFor(()=>expect(state.__ttSetupJobs.get(jobId)?.status).not.toBe('running'));
 return state.__ttSetupJobs.get(jobId);
}
it('one-click setup starts the service and skips login for a valid account', async()=>{
 vi.mocked(runSetup).mockResolvedValue({status:'ok',after:{ready:true,checks:{dws:{ok:true}}}} as Awaited<ReturnType<typeof runSetup>>);
 expect((await installAndWait())?.status).toBe('ok');
 const {ensureIngestion}=await import('@/lib/ingestion/service');
 expect(ensureIngestion).toHaveBeenCalledOnce();
 expect(actionDingtalkLogin).not.toHaveBeenCalled();
});
it('one-click setup continues to device authorization when needed',async()=>{
 vi.mocked(runSetup).mockResolvedValue({status:'ok',after:{ready:true,checks:{dws:{ok:false}}}} as Awaited<ReturnType<typeof runSetup>>);
 vi.mocked(actionDingtalkLogin).mockResolvedValue({ok:true,output:'',note:''});
 expect((await installAndWait())?.status).toBe('ok');
 expect(actionDingtalkLogin).toHaveBeenCalledOnce();
});
it('cancelled authorization is not reported as configured',async()=>{
 vi.mocked(runSetup).mockResolvedValue({status:'ok',after:{ready:true,checks:{dws:{ok:false}}}} as Awaited<ReturnType<typeof runSetup>>);
 vi.mocked(actionDingtalkLogin).mockResolvedValue({ok:false,output:'',note:''});
 expect((await installAndWait())?.status).toBe('failed');
});
it('failed installation does not initiate authorization',async()=>{
 vi.mocked(runSetup).mockResolvedValue({status:'failed',after:{ready:false}} as Awaited<ReturnType<typeof runSetup>>);
 expect((await installAndWait())?.status).toBe('failed');
 expect(actionDingtalkLogin).not.toHaveBeenCalled();
});
