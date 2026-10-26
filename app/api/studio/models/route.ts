import { modelCatalog } from "@/lib/studio/model-catalog";
import { studioError } from "@/lib/studio/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const catalog = await modelCatalog();
    return Response.json({ ...catalog, models: catalog.models.map(({ baseURL: _base, backend: _backend, ...model }) => model) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return studioError(error); }
}
