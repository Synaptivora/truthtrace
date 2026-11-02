import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceContent, parseChatTranscript } from "./evidence-content";
import { analysisReport } from "./case-view";
import type { CaseAnalysis } from "./api-client";
import type { Evidence } from "@/lib/contracts";

describe("聊天原文展示衔接", () => {
  it("保留消息顺序、正文换行、空行和正文中的冒号", () => {
    const content = "会话：测试群\n[2026-11-02 09:10:00] 张同学: 流水号: ABC\n第二行\n\n[2026-11-02 09:12:00] 李老师: 请看原件 https://example.com/a:b";
    const blocks = parseChatTranscript(content);
    expect(blocks).toEqual([
      { type: "text", text: "会话：测试群" },
      { type: "message", stamp: "2026-11-02 09:10:00", sender: "张同学", text: "流水号: ABC\n第二行\n" },
      { type: "message", stamp: "2026-11-02 09:12:00", sender: "李老师", text: "请看原件 https://example.com/a:b" },
    ]);
  });
  it("不认识的聊天格式保留原文，不猜测发言人或时间", () => {
    const content = "张三说：原样保留 [图片]\n时间不详";
    expect(parseChatTranscript(content)).toEqual([{ type: "text", text: content }]);
  });
  it("图片标记显示缩略图与原件入口；原始内容不变", () => {
    const item: Evidence = { id: "chat", name: "虚构聊天", kind: "chat", mimeType: "text/plain", content: "[2026-11-02 09:10:00] 张同学: [图片@2026-11-02 09:10:00: 凭证.png 见独立证据]" };
    const image: Evidence = { id: "picture", name: "凭证.png", kind: "image", mimeType: "image/png", content: "data:image/png;base64,AAAA" };
    const original = item.content;
    const html = renderToStaticMarkup(createElement(EvidenceContent, { item, all: [item, image], onOpen: () => {} }));
    expect(html).toContain('alt="凭证.png"');
    expect(html).toContain("has-thumbnail");
    expect(html).not.toContain("disabled");
    expect(item.content).toBe(original);
  });
  it("规则分析报告不标成模型整理", () => {
    const result: CaseAnalysis = { evidence: [], analysis: { analysisMode: "rule", generatedAt: "2026-11-02", caseTitle: "规则测试", summary: "仅统计材料", people: [], relationships: [], events: [], contradictions: [], commitments: [], evidenceGaps: [] } };
    const report = analysisReport(result, {});
    expect(report).toContain("规则整理");
    expect(report).not.toContain("模型整理");
  });
});

it("Windows 换行不会把后一条消息并入前一位发言人", () => {
  const blocks = parseChatTranscript("[2026-11-02 10:00:00] 张同学: 第一条\r\n[2026-11-02 10:01:00] 李老师: 第二条\r\n");
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toMatchObject({ type: "message", sender: "李老师", text: "第二条\n" });
});
