import { describe, expect, it } from "vitest";
import { demoAnalysis, demoEvidence } from "@/lib/demo-case";
import { createMockAnalysis } from "@/lib/ai/mock";
import { validateAnalysis } from "@/lib/ai/validate";
import type { Evidence } from "@/lib/contracts";

describe("证据分析数据契约", () => {
  it("演示案件通过结构与证据引用校验", () => {
    const result = validateAnalysis(demoAnalysis, demoEvidence, "mock");
    expect(result.people).toHaveLength(3);
    expect(result.contradictions[0].evidenceRefs).toHaveLength(2);
  });

  it("拒绝模型编造不存在的证据 ID", () => {
    const invalid = structuredClone(demoAnalysis);
    invalid.people[0].evidenceRefs[0].evidenceId = "not-a-real-source";
    expect(() => validateAnalysis(invalid, demoEvidence, "model")).toThrow("不存在的证据");
  });

  it("拒绝关系图中不存在的人物 ID", () => {
    const invalid = structuredClone(demoAnalysis);
    invalid.relationships[0].targetPersonId = "missing-person";
    expect(() => validateAnalysis(invalid, demoEvidence, "model")).toThrow("不存在的人物");
  });

  it("非演示输入不会被替换为演示案件结论", async () => {
    const evidence: Evidence[] = [
      {
        id: "user-note",
        name: "用户材料.txt",
        kind: "text",
        mimeType: "text/plain",
        content: "这只是一段用于接口测试的文字。",
      },
    ];
    const result = await createMockAnalysis(evidence);
    expect(result.caseTitle).toContain("未启用真实模型");
    expect(result.contradictions).toHaveLength(0);
    expect(result.events[0].evidenceRefs[0].evidenceId).toBe("user-note");
  });
});
