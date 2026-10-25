import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ASSETS_DIR, saveBufferAsset } from "@/lib/assets";
import {
  acquireProduction,
  loadProject,
  StudioError,
  updateProject,
} from "@/lib/studio/store";
import { runFfmpeg } from "@/lib/studio/export";
import { studioError } from "@/lib/studio/http";
import type { Source } from "@/lib/studio/schema";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params;
    release = acquireProduction(id);
    if ((await loadProject(id)).sources.length >= 50)
      throw new StudioError("每个导演台最多50份素材");
    const length = Number(request.headers.get("content-length"));
    if (length > 105 * 1024 * 1024)
      throw new StudioError("视频素材不能超过100MB", 413);
    const form = await request.formData(),
      file = form.get("file");
    if (!(file instanceof File) || file.size > 100 * 1024 * 1024 || !file.size)
      throw new StudioError("请选择100MB以内的 MP4", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp")
      throw new StudioError("仅支持有效的 MP4 视频素材");
    const saved = await saveBufferAsset(bytes, "video/mp4"),
      frames: NonNullable<Source["frames"]> = [];
    for (const at of [0, 2, 4]) {
      const temp = path.join(ASSETS_DIR, `${crypto.randomUUID()}.png`);
      try {
        await runFfmpeg(
          [
            "-y",
            "-ss",
            String(at),
            "-i",
            path.join(ASSETS_DIR, saved.name),
            "-frames:v",
            "1",
            "-vf",
            "scale=960:-2",
            temp,
          ],
          request.signal,
        );
        const frame = await saveBufferAsset(
          new Uint8Array(await readFile(temp)),
          "image/png",
        );
        frames.push({ assetName: frame.name, at });
      } catch (error) {
        if (!frames.length) throw error;
        break;
      } finally {
        await unlink(temp).catch(() => {});
      }
    }
    const source: Source = {
      id: crypto.randomUUID(),
      name: file.name.slice(0, 300),
      kind: "video",
      assetName: saved.name,
      text: `视频素材，已抽取 ${frames.map((f) => `${f.at}s`).join("、")} 关键帧；仅供视觉采样分析，未分析音频。`,
      frames,
    };
    const project = await updateProject(id, (p) => {
      p.sources.push(source);
    });
    return Response.json({ project, source });
  } catch (error) {
    return studioError(error);
  } finally {
    release?.();
  }
}
