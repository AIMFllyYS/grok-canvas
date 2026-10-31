import { assetResponse } from "@/lib/media/asset-stream";

export const runtime = "nodejs";

/** 资产读取（P4-01）：流式 + 单 Range（206/416），不整文件读入内存。名称校验与同源守卫保持不变。 */
export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return assetResponse(request, name);
}

/** 只读元数据：复用 Range 决策，绝不创建 body 流。 */
export async function HEAD(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return assetResponse(request, name, { head: true });
}
