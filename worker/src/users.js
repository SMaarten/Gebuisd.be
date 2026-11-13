// Historiek van toetsen, klassen voor leerkrachten en gebruikersbeheer (Cloudflare D1).
import { Fout, clean } from "./common.js";

const HID = /^[a-z0-9-]{1,80}$/;
const num = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };

function checkResult(r) {
  if (!r || !HID.test(String(r.hoofdstuk || ""))) throw new Fout(400, "Ongeldig resultaat.");
  const n = num(r.n, 1, 100);
  return {
    hoofdstuk: r.hoofdstuk, n,
    score: num(r.score, 0, n),
    tijd: num(r.tijd, 0, 24 * 3600),
    datum: num(r.datum || Date.now(), 0, Date.now() + 60000),
    onderdelen: JSON.stringify(Array.isArray(r.onderdelen) ? r.onderdelen.slice(0, 30).map(o => [clean(o[0], 10), num(o[1], 0, 100), num(o[2], 0, 100)]) : [])
  };
}

/* ---------- Leerling ---------- */

export async function me(env, u) {
  const kl = await env.DB.prepare(
    "SELECT k.id, k.naam, g.naam AS leerkracht FROM leden l JOIN klassen k ON k.id = l.klas JOIN gebruikers g ON g.id = k.leerkracht WHERE l.gebruiker = ? ORDER BY k.naam"
  ).bind(u.id).all();
  return { naam: u.naam, email: u.email, provider: u.provider, rol: u.rol, klassen: kl.results };
}

export async function deleteMe(env, u) {
  // alles van deze gebruiker weg (ook klassen die hij als leerkracht maakte)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM leden WHERE gebruiker = ? OR klas IN (SELECT id FROM klassen WHERE leerkracht = ?)").bind(u.id, u.id),
    env.DB.prepare("DELETE FROM klassen WHERE leerkracht = ?").bind(u.id),
    env.DB.prepare("DELETE FROM resultaten WHERE gebruiker = ?").bind(u.id),
    env.DB.prepare("DELETE FROM gezien WHERE gebruiker = ?").bind(u.id),
    env.DB.prepare("DELETE FROM gebruikers WHERE id = ?").bind(u.id)
  ]);
  return { ok: true };
}

export async function history(env, u, hoofdstuk) {
  const q = hoofdstuk
    ? env.DB.prepare("SELECT hoofdstuk, datum, score, n, tijd, onderdelen FROM resultaten WHERE gebruiker = ? AND hoofdstuk = ? ORDER BY datum DESC LIMIT 200").bind(u.id, hoofdstuk)
    : env.DB.prepare("SELECT hoofdstuk, datum, score, n, tijd, onderdelen FROM resultaten WHERE gebruiker = ? ORDER BY datum DESC LIMIT 1000").bind(u.id);
  const r = await q.all();
  return r.results.map(x => ({ ...x, onderdelen: JSON.parse(x.onderdelen || "[]") }));
}

const insertResult = (env, u, r) =>
  env.DB.prepare("INSERT OR IGNORE INTO resultaten (gebruiker, hoofdstuk, datum, score, n, tijd, onderdelen) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, r.hoofdstuk, r.datum, r.score, r.n, r.tijd, r.onderdelen);

export async function addResult(env, u, body) {
  await insertResult(env, u, checkResult(body)).run();
  return { ok: true };
}

// Bij de eerste login: historiek die al in de browser stond, overnemen.
export async function importResults(env, u, body) {
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, 500).map(checkResult);
  if (items.length) await env.DB.batch(items.map(r => insertResult(env, u, r)));
  return { ok: true, aantal: items.length };
}

export async function getSeen(env, u, h) {
  if (!HID.test(h)) throw new Fout(400, "Ongeldig hoofdstuk.");
  const r = await env.DB.prepare("SELECT ids FROM gezien WHERE gebruiker = ? AND hoofdstuk = ?").bind(u.id, h).first();
  return { ids: r ? JSON.parse(r.ids) : [] };
}

export async function putSeen(env, u, h, body) {
  if (!HID.test(h)) throw new Fout(400, "Ongeldig hoofdstuk.");
  const ids = (Array.isArray(body?.ids) ? body.ids : []).filter(Number.isInteger).slice(-2000);
  await env.DB.prepare("INSERT INTO gezien (gebruiker, hoofdstuk, ids) VALUES (?, ?, ?) ON CONFLICT (gebruiker, hoofdstuk) DO UPDATE SET ids = excluded.ids")
    .bind(u.id, h, JSON.stringify(ids)).run();
  return { ok: true };
}

