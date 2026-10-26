/** The app is a single-user loopback service, never a public API. */
export function allowLocalRequest(headers: Headers, pathname: string): boolean {
  const host = headers.get("host");
  const configured = process.env.GROK_CANVAS_PORT ?? "3210";
  const port = /^\d{1,5}$/.test(configured) && Number(configured) > 0 && Number(configured) <= 65535 ? configured : "3210";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;

  // OAuth returns from xAI as a cross-site navigation; its handler validates state + PKCE.
  if (pathname === "/callback" || pathname === "/auth-result") return true;

  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = headers.get("origin");
  if (origin && origin !== `http://${host}`) return false;

  if (pathname.startsWith("/api/")) {
    // Browser requests must prove their origin. No anonymous direct API navigation.
    return site === "same-origin" || origin === `http://${host}`;
  }
  return true;
}
