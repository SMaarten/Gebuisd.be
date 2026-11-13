// Gebuisd.be API (Cloudflare Worker)
//
// Bewaart de geheime sleutels (Claude en GitHub) zodat ze nooit in de browser van een bezoeker komen.
//  - bezoekers: bestanden uploaden en een hoofdstuk voorstellen, zonder login
//  - admin (wachtwoord): voorstellen bekijken, vragen laten maken, online zetten, sleutels beheren
//
// Opslag (KV):  config            sleutels, repo, branch
//               voorstel:<id>     een ingediend voorstel
//               upload:<fileId>   geüpload maar nog niet aan een voorstel gekoppeld (na 1 dag opgeruimd)
//               rl:<...>          tellers tegen misbruik
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { MODEL, SYSTEM, SCHEMA, taskText } from "./prompt.js";
import { validateChapter, serializeChapter, catalogEntry, sortCatalog } from "../../js/util.js";

const MB = 1024 * 1024;
const MAX_FILE = 25 * MB;
const MAX_TOTAL = 30 * MB;
const MAX_FILES = 20;
const ORPHAN_AGE = 24 * 3600 * 1000;    // upload zonder voorstel: na 1 dag opruimen
const SESSION_TTL = 7 * 24 * 3600;
const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "text/plain"];

/* ---------- Hulpfuncties ---------- */

class Fout extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Bestandsnaam",
    "Access-Control-Max-Age": "86400"
  };
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

const ip = req => req.headers.get("CF-Connecting-IP") || "lokaal";