export async function joinClass(env, u, body) {
  const code = clean(body?.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const k = code && await env.DB.prepare("SELECT id, naam FROM klassen WHERE code = ?").bind(code).first();
  if (!k) throw new Fout(404, "Deze klascode bestaat niet. Controleer de code bij je leerkracht.");
  await env.DB.prepare("INSERT OR IGNORE INTO leden (klas, gebruiker, sinds) VALUES (?, ?, ?)").bind(k.id, u.id, Date.now()).run();
  return { ok: true, klas: k.naam };
}

export async function leaveClass(env, u, klas) {
  await env.DB.prepare("DELETE FROM leden WHERE klas = ? AND gebruiker = ?").bind(klas, u.id).run();
  return { ok: true };
}

/* ---------- Leerkracht ---------- */

function requireTeacher(u) {
  if (u.rol !== "leerkracht") throw new Fout(403, "Enkel voor leerkrachten. Vraag de beheerder om je de rol leerkracht te geven.");
}

// Leesbare code zonder verwarrende tekens (0/O, 1/I/L).
function makeCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map(x => abc[x % abc.length]).join("");
}

export async function myClasses(env, u) {
  requireTeacher(u);
  const r = await env.DB.prepare(
    "SELECT k.id, k.naam, k.code, k.aangemaakt, (SELECT COUNT(*) FROM leden l WHERE l.klas = k.id) AS leden FROM klassen k WHERE k.leerkracht = ? ORDER BY k.naam"
  ).bind(u.id).all();
  return r.results;
}

export async function createClass(env, u, body) {
  requireTeacher(u);
  const naam = clean(body?.naam, 60);
  if (!naam) throw new Fout(400, "Geef de klas een naam.");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM klassen WHERE leerkracht = ?").bind(u.id).first();
  if (count.n >= 50) throw new Fout(400, "Je hebt al 50 klassen.");
  for (let i = 0; i < 5; i++) {
    const k = { id: crypto.randomUUID(), code: makeCode() };
    try {
      await env.DB.prepare("INSERT INTO klassen (id, naam, code, leerkracht, aangemaakt) VALUES (?, ?, ?, ?, ?)").bind(k.id, naam, k.code, u.id, Date.now()).run();
      return { id: k.id, naam, code: k.code };
    } catch (e) { if (!/UNIQUE/i.test(String(e))) throw e; }
  }
  throw new Fout(500, "Kon geen klascode maken. Probeer opnieuw.");
}

async function ownClass(env, u, id) {
  requireTeacher(u);
  const k = await env.DB.prepare("SELECT id, naam, code FROM klassen WHERE id = ? AND leerkracht = ?").bind(id, u.id).first();
  if (!k) throw new Fout(404, "Deze klas bestaat niet.");
  return k;
}

export async function deleteClass(env, u, id) {
  await ownClass(env, u, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM leden WHERE klas = ?").bind(id),
    env.DB.prepare("DELETE FROM klassen WHERE id = ?").bind(id)
  ]);
  return { ok: true };
}

export async function removeMember(env, u, id, member) {
  await ownClass(env, u, id);
  await env.DB.prepare("DELETE FROM leden WHERE klas = ? AND gebruiker = ?").bind(id, member).run();
  return { ok: true };
}

// Overzicht: per leerling en per hoofdstuk het aantal toetsen, de laatste en de beste score.
// Enkel resultaten van na het lid worden van de klas.
export async function classOverview(env, u, id) {
  const k = await ownClass(env, u, id);
  const leden = await env.DB.prepare(
    "SELECT g.id, g.naam, g.email, l.sinds FROM leden l JOIN gebruikers g ON g.id = l.gebruiker WHERE l.klas = ? ORDER BY g.naam"
  ).bind(id).all();
  const res = await env.DB.prepare(
    `SELECT r.gebruiker, r.hoofdstuk, COUNT(*) AS aantal, MAX(r.datum) AS laatst,
            MAX(CAST(r.score AS REAL) / r.n) AS beste,
            (SELECT r2.score || '/' || r2.n FROM resultaten r2 WHERE r2.gebruiker = r.gebruiker AND r2.hoofdstuk = r.hoofdstuk ORDER BY r2.datum DESC LIMIT 1) AS laatste
     FROM resultaten r JOIN leden l ON l.gebruiker = r.gebruiker AND l.klas = ?
     WHERE r.datum >= l.sinds
     GROUP BY r.gebruiker, r.hoofdstuk`
  ).bind(id).all();
  return { klas: k, leden: leden.results, resultaten: res.results };
}

/* ---------- Admin ---------- */

export async function listUsers(env) {
  const r = await env.DB.prepare(
    `SELECT g.id, g.naam, g.email, g.provider, g.rol, g.aangemaakt, g.laatst,
            (SELECT COUNT(*) FROM resultaten r WHERE r.gebruiker = g.id) AS toetsen
     FROM gebruikers g ORDER BY g.rol DESC, g.naam LIMIT 2000`
  ).all();
  return r.results;
}

export async function setRole(env, id, body) {
  const rol = body?.rol === "leerkracht" ? "leerkracht" : "leerling";
  const r = await env.DB.prepare("UPDATE gebruikers SET rol = ? WHERE id = ?").bind(rol, id).run();
  if (!r.meta.changes) throw new Fout(404, "Gebruiker niet gevonden.");
  return { ok: true, rol };
}

export async function deleteUser(env, id) {
  return deleteMe(env, { id });
}
