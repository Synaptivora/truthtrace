import { NextResponse } from "next/server";
import { parseEvidenceFile } from "@/lib/ingestion/parser";
import { saveOriginal } from "@/lib/investigator/store";

export const runtime = "nodejs";
export const maxDuration = 300;

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
      // 聊天信封会展开成「chat + 媒体」多条，普通文件仍是 1 条
      const parsed=await parseEvidenceFile(file);
      const originalHash=saveOriginal(new Uint8Array(await file.arrayBuffer()));
      evidence.push(...parsed.map(item=>({...item,originalHash,parserVersion:"ingestion-v1"})));
    }

    return NextResponse.json({ evidence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "证据解析失败";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
