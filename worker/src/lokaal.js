// Eigen accounts: zelf een gebruikersnaam en wachtwoord kiezen (zonder Google, Microsoft of Smartschool).
// Wachtwoorden worden nooit bewaard, enkel een PBKDF2-SHA256-hash met een eigen zout per account.
import { Fout, enc, b64url, fromB64url, clean, rateLimit, ip } from "./common.js";
import { issueSession } from "./auth.js";

const ITER = 100000;            // maximum dat Cloudflare Workers toelaat
const NAAM_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const MIN_PW = 8;

async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(await pbkdf2(pw, salt, ITER))}`;
}

async function checkPassword(pw, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2") return false;
  const got = await pbkdf2(pw, fromB64url(salt), Number(iter));
  const want = fromB64url(hash);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

function checkNewPassword(pw, gebruikersnaam) {
  if (typeof pw !== "string" || pw.length < MIN_PW) throw new Fout(400, `Kies een wachtwoord van minstens ${MIN_PW} tekens.`);
  if (pw.length > 200) throw new Fout(400, "Dit wachtwoord is te lang.");
  if (gebruikersnaam && pw.toLowerCase().includes(gebruikersnaam)) throw new Fout(400, "Je wachtwoord mag je gebruikersnaam niet bevatten.");
}

const normName = s => String(s || "").trim().toLowerCase();

export async function register(req, env) {
  await rateLimit(env, "registreer", ip(req), 5, 3600);
  const b = await req.json().catch(() => ({}));
  const gebruikersnaam = normName(b.gebruikersnaam);
  if (!NAAM_RE.test(gebruikersnaam)) throw new Fout(400, "Kies een gebruikersnaam van 3 tot 30 tekens: letters, cijfers, punt, liggend streepje of koppelteken.");
  const naam = clean(b.naam, 100) || gebruikersnaam;
  checkNewPassword(b.wachtwoord, gebruikersnaam);
  const bestaat = await env.DB.prepare("SELECT 1 FROM gebruikers WHERE provider = 'lokaal' AND sub = ?").bind(gebruikersnaam).first();
  if (bestaat) throw new Fout(409, "Deze gebruikersnaam is al in gebruik. Kies een andere.");
  const id = crypto.randomUUID(), now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO gebruikers (id, provider, sub, naam, email, rol, aangemaakt, laatst) VALUES (?, 'lokaal', ?, ?, '', 'leerling', ?, ?)").bind(id, gebruikersnaam, naam, now, now),
      env.DB.prepare("INSERT INTO wachtwoorden (gebruiker, hash, gewijzigd) VALUES (?, ?, ?)").bind(id, await hashPassword(b.wachtwoord), now)
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new Fout(409, "Deze gebruikersnaam is al in gebruik. Kies een andere.");
    throw e;
  }
  return issueSession(env, id);
}

export async function login(req, env) {
  const b = await req.json().catch(() => ({}));
  const gebruikersnaam = normName(b.gebruikersnaam);
  // tegen raden: per IP én per gebruikersnaam beperkt
  await rateLimit(env, "aanmelden-ip", ip(req), 20, 900);
  await rateLimit(env, "aanmelden-naam", gebruikersnaam || "-", 10, 900);
  const u = gebruikersnaam && await env.DB.prepare(
    "SELECT g.id, w.hash FROM gebruikers g JOIN wachtwoorden w ON w.gebruiker = g.id WHERE g.provider = 'lokaal' AND g.sub = ?"
  ).bind(gebruikersnaam).first();
  // ook zonder account een hash berekenen, zodat de responstijd niet verraadt of de naam bestaat
  const ok = await checkPassword(String(b.wachtwoord || ""), u ? u.hash : "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  if (!u || !ok) throw new Fout(401, "Gebruikersnaam of wachtwoord klopt niet.");
  await env.DB.prepare("UPDATE gebruikers SET laatst = ? WHERE id = ?").bind(Date.now(), u.id).run();
  return issueSession(env, u.id);
}

export async function changePassword(req, env, u) {
  if (u.provider !== "lokaal") throw new Fout(400, "Je logt in via " + u.provider + "; je wachtwoord wijzig je daar.");
  await rateLimit(env, "wachtwoord", u.id, 10, 3600);
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT hash FROM wachtwoorden WHERE gebruiker = ?").bind(u.id).first();
  if (!row || !(await checkPassword(String(b.oud || ""), row.hash))) throw new Fout(400, "Je huidige wachtwoord klopt niet.");
  const naam = await env.DB.prepare("SELECT sub FROM gebruikers WHERE id = ?").bind(u.id).first();
  checkNewPassword(b.nieuw, naam?.sub);
  await env.DB.prepare("UPDATE wachtwoorden SET hash = ?, gewijzigd = ? WHERE gebruiker = ?").bind(await hashPassword(b.nieuw), Date.now(), u.id).run();
  return { ok: true };
}

// Admin: een tijdelijk wachtwoord instellen voor wie het vergeten is (er is geen e-mail om het te herstellen).
export async function adminReset(req, env, id) {
  const b = await req.json().catch(() => ({}));
  const u = await env.DB.prepare("SELECT sub FROM gebruikers WHERE id = ? AND provider = 'lokaal'").bind(id).first();
  if (!u) throw new Fout(404, "Dit is geen account met gebruikersnaam en wachtwoord.");
  checkNewPassword(b.wachtwoord, u.sub);
  await env.DB.prepare("INSERT INTO wachtwoorden (gebruiker, hash, gewijzigd) VALUES (?, ?, ?) ON CONFLICT (gebruiker) DO UPDATE SET hash = excluded.hash, gewijzigd = excluded.gewijzigd")
    .bind(id, await hashPassword(b.wachtwoord), Date.now()).run();
  return { ok: true };
}
