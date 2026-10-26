import { z } from "zod";
import { saveBufferAsset } from "@/lib/assets";
import { agentError } from "@/lib/agent/http";
import { AgentError } from "@/lib/agent/store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const data = await request.formData();
    const files = data.getAll("files");
    z.array(z.instanceof(File)).min(1).max(8).parse(files);
    const items = [];
    for (const entry of files) {
      const f = entry as File;
      if (f.size > 20 * 1024 * 1024) throw new AgentError("单个附件不超过20MB");
      const id = crypto.randomUUID();
      if (/\.(md|markdown|txt)$/i.test(f.name)) {
        const text = await f.text();
        if (text.length > 40000)
          throw new AgentError("文本附件过长，请精简后上传");
        items.push({ id, name: f.name, kind: "text", text });
      } else {
        if (!["image/png", "image/jpeg", "image/webp"].includes(f.type))
          throw new AgentError("支持 PNG、JPEG、WebP、Markdown 和文本");
        const asset = await saveBufferAsset(
          new Uint8Array(await f.arrayBuffer()),
          f.type,
        );
        items.push({
          id,
          name: f.name,
          kind: "image",
          assetName: asset.name,
        });
      }
    }
    return Response.json({ attachments: items });
  } catch (e) {
    return agentError(e);
  }
}
