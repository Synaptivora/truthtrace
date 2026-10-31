import { NextResponse } from "next/server";
import { parseEvidenceFile } from "@/lib/ingestion/parser";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((item): item is File => item instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "请至少上传一个文件" }, { status: 400 });
    }
    if (files.length > 20) {
      return NextResponse.json({ error: "单次最多上传 20 个文件" }, { status: 400 });
    }

    const evidence = [];
    for (const file of files) {
      evidence.push(await parseEvidenceFile(file));
    }

    return NextResponse.json({ evidence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "证据解析失败";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
