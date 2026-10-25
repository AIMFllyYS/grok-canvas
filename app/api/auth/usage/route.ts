import { NextResponse } from "next/server";
import { readAccountUsage, UsageError } from "@/lib/xai/usage";
import { OAuthError } from "@/lib/xai/oauth";
import { XaiApiError } from "@/lib/xai/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json(await readAccountUsage(), { headers });
  } catch (error) {
    if (error instanceof UsageError) return NextResponse.json({ error: { kind: error.kind, message: error.message } }, { status: error.status, headers });
    if (error instanceof OAuthError || error instanceof XaiApiError && ["not_logged_in", "auth_expired"].includes(error.kind)) {
      return NextResponse.json({ error: { kind: "auth_expired", message: "请重新登录后查看用量" } }, { status: 401, headers });
    }
    return NextResponse.json({ error: { kind: "usage_unavailable", message: "暂时无法读取共享额度，请稍后重新打开账户菜单" } }, { status: 502, headers });
  }
}
