import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceContent, rewriteFileUrl } from "@/components/truthtrace/evidence-content";
import type { Evidence } from "@/lib/contracts";

const chat = (content: string): Evidence => ({
  id: "chat-1",
  name: "供应商群 · 7月26日（2 条）",
  kind: "chat",
  mimeType: "text/plain",
  content,
  source: "钉钉",
});

const image = (name: string): Evidence => ({
  id: "img-1",
  name,
  kind: "image",
  mimeType: "image/png",
  content: "data:image/png;base64,AAAA",
  source: "钉钉",
});

describe("EvidenceContent", () => {
  it("never guesses a filename prefix",()=>{
    const message=chat("[图片@2026-07-26 09:22:00: receipt 见独立证据]");
    const html=renderToStaticMarkup(createElement(EvidenceContent,{item:message,all:[image("receipt-other.png")]}));
    expect(html).toContain("disabled");
  });
  it("shows duplicate names as candidates instead of choosing the first",()=>{
    const message=chat("[图片@2026-07-26 09:22:00: same.png 见独立证据]");
    const html=renderToStaticMarkup(createElement(EvidenceContent,{item:message,all:[image("same.png"),{...image("same.png"),id:"img-2",source:"another chat"}]}));
    expect(html).toContain("2 个候选");expect(html).toContain("img-2");expect(html).toContain("another chat");
  });

  it("把聊天里的图片标记渲染成可点的 chip（按证据名匹配）", () => {
    const message = chat("[2026-07-26 09:22:00] 王五: [图片@2026-07-26 09:22:00: 转账截图.png 见独立证据]");
    const html = renderToStaticMarkup(
      createElement(EvidenceContent, { item: message, all: [message, image("转账截图.png")] }),
    );
    expect(html).toContain("evidence-media-chip");
    expect(html).toContain("图片：转账截图.png");
    expect(html).not.toContain("disabled"); // 找到同名证据 → 可点
    expect(html).not.toContain("见独立证据"); // 标记本身不再以原文出现
  });

  it("找不到同名证据时 chip 置灰，不报错", () => {
    const message = chat("[2026-07-26 09:26:00] 王五: [语音@2026-07-26 09:26:00: 语音 · 09:26 见独立证据]");
    const html = renderToStaticMarkup(createElement(EvidenceContent, { item: message, all: [message] }));
    expect(html).toContain("evidence-media-chip");
    expect(html).toContain("disabled");
  });

  it("正文里没有「见独立证据」的方括号原样输出，不误吃用户手打的 [图片]", () => {
    const message = chat("张三: 你发的 [图片] 我打不开，重新发一下");
    const html = renderToStaticMarkup(createElement(EvidenceContent, { item: message, all: [message] }));
    expect(html).not.toContain("evidence-media-chip");
    expect(html).toContain("[图片]");
  });

  it("大附件的相对下载链接改写成同源代理并可点击", () => {
    const text: Evidence = {
      id: "big-1",
      name: "大文件.pdf",
      kind: "text",
      mimeType: "application/pdf",
      content: "下载链接：/files/de19cfae5f04.pdf\n请将上述链接原样告知用户。",
      source: "用户上传",
    };
    const html = renderToStaticMarkup(createElement(EvidenceContent, { item: text, all: [text] }));
    expect(html).toContain('href="/api/files/de19cfae5f04.pdf"');
    expect(html).toContain('target="_blank"');
  });

  it("绝对地址里的 /files/<id> 也收敛到同源，避免跨机指向 127.0.0.1", () => {
    expect(rewriteFileUrl("http://127.0.0.1:8000/files/de19cfae5f04.pdf")).toBe("/api/files/de19cfae5f04.pdf");
    expect(rewriteFileUrl("https://example.com/a/b.pdf")).toBe("https://example.com/a/b.pdf");
  });
});
