import { describe, expect, it } from "vitest";
import { createRuleAnalysis } from "@/lib/ai/rule";
import type { Evidence } from "@/lib/contracts";

const chat = (content: string, name = "测试群 · 2026-10-31~11-02（6 条）"): Evidence => ({
  id: "e-chat",
  name,
  kind: "chat",
  mimeType: "text/plain",
  content,
  source: "微信",
});

const lines = [
  "[2026-10-31 21:52:53] 张三: 我们明天把方案交给老师",
  "[2026-10-31 21:53:01] 李四: ok，我来整理统计表",
  "[2026-10-31 21:53:30] 王五: 转账 ¥2000 已经付了定金",
  "[2026-10-31 22:38:03] 张三: [图片@2026-10-31 22:38:03: 图片 2026-10-31 22.38.03.jpg 见独立证据]",
  "[2026-10-31 22:39:34] 李四: 这个截图我确认了",
  "[2026-10-31 23:10:00] 群成员: 有人 @我",
].join("\n");

describe("本地规则分析", () => {
  it("从聊天正文里识别出发言人，并过滤「群成员」这类无效发送人", () => {
    const result = createRuleAnalysis([chat(lines)]);
    expect(result.analysisMode).toBe("rule");
    const names = result.people.map(person => person.name).sort();
    expect(names).toEqual(["张三", "李四", "王五"].sort());
    expect(result.people.every(person => person.evidenceRefs.length > 0)).toBe(true);
  });

  it("产出时间片段，但不把同群发言当作人物关系", () => {
    const result = createRuleAnalysis([chat(lines)]);
    expect(result.relationships).toEqual([]);
    expect(result.events.length).toBeGreaterThan(0);
    const peopleIds = new Set(result.people.map(person => person.id));
    for (const relation of result.relationships) {
      expect(peopleIds.has(relation.sourcePersonId)).toBe(true);
      expect(peopleIds.has(relation.targetPersonId)).toBe(true);
    }
    for (const event of result.events) {
      for (const id of event.participantIds) expect(peopleIds.has(id)).toBe(true);
    }
  });

  it("识别「我明天…」「我来…」这类承诺并标出期限线索", () => {
    const result = createRuleAnalysis([chat(lines)]);
    expect(result.commitments.length).toBeGreaterThan(0);
    expect(result.commitments.some(item => item.dueLabel.includes("明天"))).toBe(true);
  });

  it("不编造矛盾：规则模式下列表为空", () => {
    const result = createRuleAnalysis([chat(lines)]);
    expect(result.contradictions).toEqual([]);
  });

  it("纯图片/无对话材料不会崩，并给出「未识别出发言人」缺口", () => {
    const image: Evidence = {
      id: "e-img", name: "图片.jpg", kind: "image",
      mimeType: "image/jpeg", content: "data:image/jpeg;base64,AAA",
    };
    const result = createRuleAnalysis([image]);
    expect(result.people).toEqual([]);
    expect(result.evidenceGaps.some(gap => gap.id === "rule-gap-people")).toBe(true);
  });

  it("群名被误当发送人时不会变成人物", () => {
    const withTitle = [
      "[2026-10-31 21:52:33] Synapse-黑客松: [系统消息]",
      "[2026-10-31 21:53:01] 张三: 收到",
    ].join("\n");
    const result = createRuleAnalysis([chat(withTitle, "Synapse-黑客松 · 2026-10-31~11-02（2 条）")]);
    expect(result.people.map(person => person.name)).toEqual(["张三"]);
  });
});
