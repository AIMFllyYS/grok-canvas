import { modelCatalog } from "@/lib/agent/model-catalog";
import { agentError } from "@/lib/agent/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const c = await modelCatalog();
    return Response.json({
      ...c,
      models: c.models.map(({ baseURL: _url, backend: _backend, ...m }) => m),
    });
  } catch (e) {
    return agentError(e);
  }
}
