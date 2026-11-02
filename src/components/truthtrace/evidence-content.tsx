"use client";

import type { ReactNode } from "react";
import type { Evidence } from "@/lib/contracts";

/**
 * 证据正文渲染器。解决两件事：
 *  1) 大附件证据的正文里有「下载链接」，`<pre>` 里是一段死文本 → 这里 linkify，
 *     并把 `/files/<id>` 与 `http(s)://…/files/<id>` 一律收敛到同源 `/api/files/<id>`。
 *  2) 聊天正文里的内联标记 `[图片@t: 名 见独立证据]` 只是一行字 → 这里换成 chip，
 *     点了直接打开那张独立图片证据（找不到就置灰并说明原因）。
 * 标记与证据名同源（都来自 A 的 media_list），所以按名精确匹配是可靠的。
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

    const target = marker.name
      ? all.find(item => item.name === marker.name)
        ?? all.find(item => item.name.startsWith(marker.name as string))
      : undefined;
    nodes.push(
      <button
        key={`${key}-m${nodes.length}`}
        type="button"
        className="evidence-media-chip"
        disabled={!target}
        onClick={target && onOpen ? () => onOpen(target.id) : undefined}
        title={target ? `打开：${target.name}` : "该媒体未下载，请在渠道内单独导出"}
      >
        {marker.name ? `${marker.label}：${marker.name}` : marker.label}
      </button>,
    );
    last = matched.index + matched[0].length;
  }
  if (last < line.length) nodes.push(...linkify(line.slice(last), `${key}-t${nodes.length}`));
  return nodes;
}

export function EvidenceContent({
  item,
  all,
  onOpen,
}: {
  item: Evidence;
  all: Evidence[];
  onOpen?: (id: string) => void;
}) {
  const chat = item.kind === "chat";
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
