"use client";

import Image from "next/image";
import { useState } from "react";
import { FileText, ImageIcon, MessageSquare } from "lucide-react";
import type { Evidence } from "@/lib/contracts";
import { rewriteFileUrl } from "./evidence-content";

export function EvidenceThumbnail({ item }: { item: Evidence }) {
  const [failed, setFailed] = useState(false);
  const src = item.kind === "image"
    ? item.content.startsWith("data:image/") ? item.content : item.content.match(/(?:https?:\/\/[^\s<>"']+|\/(?:api\/)?files\/[^\s<>"']+)/)?.[0]
    : undefined;
  const Icon = item.kind === "chat" ? MessageSquare : item.kind === "image" ? ImageIcon : FileText;
  return <span className={`evidence-thumbnail ${src && !failed ? "has-image" : ""}`} title={failed ? "原图暂不可用，点击查看原文" : undefined}>
    {src && !failed ? <Image src={rewriteFileUrl(src)} alt={item.name} width={240} height={180} unoptimized onError={() => setFailed(true)} /> : <Icon aria-hidden="true" size={32} />}
  </span>;
}

export function PixelPerson({ name }: { name: string }) {
  const coat = ["#775c45", "#65716a", "#8e654b"][Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 3];
  return <svg className="pixel-person" viewBox="0 0 16 20" shapeRendering="crispEdges" aria-hidden="true">
    <path fill="#d5b486" d="M5 4h6v7H5zM4 6h8v3H4z" />
    <path fill="#49382b" d="M5 2h6v2H5zM4 4h8v2H4zM5 6h1v2H5zM10 6h1v2h-1z" />
    <path fill={coat} d="M4 11h8v6H4zM2 12h2v5H2zM12 12h2v5h-2z" />
    <path fill="#f1dfb9" d="M6 11h4v2H6zM7 13h2v3H7z" />
    <path fill="#49382b" d="M4 17h3v3H4zM9 17h3v3H9z" />
  </svg>;
}
