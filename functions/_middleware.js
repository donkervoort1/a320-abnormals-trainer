// Cloudflare Pages middleware — password-gates the whole site (Basic Auth) so the
// private deployment isn't world-readable. Password is the Pages secret SITE_PASSWORD.
export async function onRequest(context) {
  const { request, env, next } = context;
  const expected = env.SITE_PASSWORD;
  // FAIL CLOSED: if the password isn't configured, lock everything (never serve).
  if (!expected) {
    return new Response("Locked — not configured.", {
      status: 401, headers: { "WWW-Authenticate": 'Basic realm="A320 Trainer"' },
    });
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const pass = atob(auth.slice(6)).split(":").slice(1).join(":");
      if (pass === expected) return next();
    } catch (e) {}
  }
  return new Response("A320 Trainer — sign in", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="A320 Trainer"' },
  });
}
