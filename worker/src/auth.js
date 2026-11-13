// Inloggen voor leerlingen en leerkrachten via Google, Microsoft of Smartschool (OAuth2 / OpenID Connect).
//
// Verloop: site → /auth/<provider>/start?terug=<pagina>  → provider → /auth/<provider>/callback
//          → gebruiker aanmaken of bijwerken in D1 → terug naar de site met een sessietoken in de URL-hash.
import { Fout, json, getConfig, enc, b64url, fromB64url, randomToken, clean, allowedOrigins, hmacKey, signToken, verifyToken, bearer, rateLimit, ip } from "./common.js";

const SESSION_TTL = 30 * 24 * 3600;   // leerlingen blijven 30 dagen ingelogd
export const PROVIDERS = ["google", "microsoft", "smartschool"];

export function enabledProviders(cfg) {
  return PROVIDERS.filter(p => {
    const c = cfg[p] || {};
    return c.clientId && c.clientSecret && (p !== "smartschool" || c.platform);
  });
}

// Doorverwijzing met aanpasbare headers (Response.redirect geeft onveranderbare headers).
const redirect = url => new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });

const callbackUrl = (req, p) => `${new URL(req.url).origin}/auth/${p}/callback`;

function endpoints(p, c, env) {
  if (env.OAUTH_MOCK) {  // enkel voor lokaal testen (.dev.vars), nooit in productie zetten
    const m = `${env.OAUTH_MOCK}/oauth/${p}`;
    return { authorize: `${m}/authorize`, token: `${m}/token`, userinfo: `${m}/userinfo`, scope: p === "smartschool" ? "userinfo" : "openid email profile" };
  }
  if (p === "google") return { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email profile" };
  if (p === "microsoft") return { authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scope: "openid email profile" };
  const base = c.platform.replace(/\/+$/, "");
  return { authorize: `${base}/OAuth`, token: `${base}/OAuth/index/token`, userinfo: `${base}/Api/V1/userinfo`, scope: "userinfo" };
}

/* ---------- Sessies ---------- */

async function userKey(env) {
  // eigen geheime sleutel voor leerlingensessies, één keer willekeurig aangemaakt
  let s = await env.KV.get("sessiesleutel");
  if (!s) { s = randomToken(32); await env.KV.put("sessiesleutel", s); }
  return hmacKey(fromB64url(s));
}

// Geeft de ingelogde gebruiker terug (of null). Rol komt telkens uit de database.
export async function currentUser(req, env, required = true) {
  const p = await verifyToken(await userKey(env), bearer(req));
  const u = p?.u ? await env.DB.prepare("SELECT id, provider, naam, email, rol FROM gebruikers WHERE id = ?").bind(p.u).first() : null;
  if (!u && required) throw new Fout(401, "Je bent niet ingelogd of je sessie is verlopen.");
  return u;
}

export async function issueSession(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return { token: await signToken(await userKey(env), { u: userId, exp }), verloopt: exp * 1000 };
}

/* ---------- OAuth ---------- */

export async function start(req, env, p) {
  if (!PROVIDERS.includes(p)) throw new Fout(404, "Onbekende login.");
  await rateLimit(env, "auth", ip(req), 30, 3600);
  const cfg = await getConfig(env);
  if (!enabledProviders(cfg).includes(p)) throw new Fout(503, "Deze login is nog niet ingesteld.");
  const url = new URL(req.url);
  const terug = url.searchParams.get("terug") || "";
  let origin = "";
  try { origin = new URL(terug).origin; } catch {}
  if (!allowedOrigins(env).includes(origin)) throw new Fout(400, "Ongeldige terugkeerpagina.");

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  await env.KV.put(`oauth:${state}`, JSON.stringify({ p, verifier, terug }), { expirationTtl: 600 });

  const c = cfg[p], e = endpoints(p, c, env);
  const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: callbackUrl(req, p), response_type: "code", scope: e.scope, state });
  if (p !== "smartschool") { q.set("code_challenge", challenge); q.set("code_challenge_method", "S256"); }
  if (p === "google") q.set("prompt", "select_account");
  if (p === "microsoft") q.set("prompt", "select_account");
  return redirect(`${e.authorize}?${q}`);
}

