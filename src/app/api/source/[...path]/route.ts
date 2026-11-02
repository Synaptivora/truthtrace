import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

// B 侧桥接：把 C 的 /api/source/* 转发到 A 的 /source/*（方案 A 冻结契约）。
// 只转发，不做体积/字段判断；A 的 /source/* 返回什么就原样回传。
function baseUrl(): string {
  return (process.env.INGESTION_SERVICE_URL || "").replace(/\/$/, "");
}

function unavailable() {
  return NextResponse.json(
    {
      error: "未配置 A 解析服务地址",
      hint: "在 .env.local 设置 INGESTION_SERVICE_URL（例如 http://127.0.0.1:8000）后重启前端",
    },
    { status: 503 },
  );
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const base = baseUrl();
  if (!base) return unavailable();
  const { path } = await context.params;
  const search = new URL(request.url).search;
  try {
    const response = await fetch(`${base}/source/${path.join("/")}${search}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "无法连接 A 解析服务", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const base = baseUrl();
  if (!base) return unavailable();
  const { path } = await context.params;
  // 必须是字节流：渠道导出文件走 multipart 上传，request.text() 会把二进制解成乱码
  // （UTF-8 解码是有损的，转发出去的文件就再也读不回来了）。
  const raw = Buffer.from(await request.arrayBuffer());
  try {
    const response = await fetch(`${base}/source/${path.join("/")}`, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
      body: raw.length ? raw : Buffer.from("{}"),
      // sync 会跑 AI 取数，给足时间；connect 很快，同样不受影响。
      signal: AbortSignal.timeout(200_000),
    });
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "无法连接 A 解析服务", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