async function rateLimit(env, kind, who, max, windowSec) {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${kind}:${who}:${slot}`;
  const n = Number(await env.KV.get(k)) || 0;
  if (n >= max) throw new Fout(429, "Te veel pogingen. Probeer het later opnieuw.");
  await env.KV.put(k, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) });
}

async function getConfig(env) {
  const c = (await env.KV.get("config", "json")) || {};
  return { anthropicKey: "", githubToken: "", repo: env.DEFAULT_REPO || "", branch: env.DEFAULT_BRANCH || "main", ...c };
}

function claude(env, cfg) {
  if (!cfg.anthropicKey) throw new Fout(503, "De Claude-sleutel is nog niet ingesteld. De beheerder moet die eerst invullen.");
  return new Anthropic({ apiKey: cfg.anthropicKey, maxRetries: 2, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
}

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function sessionKey(env) {
  if (!env.ADMIN_PASSWORD) throw new Fout(503, "Er is nog geen admin-wachtwoord ingesteld op de server.");
  // afgeleid van het wachtwoord: een nieuw wachtwoord maakt alle oude sessies ongeldig
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("sessie:" + env.ADMIN_PASSWORD)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeToken(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const body = b64url(enc.encode(JSON.stringify({ exp })));
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(body));
  return { token: body + "." + b64url(sig), verloopt: exp * 1000 };
}

async function requireAdmin(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const [body, sig] = auth.replace(/^Bearer\s+/i, "").split(".");
  if (body && sig) {
    try {
      const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), fromB64url(sig), enc.encode(body));
      if (ok && JSON.parse(new TextDecoder().decode(fromB64url(body))).exp * 1000 > Date.now()) return;
    } catch (e) { if (e instanceof Fout) throw e; }
  }
  throw new Fout(401, "Niet ingelogd of je sessie is verlopen.");
}

async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const mask = s => s ? s.slice(0, 7) + "…" + s.slice(-4) : "";
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
const newId = () => Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);

/* ---------- Bezoekers ---------- */

async function upload(req, env) {
  await rateLimit(env, "upload", ip(req), 30, 3600);
  const type = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!TYPES.includes(type)) throw new Fout(415, "Dit bestandstype wordt niet ondersteund. Gebruik PDF, JPG, PNG of tekst.");
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_FILE) throw new Fout(413, "Dit bestand is te groot (max. 25 MB).");
  let naam = "bestand";
  try { naam = clean(decodeURIComponent(req.headers.get("X-Bestandsnaam") || "bestand"), 120) || "bestand"; } catch {}
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new Fout(400, "Het bestand is leeg.");
  if (buf.byteLength > MAX_FILE) throw new Fout(413, "Dit bestand is te groot (max. 25 MB).");

  // bezoekers krijgen een neutrale melding, zonder te vermelden welke dienst erachter zit
  const cfg = await getConfig(env);
  if (!cfg.anthropicKey) throw new Fout(503, "Insturen is nog niet mogelijk. Probeer het later opnieuw.");
  // geen vervaldatum: de cursus blijft bij Claude bewaard tot de admin het voorstel verwijdert
  let meta;
  try { meta = await claude(env, cfg).files.upload({ file: await toFile(buf, naam, { type }) }); }
  catch (e) { console.error(e); throw new Fout(503, "Het uploaden lukt nu even niet. Probeer het later opnieuw."); }
  const info = { id: meta.id, naam, grootte: buf.byteLength, type, ts: Date.now() };
  await env.KV.put(`upload:${meta.id}`, JSON.stringify(info));
  return json(info, 201);
}

async function propose(req, env) {
  await rateLimit(env, "voorstel", ip(req), 5, 3600);
  await rateLimit(env, "voorstel-dag", "alle", 50, 24 * 3600);
  const b = await req.json().catch(() => ({}));
  const v = {
    vak: clean(b.vak, 60), graad: clean(b.graad, 30), nr: clean(b.nr, 10), titel: clean(b.titel, 120),
    opmerking: clean(b.opmerking, 2000), naam: clean(b.naam, 80)
  };
  if (!v.vak || !v.nr) throw new Fout(400, "Vul minstens het vak en het hoofdstuknummer in.");
  const ids = [...new Set(Array.isArray(b.bestanden) ? b.bestanden : [])].slice(0, MAX_FILES + 1);
  if (!ids.length) throw new Fout(400, "Voeg minstens één bestand toe.");
  if (ids.length > MAX_FILES) throw new Fout(400, `Maximaal ${MAX_FILES} bestanden.`);
  // enkel bestanden die net via /upload binnenkwamen
  const bestanden = [];
  for (const id of ids) {
    const info = await env.KV.get(`upload:${String(id)}`, "json");
    if (!info) throw new Fout(400, "Een bestand is niet (meer) gevonden. Upload het opnieuw.");
    bestanden.push(info);
  }
  if (bestanden.reduce((n, f) => n + f.grootte, 0) > MAX_TOTAL) throw new Fout(413, "De bestanden zijn samen te groot (max. 30 MB).");
  const voorstel = { id: newId(), ingediend: Date.now(), ...v, bestanden };
  await env.KV.put(`voorstel:${voorstel.id}`, JSON.stringify(voorstel));
  await Promise.all(bestanden.map(f => env.KV.delete(`upload:${f.id}`)));
  return json({ ok: true, id: voorstel.id }, 201);
}

async function login(req, env) {
  await rateLimit(env, "login", ip(req), 10, 3600);
  const b = await req.json().catch(() => ({}));
  if (!env.ADMIN_PASSWORD) throw new Fout(503, "Er is nog geen admin-wachtwoord ingesteld op de server.");
  if (!b.wachtwoord || !(await sameSecret(b.wachtwoord, env.ADMIN_PASSWORD))) throw new Fout(401, "Verkeerd wachtwoord.");
  return json(await makeToken(env));
}

/* ---------- Admin: voorstellen ---------- */

// Uploads waarvoor nooit een voorstel verstuurd werd, verwijderen bij Claude.
async function cleanOrphans(env) {
  const page = await env.KV.list({ prefix: "upload:" });
  const old = [];
  for (const k of page.keys) {
    const info = await env.KV.get(k.name, "json");
    if (!info || Date.now() - (info.ts || 0) > ORPHAN_AGE) old.push(info?.id || k.name.slice(7));
  }
  if (!old.length) return;
  const cfg = await getConfig(env);
  const c = cfg.anthropicKey ? claude(env, cfg) : null;
  await Promise.all(old.map(async id => { if (c) await c.files.delete(id).catch(() => {}); await env.KV.delete(`upload:${id}`); }));
}

async function listProposals(env, ctx) {
  ctx.waitUntil(cleanOrphans(env).catch(e => console.error(e)));
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "voorstel:", cursor });
    for (const k of page.keys) { const v = await env.KV.get(k.name, "json"); if (v) out.push(v); }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && out.length < 200);
  return out.sort((a, b) => b.ingediend - a.ingediend);
}

async function getProposal(env, id) {
  const v = await env.KV.get(`voorstel:${id}`, "json");
  if (!v) throw new Fout(404, "Dit voorstel bestaat niet (meer).");
  return v;
}

async function deleteProposal(env, id) {
  const v = await getProposal(env, id);
  const cfg = await getConfig(env);
  if (cfg.anthropicKey) {
    const c = claude(env, cfg);
    await Promise.all(v.bestanden.map(f => c.files.delete(f.id).catch(() => {})));
  }
  await env.KV.delete(`voorstel:${id}`);
}

// Streamt voortgang als JSON-regels: {type:"bezig", vragen} … {type:"klaar", tekst, stop_reason, usage}
async function generate(env, id, ctx) {
  const v = await getProposal(env, id);
  const cfg = await getConfig(env);
  const client = claude(env, cfg);
  const content = v.bestanden.map(f => f.type.startsWith("image/")
    ? { type: "image", source: { type: "file", file_id: f.id } }
    : { type: "document", source: { type: "file", file_id: f.id }, title: f.naam });
  content.push({ type: "text", text: taskText(v) });

  const params = {
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
    // bij een weigering door de veiligheidsfilter probeert de API zelf een ander model
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default"
  };

  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const send = o => w.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});

  ctx.waitUntil((async () => {
    let text = "";
    const beat = setInterval(() => send({ type: "bezig", vragen: (text.match(/"vraag"\s*:/g) || []).length }), 2000);
    const run = async p => {
      text = "";
      const stream = client.beta.messages.stream(p);
      stream.on("text", d => { text += d; });
      return stream.finalMessage();
    };
    try {
      let msg;
      try { msg = await run(params); }
      catch (e) {
        // als de fallback-optie (nog) niet aanvaard wordt: opnieuw zonder
        if (e?.status === 400 && /fallback|beta/i.test(e.message || "")) {
          const { betas, fallbacks, ...rest } = params;
          msg = await run(rest);
        } else throw e;
      }
      // enkel de tekst na een eventuele overstap naar een ander model telt
      let start = 0;
      msg.content.forEach((b, i) => { if (b.type === "fallback") start = i + 1; });
      const tekst = msg.content.slice(start).filter(b => b.type === "text").map(b => b.text).join("");
      await send({ type: "klaar", tekst, stop_reason: msg.stop_reason, usage: msg.usage });
    } catch (e) {
      console.error(e);
      await send({ type: "fout", status: e?.status || 500, melding: claudeError(e) });
    } finally {
      clearInterval(beat);
      await w.close().catch(() => {});
    }
  })());

  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

function claudeError(e) {
  const s = e?.status;
  if (s === 401) return "De Claude-sleutel klopt niet. Controleer hem bij Instellingen.";
  if (s === 403) return "Deze Claude-sleutel heeft geen toegang. Controleer je account op platform.claude.com.";
  if (s === 404) return "Een bestand van dit voorstel bestaat niet meer bij Claude.";
  if (s === 429) return "Te veel aanvragen of je Claude-tegoed is op.";
  if (s === 529 || s >= 500) return "De Claude-server is even overbelast. Probeer het over een paar minuten opnieuw.";
  if (s === 400) return "Claude weigerde de aanvraag: " + (e.error?.error?.message || e.message);
  return e?.message || String(e);
}

/* ---------- Admin: instellingen ---------- */

async function showSettings(env) {
  const c = await getConfig(env);
  return { anthropicKey: mask(c.anthropicKey), githubToken: mask(c.githubToken), repo: c.repo, branch: c.branch };
}

async function saveSettings(req, env) {
  const b = await req.json().catch(() => ({}));
  const c = await getConfig(env);
  if (typeof b.anthropicKey === "string" && b.anthropicKey.trim()) c.anthropicKey = b.anthropicKey.trim();
  if (typeof b.githubToken === "string" && b.githubToken.trim()) c.githubToken = b.githubToken.trim();
  if (b.wisAnthropic) c.anthropicKey = "";
  if (b.wisGithub) c.githubToken = "";
  if (typeof b.repo === "string" && b.repo.trim()) {
    const repo = b.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Fout(400, "Repository moet de vorm eigenaar/naam hebben.");
    c.repo = repo;
  }
  if (typeof b.branch === "string" && b.branch.trim()) c.branch = b.branch.trim();
  await env.KV.put("config", JSON.stringify(c));
  return showSettings(env);
}

async function testSettings(env) {
  const c = await getConfig(env);
  const res = {};
  try {
    if (!c.anthropicKey) res.claude = { ok: false, melding: "Geen sleutel ingevuld." };
    else { await claude(env, c).models.retrieve(MODEL); res.claude = { ok: true, melding: "In orde." }; }
  } catch (e) { res.claude = { ok: false, melding: claudeError(e) }; }
  try {
    const repo = await gh(env, c, "");
    await gh(env, c, `/branches/${encodeURIComponent(c.branch)}`);
    res.github = repo.permissions && repo.permissions.push === false
      ? { ok: false, melding: "Verbonden, maar het token mag niet schrijven." }
      : { ok: true, melding: `In orde (${repo.full_name}, branch ${c.branch}).` };
  } catch (e) { res.github = { ok: false, melding: e.message }; }
  return res;
}

/* ---------- Admin: GitHub ---------- */

function b64encode(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

async function gh(env, cfg, path, opts = {}) {
  if (!cfg.githubToken) throw new Fout(503, "Het GitHub-token is nog niet ingesteld.");
  if (!cfg.repo) throw new Fout(503, "De repository is nog niet ingesteld.");
  const r = await fetch(`${env.GITHUB_API || "https://api.github.com"}/repos/${cfg.repo}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${cfg.githubToken}`, "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gebuisd-api", ...(opts.body ? { "Content-Type": "application/json" } : {})
    }
  });
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).message; } catch {}
    if (r.status === 401) throw new Fout(502, "Het GitHub-token klopt niet of is verlopen.");
    if (r.status === 403) throw new Fout(502, "Het GitHub-token mag niet schrijven in deze repo. Geef het 'Contents: Read and write'.");
    if (r.status === 404) throw new Fout(502, `Repo of branch niet gevonden (${cfg.repo}, ${cfg.branch}), of het token heeft er geen toegang toe.`);
    if (r.status === 409) { const e = new Fout(409, "conflict"); e.conflict = true; throw e; }
    throw new Fout(502, `GitHub gaf een fout (${r.status}): ${detail}`);
  }
  return r.status === 204 ? null : r.json();
}

async function getFile(env, cfg, path) {
  const f = await gh(env, cfg, `/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`, { allow404: true });
  return f ? { sha: f.sha, text: b64decode(f.content) } : null;
}

const putFile = (env, cfg, path, text, sha, message) =>
  gh(env, cfg, `/contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: b64encode(text), branch: cfg.branch, ...(sha ? { sha } : {}) }) });