function decodeJwt(t) {
  // Het id_token komt rechtstreeks van de tokenserver van de provider (via HTTPS), dus de
  // handtekening hoeft niet apart gecontroleerd te worden (OpenID Connect Core, 3.1.3.7).
  return JSON.parse(new TextDecoder().decode(fromB64url(t.split(".")[1])));
}

async function identity(req, env, p, code, st) {
  const cfg = await getConfig(env);
  const c = cfg[p], e = endpoints(p, c, env);
  const form = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, grant_type: "authorization_code", redirect_uri: callbackUrl(req, p) });
  if (p !== "smartschool") form.set("code_verifier", st.verifier);
  const r = await fetch(e.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || tok.error) { console.error("token", p, r.status, tok); throw new Fout(502, "Inloggen is mislukt. Probeer het opnieuw."); }

  if (p === "google") {
    const c2 = decodeJwt(tok.id_token);
    if (c2.aud !== c.clientId) throw new Fout(502, "Inloggen is mislukt.");
    return { sub: c2.sub, naam: c2.name || c2.email || "", email: c2.email_verified === false ? "" : (c2.email || "") };
  }
  if (p === "microsoft") {
    const c2 = decodeJwt(tok.id_token);
    if (c2.aud !== c.clientId) throw new Fout(502, "Inloggen is mislukt.");
    return { sub: `${c2.tid}:${c2.oid || c2.sub}`, naam: c2.name || c2.preferred_username || "", email: c2.email || c2.preferred_username || "" };
  }
  // Smartschool
  const u = await fetch(`${e.userinfo}?access_token=${encodeURIComponent(tok.access_token)}`, { headers: { Accept: "application/json" } });
  const info = await u.json().catch(() => ({}));
  if (!u.ok || !info.userID) { console.error("userinfo", u.status, info); throw new Fout(502, "Inloggen is mislukt. Probeer het opnieuw."); }
  if (Number(info.isCoAccount)) throw new Fout(403, "Log in met je eigen Smartschool-account, niet met een co-account (ouder).");
  return { sub: `${info.platform || c.platform}|${info.userID}`, naam: [info.name, info.surname].filter(Boolean).join(" ") || info.fullname || info.username || "", email: "" };
}

export async function callback(req, env, p) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const st = state && await env.KV.get(`oauth:${state}`, "json");
  const back = hash => redirect(`${(st && st.terug) || allowedOrigins(env)[0] || "/"}`.replace(/#.*$/, "") + hash);
  if (!st || st.p !== p) return back("#/login?fout=" + encodeURIComponent("Inloggen is verlopen. Probeer opnieuw."));
  await env.KV.delete(`oauth:${state}`);
  if (url.searchParams.get("error")) return back("#/login?fout=" + encodeURIComponent("Inloggen is geannuleerd."));
  try {
    const id = await identity(req, env, p, url.searchParams.get("code") || "", st);
    const now = Date.now();
    const naam = clean(id.naam, 100), email = clean(id.email, 200).toLowerCase();
    let u = await env.DB.prepare("SELECT id FROM gebruikers WHERE provider = ? AND sub = ?").bind(p, id.sub).first();
    if (u) await env.DB.prepare("UPDATE gebruikers SET naam = ?, email = ?, laatst = ? WHERE id = ?").bind(naam, email, now, u.id).run();
    else {
      u = { id: crypto.randomUUID() };
      await env.DB.prepare("INSERT INTO gebruikers (id, provider, sub, naam, email, rol, aangemaakt, laatst) VALUES (?, ?, ?, ?, ?, 'leerling', ?, ?)").bind(u.id, p, id.sub, naam, email, now, now).run();
    }
    const s = await issueSession(env, u.id);
    return back(`#/aangemeld?t=${encodeURIComponent(s.token)}&exp=${s.verloopt}`);
  } catch (e) {
    console.error(e);
    return back("#/login?fout=" + encodeURIComponent(e instanceof Fout ? e.message : "Inloggen is mislukt. Probeer het opnieuw."));
  }
}

export { json };
