import { describe, expect, it } from "vitest";
import { analysisReport, mergeTimeline } from "./case-view";
import type { TimelineEvent } from "@/lib/contracts";
const event: TimelineEvent = { id: "a", title: "退款到账", description: "凭证记载到账。", occurredAt: "2026-10-31T17:35:00", timeLabel: "10月31日 17:35", timePrecision: "exact", participantIds: ["p1"], evidenceRefs: [{ evidenceId: "e1", quote: "17:35" }] };
describe("时间线合并与报告来源", () => {
  it("合并完全相同事件时保留全部来源且不修改输入", () => {
    const second = { ...event, id: "b", participantIds: ["p2"], evidenceRefs: [{ evidenceId: "e2", quote: "17:35" }] };
    const merged = mergeTimeline([event, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0].evidenceRefs.map(r => r.evidenceId)).toEqual(["e1", "e2"]);
    expect(merged[0].participantIds).toEqual(["p1", "p2"]);
    expect(event.evidenceRefs).toHaveLength(1);
  });
  it("保留不同说法或不同时间精度，未知时间排在最后", () => {
    expect(mergeTimeline([event, { ...event, id: "b", description: "对方称退款申请已提交。" }, { ...event, id: "c", timePrecision: "unknown", occurredAt: null }])).toHaveLength(3);
    expect(mergeTimeline([{ ...event, id: "c", occurredAt: null }, event])[0].id).toBe("a");
  });
  it("导出注明 Mock、证据来源和人工备注，不将疑点标为核实", () => {
    const text = analysisReport({ caseName: "测试案件", evidence: [{ id: "e1", kind: "text", name: "原件.txt", mimeType: "text/plain", content: "原文" }], analysis: { caseTitle: "测试", summary: "登记完成", analysisMode: "mock", generatedAt: "2026-11-02", people: [], relationships: [], events: [event], contradictions: [], commitments: [], evidenceGaps: [] } }, { e1: "应补充完整截图" });
    expect(text).toContain("模拟分析"); expect(text).toContain("[e1] 原件.txt"); expect(text).toContain("应补充完整截图"); expect(text).toContain("未经模型重分析");
  });
});
