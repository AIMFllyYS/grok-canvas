import { NextResponse } from "next/server";
import { saveBufferAsset } from "@/lib/assets";
import { validateUpload } from "@/lib/asset-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: { kind: "bad_request", message: "expected multipart form" } }, { status: 400 });
  }
  const files = form.getAll("files").filter((item): item is File => item instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: { kind: "bad_request", message: "no files provided" } }, { status: 400 });
  }

  const saved = [];
  const rejected = [];
  for (const file of files) {
    const invalid = validateUpload(file);
    if (invalid) { rejected.push({ name: file.name, reason: invalid }); continue; }
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const mismatch = validateUpload(file, buffer);
      if (mismatch) { rejected.push({ name: file.name, reason: mismatch }); continue; }
      saved.push({ ...(await saveBufferAsset(buffer, file.type)), originalName: file.name });
    } catch {
      rejected.push({ name: file.name, reason: "图片保存失败，请检查磁盘空间后重试" });
    }
  }
  return NextResponse.json({ assets: saved, rejected });
}
