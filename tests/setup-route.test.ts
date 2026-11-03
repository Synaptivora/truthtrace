import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../scripts/setup.mjs", () => ({
  detect: vi.fn(async () => ({ ready: true })),
  runSetup: vi.fn(), actionDingtalkLogin: vi.fn(), actionCaptureWechatKey: vi.fn(),
}));
vi.mock("@/lib/ingestion/service",()=>({ensureIngestion:vi.fn(async()=>{})}));
import { GET, POST } from "../src/app/api/setup/route";
import { detect, runSetup } from "../scripts/setup.mjs";

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
function request(host = "localhost:3000", extra = {}, body?: string) {
  return new Request(`http://${host}/api/setup`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host, ...extra }, body,
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
  const req=new Request("http://localhost:3000/api/setup",{headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000"}});
  expect((await GET(req)).status).toBe(200);
  expect((await GET(new Request("http://localhost:3000/api/setup",{headers:{host:"127.0.0.1:3000",origin:"http://localhost:3000"}}))).status).toBe(403);
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
