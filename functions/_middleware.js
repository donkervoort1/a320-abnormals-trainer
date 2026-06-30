// Cloudflare Pages middleware — cookie-based login gate (works in iOS Safari AND
// standalone "Add to Home Screen" PWAs, unlike HTTP Basic Auth which renders blank).
// Password is the Pages secret SITE_PASSWORD; the auth cookie holds it (HttpOnly).
function loginPage(msg) {
  const m = msg ? `<p class="err">${msg}</p>` : "";
  return new Response(`<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=apple-mobile-web-app-capable content=yes><title>A320 Trainer</title>
<style>html,body{height:100%;margin:0;background:#0b0f14;color:#e8eef5;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
form{width:100%;max-width:320px;text-align:center}
h1{font-size:20px;margin:0 0 4px}h1 span{color:#3da9fc}
p.sub{color:#94a3b5;font-size:14px;margin:0 0 22px}
input{width:100%;padding:16px;font-size:18px;text-align:center;border-radius:14px;border:2px solid #26313f;background:#1b2430;color:#e8eef5;outline:none;box-sizing:border-box}
input:focus{border-color:#3da9fc}
button{width:100%;margin-top:12px;padding:16px;font-size:17px;font-weight:800;border:0;border-radius:14px;background:#3da9fc;color:#04121f}
.err{color:#fb7185;font-size:14px;margin-top:12px}</style></head>
<body><div class=wrap><form method=POST action="/__login">
<h1>A320 <span>Trainer</span></h1><p class=sub>Private &middot; enter password</p>
<input type=password name=password autocomplete=current-password autofocus placeholder="password">
<button type=submit>Enter</button>${m}</form></div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const pw = env.SITE_PASSWORD;
  if (!pw) return new Response("Locked — not configured.", { status: 503 });
  const url = new URL(request.url);
  const cookie = request.headers.get("Cookie") || "";
  const authed = cookie.split(/;\s*/).indexOf("a320auth=" + pw) !== -1;
  if (authed) return next();
  if (request.method === "POST" && url.pathname === "/__login") {
    let pass = "";
    try { pass = (await request.formData()).get("password") || ""; } catch (e) {}
    if (pass === pw) {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": `a320auth=${pw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    return loginPage("Wrong password.");
  }
  return loginPage("");
}
