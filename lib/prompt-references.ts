export type PromptReference = { assetName: string; name: string };

export const referenceToken = (assetName: string) => `[[image:${assetName}]]`;
export const referencePattern = () => /\[\[image:([a-zA-Z0-9_.-]+)\]\]/g;

/** 在指定偏移处插入引用标记，格式与 @ 选择产出的提示词一致（标记后补一个空格）。 */
export function insertReferenceToken(prompt: string, assetName: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, prompt.length));
  return `${prompt.slice(0, at)}${referenceToken(assetName)} ${prompt.slice(at)}`;
}

export function compilePrompt(prompt: string, assets: string[]): string {
  return prompt.replace(referencePattern(), (_, assetName: string) => {
    const index = assets.indexOf(assetName);
    if (index < 0) throw new Error("提示词引用的图片已移除，请删除失效引用或重新添加图片");
    return `输入图片 ${index + 1}`;
  });
}
