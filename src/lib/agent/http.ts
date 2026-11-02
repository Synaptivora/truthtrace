export async function readJson(request: Request, limit = 12 * 1024 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("请发送 JSON 请求。");
  const origin = request.headers.get("origin");
  // Next's internal URL may use localhost even when the browser uses 127.0.0.1.
  // Compare against the actual request Host, never a client-supplied forwarded host.
  const url=new URL(request.url);
  const expectedOrigin=`${url.protocol}//${request.headers.get("host") || url.host}`;
  if (origin && origin !== expectedOrigin) throw new Error("不接受跨站请求。");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("请求不能为空。");
  const decoder = new TextDecoder(); let size = 0; let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("对话材料过大，请减少材料或缩短文本后重试。"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
