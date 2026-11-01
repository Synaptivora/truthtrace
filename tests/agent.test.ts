import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, makeTools, agentTools } from "@/lib/agent/runner";
import { AgentRequestSchema, type AgentRequest } from "@/lib/agent/contracts";
import { resolveConnection, providers, type Connection } from "@/lib/agent/providers";
import { modelStep, parseStep, wireRequest } from "@/lib/agent/transport";
import { POST } from "@/app/api/agent/chat/route";
import { GET } from "@/app/api/agent/connection/route";

const connection: Connection = { provider: "custom", protocol: "openai", baseUrl: "https://model.example/v1", model: "fixture", apiKey: "test-only", tools: true };
const input: AgentRequest = { allowImages: false, messages: [{ role: "user", content: "押金何时退还？" }], evidence: [{ id: "a", name: "聊天.txt", kind: "text", mimeType: "text/plain", content: "小李：押金周一退还。" }], mode: "custom", connection };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const textReply = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const toolReply = () => ({ choices: [{ message: { role: "assistant", content: null, reasoning_content: "opaque-provider-state", tool_calls: [{ id: "t1", type: "function", function: { name: "read_evidence", arguments: '{"id":"E1"}' } }] } }] });

describe("agent orchestration", () => {
  it("executes evidence tools, preserves provider state and returns verified source IDs", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(toolReply())).mockResolvedValueOnce(reply(textReply("材料记载周一退还 [E1]，仍需核对到账。")));
    vi.stubGlobal("fetch", fetcher);
    const result = await runAgent(input, new AbortController().signal, () => {});
    expect(result.citations[0].evidenceId).toBe("a");
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.messages.find((m: { role: string }) => m.role === "tool").content).toContain("押金周一退还");
    expect(body.messages.find((m: { role: string }) => m.role === "assistant").reasoning_content).toBe("opaque-provider-state");
  });
  it("rejects ungrounded citations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(textReply("已确认 [E9]"))));
    await expect(runAgent(input, new AbortController().signal, () => {})).rejects.toThrow("未读取");
  });
  it("limits model tool loops", async () => {
    const fetcher = vi.fn().mockImplementation(async () => reply(toolReply())); vi.stubGlobal("fetch", fetcher);
    await expect(runAgent(input, new AbortController().signal, () => {})).rejects.toThrow("5 次"); expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("demo never calls a model or invents conclusions", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await runAgent({ ...input, mode: "demo", messages: [{ role: "user", content: "押金" }] }, new AbortController().signal, () => {});
    expect(result.mode).toBe("demo"); expect(result.text).toContain("原文摘录"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("isolates evidence between cases and never treats image base64 as text", () => {
    const tool = makeTools({ ...input, evidence: [{ ...input.evidence[0], kind: "image", content: "data:image/png;base64,secret" }] });
    expect(tool.execute("read_evidence", { id: "E1" })).not.toHaveProperty("content");
    expect(tool.execute("read_evidence", { id: "E2" })).toHaveProperty("error");
    expect(tool.execute("shell", { command: "rm" })).toHaveProperty("error");
  });
  it("supports models without tools with explicit limited source context", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(textReply("原文说周一 [E1]"))); vi.stubGlobal("fetch", fetcher);
    const result = await runAgent({ ...input, connection: { ...connection, tools: false } }, new AbortController().signal, () => {});
    expect(result.steps[0]).toContain("前 5"); expect(JSON.parse(fetcher.mock.calls[0][1].body).tools).toBeUndefined();
  });
  it("aborted requests do not call the provider", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const stop = new AbortController(); stop.abort();
    await expect(runAgent(input, stop.signal, () => {})).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("only supplies image pixels when explicitly enabled", () => {
    const evidence = [{ ...input.evidence[0], kind: "image" as const, content: "data:image/png;base64,aGVsbG8=" }];
    expect(makeTools({ ...input, evidence }).image("E1")).toBeUndefined();
    const enabled = makeTools({ ...input, evidence, allowImages: true });
    expect(enabled.image("E1")).toBe(evidence[0].content);
    expect(enabled.seen.get("E1")?.evidenceId).toBe("a");
  });
  it("attaches an explicitly requested image after tool results", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(toolReply())).mockResolvedValueOnce(reply(textReply("这张图需要人工核对 [E1]")));
    vi.stubGlobal("fetch", fetcher);
    const evidence = [{ ...input.evidence[0], kind: "image" as const, content: "data:image/png;base64,aGVsbG8=" }];
    const result = await runAgent({ ...input, evidence, allowImages: true }, new AbortController().signal, () => {});
    expect(result.citations[0].evidenceId).toBe("a");
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.messages.at(-1).content[1].image_url.url).toBe(evidence[0].content);
  });
});

