export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp";
export type UploadedAsset = { name: string; originalName: string };
export type UploadProgress = { name: string; state: "waiting" | "uploading" | "success" | "failed"; asset?: UploadedAsset; error?: string };

export function validateUpload(file: { type: string; size: number }, bytes?: Uint8Array): string | null {
  if (!file.size) return "不能上传空文件";
  if (file.size > MAX_IMAGE_BYTES) return "单张不能超过 20MB";
  if (!IMAGE_UPLOAD_ACCEPT.split(",").includes(file.type)) return "仅支持 PNG / JPEG / WebP";
  if (!bytes) return null;
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const png = starts([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = starts([255, 216, 255]);
  const webp = starts([82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return file.type === "image/png" && png || file.type === "image/jpeg" && jpeg || file.type === "image/webp" && webp ? null : "文件内容与图片格式不匹配";
}

/** 每个请求仅一张图片；两个工作协程限制批量上传的峰值内存。 */
export async function uploadAssets(files: File[], options: { fetch?: typeof fetch; onUpdate?: (items: UploadProgress[]) => void } = {}): Promise<UploadProgress[]> {
  const request = options.fetch ?? fetch;
  const results: UploadProgress[] = files.map(file => ({ name: file.name, state: "waiting" }));
  const notify = () => options.onUpdate?.(results.map(item => ({ ...item })));
  let cursor = 0;
  notify();
  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor++, file = files[index]!;
      results[index] = { name: file.name, state: "uploading" }; notify();
      try {
        const invalid = validateUpload(file);
        if (invalid) throw new Error(invalid);
        const form = new FormData(); form.append("files", file);
        const response = await request("/api/assets/upload", { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(response.status === 413 ? "上传文件过大" : `上传失败（${response.status}）`);
        const payload = await response.json();
        const asset = payload?.assets?.[0];
        if (!asset || typeof asset.name !== "string" || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(asset.name)) throw new Error(payload?.rejected?.[0]?.reason ?? "上传响应无效");
        results[index] = { name: file.name, state: "success", asset: { name: asset.name, originalName: file.name } };
      } catch (error) {
        results[index] = { name: file.name, state: "failed", error: error instanceof Error ? error.message : "上传失败，请重试" };
      }
      notify();
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
  return results;
}
