"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { MarkdownContent } from "./markdown-content";
import type { Evidence } from "@/lib/contracts";

/**
 * 证据正文渲染器。解决两件事：
 *  1) 大附件证据的正文里有「下载链接」，`<pre>` 里是一段死文本 → 这里 linkify，
 *     并把 `/files/<id>` 与 `http(s)://…/files/<id>` 一律收敛到同源 `/api/files/<id>`。
 *  2) 聊天正文里的内联标记 `[图片@t: 名 见独立证据]` 只是一行字 → 这里换成 chip，
 *     点了直接打开那张独立图片证据（找不到就置灰并说明原因）。
 * 旧标记没有稳定 ID 时仅接受唯一同名候选；重名必须由用户选择。
 */

const BRACKET = /\[([^[\]]+)\]/g;
const URL_RE = /(https?:\/\/[^\s)）"']+|\/files\/[0-9a-f]{12}(?:\.[A-Za-z0-9]{1,10})?)/g;
const STORED = /\/files\/([0-9a-f]{12}(?:\.[A-Za-z0-9]{1,10})?)$/;

type Marker = { label: string; name?: string };

function parseMarker(inner: string): Marker | null {
  // 只认「见独立证据」的标记：用户真的在聊天里打了 [图片] 的，原样显示
  if (!inner.includes("见独立证据")) return null;
  const body = inner.replace(/\s*见独立证据\s*$/, "").trim();

  const asFile = body.match(/^文件[:：]\s*(.+?)@(.+)$/); // [文件:名@时间 见独立证据]
  if (asFile) return { label: "文件", name: asFile[1].trim() || undefined };

  const typed = body.match(/^(图片|文件|语音)@(.+)$/);
  if (!typed) return null;
  // 只在「冒号 + 空白」处切名称：时间里的冒号（09:22:00）后面没有空格，不会被误切
  const sep = typed[2].search(/[:：]\s/);
  const name = sep >= 0 ? typed[2].slice(sep + 1).trim() : "";
  return { label: typed[1], name: name || undefined };
}

/** 把 /files/<id> 与绝对地址里的 /files/<id> 都改写成同源代理，跨机部署也不会指向 127.0.0.1。 */
export function rewriteFileUrl(url: string): string {
  const matched = url.match(STORED);
  return matched ? `/api/files/${matched[1]}` : url;
}

function linkify(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = URL_RE.exec(text)) !== null) {
    if (matched.index > last) nodes.push(text.slice(last, matched.index));
    nodes.push(
      <a key={`${key}-u${nodes.length}`} href={rewriteFileUrl(matched[0])} target="_blank" rel="noreferrer">
        {matched[0]}
      </a>,
    );
    last = matched.index + matched[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderChatLine(line: string, key: string, all: Evidence[], onOpen?: (id: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  BRACKET.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = BRACKET.exec(line)) !== null) {
    const marker = parseMarker(matched[1]);
    if (!marker) continue;
    if (matched.index > last) nodes.push(...linkify(line.slice(last, matched.index), `${key}-t${nodes.length}`));

    const candidates = marker.name ? all.filter(item => item.name === marker.name) : [];
    const target = candidates.length === 1 ? candidates[0] : undefined;
    if (candidates.length > 1) {
      nodes.push(<details key={`${key}-ambiguous${nodes.length}`}><summary>{marker.label}：{marker.name}（{candidates.length} 个候选，请核对来源）</summary>{candidates.map(item => <button type="button" key={item.id} onClick={() => onOpen?.(item.id)}>{item.name} · {item.source} · {item.id}</button>)}</details>);
      last = matched.index + matched[0].length;
      continue;
    }
    nodes.push(
      <button
        key={`${key}-m${nodes.length}`}
        type="button"
        className={`evidence-media-chip ${target?.kind === "image" && target.content.startsWith("data:image/") ? "has-thumbnail" : ""}`}
        disabled={!target}
        onClick={target && onOpen ? () => onOpen(target.id) : undefined}
        title={target ? `打开：${target.name}` : "该媒体未下载，请在渠道内单独导出"}
      >
        {target?.kind === "image" && target.content.startsWith("data:image/") && <Image src={target.content} alt={target.name} width={240} height={180} unoptimized />}
        <span>{marker.name ? `${marker.label}：${marker.name}` : marker.label}</span>
      </button>,
    );
    last = matched.index + matched[0].length;
  }
  if (last < line.length) nodes.push(...linkify(line.slice(last), `${key}-t${nodes.length}`));
  return nodes;
}

type TranscriptBlock = { type: "message"; stamp: string; sender: string; text: string } | { type: "text"; text: string };

// Read A's timestamped transcript format without changing the underlying evidence.
export function parseChatTranscript(content: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]\s+([^:\r\n]{1,120})[:：][ \t]?(.*)$/);
    if (match) blocks.push({ type: "message", stamp: match[1], sender: match[2], text: match[3] });
    else if (blocks.length) blocks[blocks.length - 1].text += "\n" + line;
    else blocks.push({ type: "text", text: line });
  }
  return blocks;
}