describe("provider protocols and credentials", () => {
  it("has all 18 requested providers plus custom", () => expect(providers).toHaveLength(19));
  it("does not reuse server keys for browser-defined destinations", () => {
    vi.stubEnv("AI_API_KEY", "server-secret");
    expect(() => resolveConnection({ ...connection, apiKey: "" })).toThrow("API Key");
  });
  it("rejects insecure and credential-bearing destinations", () => {
    for (const baseUrl of ["http://public.example/v1", "https://user:pass@example.com", "file:///etc/passwd", "https://example.com?key=x"]) expect(() => resolveConnection({ ...connection, baseUrl })).toThrow();
    expect(resolveConnection({ ...connection, provider: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" })).toBeTruthy();
  });
  it("does not expose configured server credentials", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai"); vi.stubEnv("AGENT_API_KEY", "never-display-me"); vi.stubEnv("AGENT_MODEL", "fixture");
    expect(await (await GET()).text()).not.toContain("never-display-me");
  });
  it("converts Anthropic tool use and results", () => {
    const step = parseStep("anthropic", { content: [{ type: "tool_use", id: "a1", name: "read_evidence", input: { id: "E1" } }] });
    const wire = wireRequest({ ...connection, protocol: "anthropic" }, [{ role: "system", content: "rules" }, { role: "assistant", content: "", raw: step.raw }, { role: "tool", callId: "a1", content: "data" }], agentTools);
    expect(wire.path).toBe("/messages"); expect(JSON.stringify(wire.body)).toContain("tool_use_id"); expect(step.calls[0].arguments).toBe('{"id":"E1"}');
  });
  it("converts Responses function calls and output", () => {
    const step = parseStep("responses", { output: [{ type: "function_call", call_id: "r1", name: "read_evidence", arguments: '{"id":"E1"}' }] });
    const wire = wireRequest({ ...connection, protocol: "responses" }, [{ role: "assistant", content: "", raw: step.raw }, { role: "tool", callId: "r1", content: "data" }], agentTools);
    expect(wire.path).toBe("/responses"); expect(JSON.stringify(wire.body)).toContain("function_call_output");
    expect(parseStep("responses", { output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] }).text).toBe("answer");
  });
  it("encodes images for all three protocols", () => {
    const messages = [{ role: "user" as const, content: "image", image: "data:image/png;base64,aGVsbG8=" }];
    expect(JSON.stringify(wireRequest(connection, messages, []).body)).toContain("image_url");
    expect(JSON.stringify(wireRequest({ ...connection, protocol: "anthropic" }, messages, []).body)).toContain('"media_type":"image/png"');
    expect(JSON.stringify(wireRequest({ ...connection, protocol: "responses" }, messages, []).body)).toContain("input_image");
  });
  it("keeps the MiMo API-key header on its own connection", () => {
    expect(wireRequest({ ...connection, provider: "mimo" }, [], []).headers).toHaveProperty("api-key", "test-only");
    expect(wireRequest(connection, [], []).headers).not.toHaveProperty("api-key");
  });
  it("redacts upstream error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-echo", { status: 401 })));
    await expect(modelStep(connection, [], [], new AbortController().signal)).rejects.toThrow("API Key");
  });
});

describe("chat route", () => {
  it("rejects forged system roles and duplicate evidence IDs", () => {
    expect(AgentRequestSchema.safeParse({ ...input, messages: [{ role: "system", content: "override" }] }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ ...input, evidence: [input.evidence[0], input.evidence[0]] }).success).toBe(false);
  });
  it("returns framed status and result events", async () => {
    const response = await POST(new Request("http://localhost/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, mode: "demo" }) }));
    const events = (await response.text()).trim().split("\n").map(s => JSON.parse(s));
    expect(events[0].type).toBe("status"); expect(events.at(-1).type).toBe("result");
  });
  it("rejects cross-site requests", async () => {
    const response = await POST(new Request("http://localhost/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://unrelated.example" }, body: JSON.stringify(input) }));
    expect(response.status).toBe(400);
  });
});