// Catalogus aanpassen; bij een conflict (iemand anders schreef net) één keer opnieuw.
async function updateCatalog(env, cfg, change, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await getFile(env, cfg, "data/catalog.json");
    const cat = f ? JSON.parse(f.text) : { hoofdstukken: [] };
    cat.hoofdstukken = sortCatalog(change(cat.hoofdstukken || []));
    try { return await putFile(env, cfg, "data/catalog.json", JSON.stringify(cat, null, 2) + "\n", f?.sha, message); }
    catch (e) { if (!e.conflict || attempt) throw e; }
  }
}

async function publish(req, env) {
  const b = await req.json().catch(() => ({}));
  const ch = b.hoofdstuk;
  const errs = validateChapter(ch);
  if (errs.length) throw new Fout(400, errs.join("\n"));
  const clean = {
    id: ch.id, vak: ch.vak, graad: ch.graad || "", nr: ch.nr || "", titel: ch.titel, beschrijving: ch.beschrijving || "",
    onderdelen: ch.onderdelen.map(o => ({ nr: String(o.nr || ""), titel: String(o.titel || "") })),
    vragen: ch.vragen.map(q => ({ o: q.o, v: q.v, a: q.a.map(String), u: q.u || "" }))
  };
  const cfg = await getConfig(env);
  const path = `data/${clean.id}.json`;
  const existing = await getFile(env, cfg, path);
  if (existing && !b.overschrijven) throw new Fout(409, "bestaat");
  const label = `${clean.vak} ${clean.graad} H${clean.nr}`.replace(/\s+/g, " ").trim();
  await putFile(env, cfg, path, serializeChapter(clean), existing?.sha, `${existing ? "Bijwerken" : "Toevoegen"}: ${label} ${clean.titel} (${clean.vragen.length} vragen)`);
  await updateCatalog(env, cfg, list => [...list.filter(h => h.id !== clean.id), catalogEntry(clean)], `Catalogus: ${label} ${clean.titel}`);
  // het voorstel en de cursus blijven bewaard (opnieuw vragen maken kan later), enkel gemarkeerd
  if (b.voorstel) {
    const v = await env.KV.get(`voorstel:${b.voorstel}`, "json");
    if (v) await env.KV.put(`voorstel:${v.id}`, JSON.stringify({ ...v, online: Date.now(), hoofdstuk: clean.id }));
  }
  return { ok: true, id: clean.id };
}

