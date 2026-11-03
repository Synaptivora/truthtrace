import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeFiles } from "./api-client";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

const source: Evidence = { id: "actual-upload-1", name: "我的材料.txt", kind: "text", mimeType: "text/plain", content: "这是一份与示例案件无关的材料。" };
const analysis: AnalysisResult = { caseTitle: "本地材料", summary: "仅登记材料。", analysisMode: "mock", generatedAt: "2026-11-01T00:00:00Z", people: [], relationships: [], events: [], contradictions: [], commitments: [], evidenceGaps: [] };
afterEach(() => { vi.unstubAllGlobals(); });

describe("C 与团队 API 的接入边界", () => {
  it("上传使用 files 字段，分析只提交接口返回的实际证据，不混入演示材料", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ evidence: [source] })).mockResolvedValueOnce(Response.json({ analysis }));
    vi.stubGlobal("fetch", request);
    const file = new File([source.content], source.name, { type: source.mimeType });
    const parsed = vi.fn();
    const result = await analyzeFiles([file], new AbortController().signal, parsed);
    const upload = request.mock.calls[0][1]?.body as FormData;
    expect(upload.getAll("files")).toHaveLength(1);
    expect(upload.has("file")).toBe(false);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ evidence: [source], allowFallback:true });
    expect(parsed).toHaveBeenCalledOnce();
    expect(result.evidence).toEqual([source]);
    expect(result.analysis.analysisMode).toBe("mock");
  });
  it("解析失败时保留服务错误，不继续调用分析接口", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "文件超过大小限制" }, { status: 422 }));
    vi.stubGlobal("fetch", request);
    await expect(analyzeFiles([new File(["x"], "x.txt")], new AbortController().signal, vi.fn())).rejects.toThrow("文件超过大小限制");
    expect(request).toHaveBeenCalledOnce();
  });
  it("无效的分析结构不能被当作完成结果展示", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ evidence: [source] })).mockResolvedValueOnce(Response.json({ analysis: { summary: "缺失来源和字段" } }));
    vi.stubGlobal("fetch", request);
    await expect(analyzeFiles([new File(["x"], "x.txt")], new AbortController().signal, vi.fn())).rejects.toThrow("分析结果未通过格式校验");
  });
});

it("补证时携带原有材料，碰撞 ID 重新编号，旧材料不被覆盖", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ evidence: [source] })).mockResolvedValueOnce(Response.json({ analysis }));
  vi.stubGlobal("fetch", request);
  const result = await analyzeFiles([new File(["新材料"], "new.txt")], new AbortController().signal, vi.fn(), [source]);
  expect(result.evidence).toHaveLength(2);
  expect(result.evidence[0]).toEqual(source);
  expect(result.evidence[1].id).not.toBe(source.id);
  expect(JSON.parse(String(request.mock.calls[1][1]?.body)).evidence).toEqual(result.evidence);
});
