import { EvidenceSchema, type Evidence } from "../contracts";


function evidenceKind(file: File): Evidence["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf") return "pdf";
  if (/chat|message|微信|聊天/i.test(file.name)) return "chat";
  return "text";
}

async function parseRemotely(file: File, serviceUrl: string): Promise<Evidence> {
  const body = new FormData();
  body.append("file", file);

  const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/parse`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.error === "string" ? detail.error : `证据解析服务返回 ${response.status}`);
  }

  const result = await response.json();
  return EvidenceSchema.parse(result.evidence ?? result);
}

export async function parseEvidenceFile(file: File): Promise<Evidence> {
  if (file.size === 0) throw new Error(`${file.name} 是空文件`);

  const serviceUrl = process.env.INGESTION_SERVICE_URL;
  if (serviceUrl) return parseRemotely(file, serviceUrl);

  const kind = evidenceKind(file);
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    mimeType: file.type || "application/octet-stream",
    source: "用户上传",
  };

  if (file.type.startsWith("text/") || /\.(txt|md|json|csv|log)$/i.test(file.name)) {
    return EvidenceSchema.parse({ ...base, content: await file.text() });
  }

  if (kind === "image") {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return EvidenceSchema.parse({
      ...base,
      content: `data:${base.mimeType};base64,${base64}`,
    });
  }

  throw new Error(`${file.name} 暂不能由内置解析器处理。请上传文本，或由 A 配置 INGESTION_SERVICE_URL。`);
}