async function removeChapter(env, id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Fout(400, "Ongeldig hoofdstuk.");
  const cfg = await getConfig(env);
  await updateCatalog(env, cfg, list => list.filter(h => h.id !== id), `Catalogus: ${id} verwijderd`);
  const f = await getFile(env, cfg, `data/${id}.json`);
  if (f) await gh(env, cfg, `/contents/data/${id}.json`, { method: "DELETE", body: JSON.stringify({ message: `Verwijderen: ${id}`, sha: f.sha, branch: cfg.branch }) });
  return { ok: true };
}

/* ---------- Router ---------- */

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  let r;

  if (m === "GET" && p === "/status") {
    const c = await getConfig(env);
    return json({ ok: true, voorstellen: !!c.anthropicKey });
  }
  if (m === "POST" && p === "/upload") return upload(req, env);
  if (m === "POST" && p === "/voorstel") return propose(req, env);
  if (m === "POST" && p === "/login") return login(req, env);

  await requireAdmin(req, env);
  if (m === "GET" && p === "/sessie") return json({ ok: true });
  if (m === "GET" && p === "/voorstellen") return json(await listProposals(env, ctx));
  if ((r = p.match(/^\/voorstellen\/([\w-]+)$/)) && m === "DELETE") { await deleteProposal(env, r[1]); return json({ ok: true }); }
  if ((r = p.match(/^\/voorstellen\/([\w-]+)\/genereer$/)) && m === "POST") return generate(env, r[1], ctx);
  if (m === "GET" && p === "/instellingen") return json(await showSettings(env));
  if (m === "PUT" && p === "/instellingen") return json(await saveSettings(req, env));
  if (m === "POST" && p === "/instellingen/test") return json(await testSettings(env));
  if (m === "POST" && p === "/hoofdstukken") return json(await publish(req, env));
  if ((r = p.match(/^\/hoofdstukken\/([\w-]+)$/)) && m === "DELETE") return json(await removeChapter(env, r[1]));
  throw new Fout(404, "Niet gevonden.");
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      const res = await handle(req, env, ctx);
      for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (!(e instanceof Fout)) console.error(e);
      const status = e instanceof Fout ? e.status : (e?.status === 401 ? 502 : 500);
      const melding = e instanceof Fout ? e.message : (e?.status ? claudeError(e) : "Er ging iets mis op de server.");
      return json({ fout: melding }, status, h);
    }
  }
};
