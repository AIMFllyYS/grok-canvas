import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ASSETS_DIR, isSafeAssetName, saveBufferAsset } from "../assets";
import { dataDir } from "../data-dir";
import { runFfmpeg } from "./export";
import { StudioError } from "./store";

export async function sampleVideoFrames(
  assetName: string,
  signal?: AbortSignal,
) {
  if (!isSafeAssetName(assetName) || !assetName.endsWith(".mp4"))
    throw new StudioError("无效 MP4 素材");
  const cacheDir = path.join(dataDir(), "studio-video-frames"),
    cacheFile = path.join(cacheDir, `${assetName}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, "utf8")) as Array<{
      assetName: string;
      at: number;
    }>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const frames: Array<{ assetName: string; at: number }> = [];
  for (const at of [0, 2, 4]) {
    const temp = path.join(ASSETS_DIR, `${crypto.randomUUID()}.png`);
    try {
      await runFfmpeg(
        [
          "-y",
          "-ss",
          String(at),
          "-i",
          path.join(ASSETS_DIR, assetName),
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=960:-2",
          temp,
        ],
        signal,
      );
      const saved = await saveBufferAsset(
        new Uint8Array(await readFile(temp)),
        "image/png",
      );
      frames.push({ assetName: saved.name, at });
    } catch (error) {
      if (!frames.length) throw error;
      break;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(frames));
  return frames;
}
