import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink, stat, rmdir } from "node:fs/promises";
import path from "node:path";
import { ASSETS_DIR, isSafeAssetName } from "../assets";
import { dataDir } from "../data-dir";
import { exportSignature } from "./schema";
import { loadProject, StudioError, updateProject } from "./store";

export function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // FFmpeg is an external runtime prerequisite; never trace/bundle the user's cwd.
    const child = spawn(
      /* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg",
      args,
      {
        windowsHide: true,
        signal,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let log = "";
    child.stderr.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-5000);
    });
    child.once("error", (error) =>
      reject(
        new StudioError(
          `无法运行 FFmpeg：${error.message}。请安装 FFmpeg 或设置 FFMPEG_PATH。`,
          503,
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new StudioError(`视频合成失败：${log.slice(-1200)}`, 500)),
    );
  });
}
export async function exportProject(id: string, signal?: AbortSignal) {
  const p = await loadProject(id);
  if (!p.shots.length || p.shots.some((s) => !s.videoAsset || !s.videoApproved))
    throw new StudioError("请先完成并验收全部分镜视频，再合成成片");
  const signature = exportSignature(p);
  if (p.exportAsset && p.exportSignature === signature)
    return { assetName: p.exportAsset, cached: true };
  const work = path.join(dataDir(), "studio-exports", crypto.randomUUID());
  await mkdir(work, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });
  const [width, height] =
    p.aspect === "9:16"
      ? [720, 1280]
      : p.aspect === "1:1"
        ? [720, 720]
        : [1280, 720];
  const clips: string[] = [];
  const list = path.join(work, "concat.txt");
  const name = `${crypto.randomUUID()}.mp4`,
    destination = path.join(ASSETS_DIR, name);
  try {
    for (let i = 0; i < p.shots.length; i++) {
      const shot = p.shots[i]!;
      if (!isSafeAssetName(shot.videoAsset!))
        throw new StudioError("无效的视频素材名");
      const output = path.join(work, `${i}.mp4`);
      clips.push(output);
      // Normalize codecs, aspect, fps and timestamps; concatenation is then deterministic.
      await runFfmpeg(
        [
          "-y",
          "-i",
          path.join(ASSETS_DIR, shot.videoAsset!),
          "-map",
          "0:v:0",
          "-t",
          String(shot.duration),
          "-vf",
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-video_track_timescale",
          "12288",
          output,
        ],
        signal,
      );
    }
    await writeFile(
      list,
      clips
        .map(
          (file) =>
            `file '${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
        )
        .join("\n"),
    );
    await runFfmpeg(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        destination,
      ],
      signal,
    );
    const info = await stat(destination);
    await updateProject(id, (current) => {
      if (exportSignature(current) !== signature)
        throw new StudioError("制作内容已变化，请重新合成", 409);
      current.exportAsset = name;
      current.exportSignature = signature;
    });
    return { assetName: name, bytes: info.size, cached: false };
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  } finally {
    await Promise.all(
      [...clips, list].map((file) => unlink(file).catch(() => {})),
    );
    await rmdir(work).catch(() => {});
  }
}
