import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelAnalysis, modelBudget, selectForModel } from "@/lib/ai/openai-compatible";
import type { Evidence } from "@/lib/contracts";

function text(id: string, chars = 10): Evidence {
  return { id, name: id, kind: "text", mimeType: "text/plain", content: "x".repeat(chars) };
}

/** 造一张「指定解码后字节数」的图片证据（base64 长度 ≈ 字节数 * 4/3）。 */
function image(id: string, bytes: number): Evidence {
  const len = Math.ceil((bytes * 4) / 3);
  return { id, name: id, kind: "image", mimeType: "image/jpeg", content: `data:image/jpeg;base64,${"A".repeat(len)}` };
}

const BUDGET = {
  maxEvidence: 200,
  maxImages: 3,
  imageBudgetBytes: 1000,
  maxImageBytes: 500,
  totalChars: 1000,
};

describe("模型侧容量分档", () => {
  it("文本类不再被 30 条卡住：200 条以内全收", () => {
    const many = Array.from({ length: 150 }, (_, i) => text(`t${i}`));
    const { selected, meta } = selectForModel(many, BUDGET);
    expect(selected).toHaveLength(150);
    expect(meta.droppedEvidence).toBe(0);
  });

  it("聊天与图片不再争同一个配额：图片限额不会挤掉聊天", () => {
    // 1 段聊天 + 5 张图（上限 3 张）：聊天必须在，多出的 2 张图被记为放弃
    const bundle = [text("chat", 20), ...Array.from({ length: 5 }, (_, i) => image(`img${i}`, 100))];
    const { selected, meta } = selectForModel(bundle, BUDGET);
    expect(selected.map(item => item.id)).toContain("chat");
    expect(meta.images).toBe(3);
    expect(meta.droppedImages).toBe(2);
  });

  it("超过总条数上限的材料被计数，而不是静默丢弃", () => {
    const { selected, meta } = selectForModel(
      Array.from({ length: 205 }, (_, i) => text(`t${i}`)),
      BUDGET,
    );
    expect(selected).toHaveLength(200);
    expect(meta.droppedEvidence).toBe(5);
  });

  it("单张超限与总字节预算都会放弃图片", () => {
    const oversize = selectForModel([image("big", 900)], BUDGET);
    expect(oversize.selected).toHaveLength(0);
    expect(oversize.meta.droppedImages).toBe(1);

    const overBudget = selectForModel(
      [image("a", 400), image("b", 400), image("c", 400)],
      { ...BUDGET, maxImages: 10 },
    );
    expect(overBudget.meta.images).toBe(2); // 400 + 400 后剩 200，装不下第三张 400
    expect(overBudget.meta.droppedImages).toBe(1);
  });

  it("默认档位比原来的 30 条宽松，且图片是独立限额", () => {
    const budget = modelBudget();
    expect(budget.maxEvidence).toBeGreaterThan(30);
    expect(budget.maxImages).toBeGreaterThan(0);
    expect(budget.maxImages).toBeLessThan(budget.maxEvidence);
    expect(budget.totalChars).toBeGreaterThan(0);
  });
});

describe("createModelAnalysis 真的按分档取舍", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("1 段聊天 + 25 张图：全部收下分析，但只送 20 张图进模型，并在 meta 里说清", async () => {
    process.env.AI_API_KEY = "test-key";
    process.env.AI_BASE_URL = "http://127.0.0.1:1/v1";
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
      captured.body = init?.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                caseTitle: "测试", summary: "测试摘要", people: [], relationships: [],
                events: [], contradictions: [], commitments: [], evidenceGaps: [],
              }),
            },
          }],
        }),
      };
    });

    const bundle: Evidence[] = [
      { id: "chat", name: "群聊", kind: "chat", mimeType: "text/plain",
        content: "[2026-10-31 21:53:30] 张三: 明天我把押金退给你" },
      ...Array.from({ length: 25 }, (_, i) => image(`img${i}`, 100)),
    ];

    const { meta } = await createModelAnalysis(bundle);
    expect(meta.images).toBe(modelBudget().maxImages);
    expect(meta.droppedImages).toBe(25 - modelBudget().maxImages);
    expect(meta.droppedEvidence).toBe(0);

    const sent = JSON.parse(captured.body ?? "{}");
    const parts = sent.messages[1].content as { type: string }[];
    expect(parts.filter(part => part.type === "image_url")).toHaveLength(modelBudget().maxImages);
    expect(parts.filter(part => part.type === "text").length).toBeGreaterThanOrEqual(2);
  });
});
