import { describe, expect, it } from "vitest";
import { describeEmptyImport } from "@/components/truthtrace/api-client";

// 这些输入都是 A 的 /source/extract 真实返回（见 service.py 的 status=empty 分支）。
describe("describeEmptyImport", () => {
  it("逐段列出 A 给的跳过原因", () => {
    const text = describeEmptyImport({
      status: "empty",
      synced: 0,
      evidences: [],
      skipped: [
        { id: "cid_demo_private", title: "demo_与李四的单聊", reason: "时间范围内没有消息" },
      ],
    });
    expect(text).toBe("demo_与李四的单聊：时间范围内没有消息");
  });

  it("多段用分号连接，且保留每段自己的原因（全被取消勾选 ≠ 没消息）", () => {
    const text = describeEmptyImport({
      evidences: [],
      skipped: [
        { title: "供应商群", reason: "时间范围内没有消息" },
        { title: "项目群", reason: "该会话 43 条消息都被取消勾选" },
      ],
    });
    expect(text).toBe("供应商群：时间范围内没有消息；项目群：该会话 43 条消息都被取消勾选");
  });

  it("没有 skipped 时回落到 A 的 hint", () => {
    expect(describeEmptyImport({ evidences: [], hint: "所选会话在该时间范围内没有消息，请放宽时间范围" }))
      .toBe("所选会话在该时间范围内没有消息，请放宽时间范围");
  });

  it("什么都没有时给中文兜底，绝不让 Zod 的 too_small 冒出来", () => {
    const text = describeEmptyImport({ evidences: [] });
    expect(text).toContain("请放宽时间范围");
    expect(text).not.toContain("too_small");
    expect(text).not.toContain("[{");
  });

  it("字段类型不对也不崩（A 老版本 / 中间层多包一层都不至于白屏）", () => {
    const text = describeEmptyImport({
      skipped: [null, { title: 42 }, { reason: "只有原因" }, "字符串"] as unknown[],
      hint: 123,
    });
    expect(text).toBe("只有原因");
  });
});