export function EvidenceContent({
  item,
  all,
  onOpen,
  highlight,
}: {
  item: Evidence;
  all: Evidence[];
  onOpen?: (id: string) => void;
  highlight?: {start:number;end:number;quote:string};
}) {
  const [raw, setRaw] = useState(false);
  const mark=useRef<HTMLElement>(null);
  useEffect(()=>{mark.current?.scrollIntoView({block:"center"});},[highlight]);
  const valid=highlight&&highlight.start>=0&&highlight.end<=item.content.length&&item.content.slice(highlight.start,highlight.end)===highlight.quote;
  const chat = item.kind === "chat";
  const blocks = chat ? parseChatTranscript(item.content) : [];
  if(valid&&highlight)return <pre className="evidence-content" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{item.content.slice(0,highlight.start)}<mark ref={mark}>{item.content.slice(highlight.start,highlight.end)}</mark>{item.content.slice(highlight.end)}</pre>;
  if (!chat && (/\.md(?:own)?$/i.test(item.name) || item.mimeType === "text/markdown")) return <section className="evidence-document">
    <nav aria-label="材料显示方式"><button type="button" aria-pressed={!raw} onClick={()=>setRaw(false)}>排版阅读</button><button type="button" aria-pressed={raw} onClick={()=>setRaw(true)}>原始文本</button><small>仅调整显示，原文与引用位置保持不变</small></nav>
    {raw?<pre className="evidence-raw">{item.content}</pre>:<MarkdownContent text={item.content}/>}
  </section>;
  if (blocks.some(block => block.type === "message")) {
    return <div className="evidence-content evidence-chat-transcript" aria-label="聊天原文">
      {blocks.map((block, index) => {
        if (block.type === "text") return <p className="transcript-context" key={index}>{linkify(block.text, `context-${index}`)}</p>;
        const day = block.stamp.slice(0, 10), previous = blocks[index - 1];
        const newDay = previous?.type !== "message" || previous.stamp.slice(0, 10) !== day;
        return <div className="transcript-group" key={index}>
          {newDay && <div className="transcript-day">{day}</div>}
          <article className="transcript-row">
            <span className="transcript-avatar" aria-hidden="true">{Array.from(block.sender)[0]}</span>
            <div className="transcript-message"><header><strong>{block.sender}</strong><time dateTime={block.stamp.replace(" ", "T")}>{block.stamp.slice(11)}</time></header>
              <div className="transcript-bubble">{renderChatLine(block.text, `m${index}`, all, onOpen)}</div>
            </div>
          </article>
        </div>;
      })}
    </div>;
  }
  return (
    <div className={`evidence-content ${chat ? "is-chat" : ""}`}>
      {item.content.split("\n").map((line, index) =>
        line === "" ? (
          <br key={index} />
        ) : (
          <p key={index}>{chat ? renderChatLine(line, `l${index}`, all, onOpen) : linkify(line, `l${index}`)}</p>
        ),
      )}
    </div>
  );
}
