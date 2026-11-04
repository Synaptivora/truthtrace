import { ingestionFetch } from "@/lib/ingestion/service";
import { secureRoute } from "@/lib/security/boundary";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// B 侧下载代理：C 拿到的「下载链接」统一走 /api/files/<存储名>，再由这里转给 A 的 /files/<存储名>。
// 为什么要多这一跳：
//   1) A 生成的链接里带的是「A 看到的 Host」（经 B 转发时是 127.0.0.1:8000），浏览器跨机打不开；
//   2) 走同源就没 CORS、也不把内网地址暴露给用户；
//   3) 原件可能 >100MB，必须流式转发，绝不能 arrayBuffer() 读进内存。
const STORED = /^[0-9a-f]{12}(\.[A-Za-z0-9]{1,10})?$/; // 与 A 的白名单同规则，禁目录穿越

function baseUrl(): string {
  return (process.env.INGESTION_SERVICE_URL || "").replace(/\/$/, "");
}

async function rawGET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const base = baseUrl();
  if (!base) {
    return NextResponse.json(
      { error: "未配置 A 解析服务地址", hint: "在 .env.local 设置 INGESTION_SERVICE_URL 后重启前端" },
      { status: 503 },
    );
  }

  const { path } = await context.params;
  const stored = path[path.length - 1] || "";
  if (!STORED.test(stored)) {
    return NextResponse.json({ error: "非法的文件标识" }, { status: 404 });
  }

  try {
    const upstream = await ingestionFetch(`${base}/files/${stored}`, { signal: AbortSignal.timeout(300_000) });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "原件不可用或已被清理" }, { status: upstream.status || 502 });
    }
    const headers = new Headers();
    for (const key of ["content-type", "content-length", "content-disposition"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    return new Response(upstream.body, { headers });
  } catch (error) {
    return NextResponse.json(
      { error: "无法连接 A 解析服务", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export const GET = secureRoute(rawGET);
