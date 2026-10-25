import { NextResponse } from "next/server";
import { safeProfilePicture } from "@/lib/account-display";
import { defaultAuthPath, isLoggedIn, loadAuth } from "@/lib/xai/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await loadAuth();
  return NextResponse.json({
    loggedIn: isLoggedIn(auth),
    email: auth.profile?.email ?? null,
    picture: safeProfilePicture(auth.profile?.picture),
    lastRefresh: auth.last_refresh,
    redirectUri: auth.redirect_uri,
    authPath: defaultAuthPath(),
    error: auth.last_auth_error,
    pendingLogin: Boolean(auth.pending_oauth),
  }, { headers: { "Cache-Control": "no-store" } });
}
