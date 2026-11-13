// Gebuisd.be API (Cloudflare Worker)
//
// Bewaart de geheime sleutels (Claude, GitHub, logins) zodat ze nooit in de browser van een bezoeker komen.
//  - iedereen:      toetsen maken (dat gebeurt volledig op de website, zonder deze server)
//  - ingelogd:      historiek op elk toestel, lid worden van een klas, een hoofdstuk voorstellen
//  - leerkracht:    klassen maken en de resultaten van de leerlingen in die klassen bekijken
//  - admin (wachtwoord): voorstellen behandelen, online zetten, gebruikers en sleutels beheren
//
// Opslag:  KV  config            sleutels, repo, branch, logins
//              voorstel:<id>     een ingediend voorstel
//              upload:<fileId>   geüpload maar nog niet aan een voorstel gekoppeld (na 1 dag opgeruimd)
//              oauth:<state>     lopende login (10 minuten)
//              sessiesleutel     geheime sleutel voor leerlingensessies
//              rl:<...>          tellers tegen misbruik
//          D1  gebruikers, resultaten, gezien, klassen, leden (zie schema.sql)
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { MODEL, SYSTEM, SCHEMA, taskText } from "./prompt.js";
import { validateChapter, serializeChapter, catalogEntry, sortCatalog } from "../../js/util.js";
import { Fout, json, ip, rateLimit, getConfig, enc, mask, clean, newId, allowedOrigins, hmacKey, signToken, verifyToken, bearer } from "./common.js";
import * as auth from "./auth.js";
import * as users from "./users.js";

const MB = 1024 * 1024;
const MAX_FILE = 25 * MB;
const MAX_TOTAL = 30 * MB;
const MAX_FILES = 20;
const ORPHAN_AGE = 24 * 3600 * 1000;    // upload zonder voorstel: na 1 dag opruimen
const ADMIN_TTL = 7 * 24 * 3600;
const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "text/plain"];

/* ---------- Hulpfuncties ---------- */

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const ok = allowedOrigins(env).includes(origin);
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Bestandsnaam",
    "Access-Control-Max-Age": "86400"
  };
}

function claude(env, cfg) {
  if (!cfg.anthropicKey) throw new Fout(503, "De Claude-sleutel is nog niet ingesteld. De beheerder moet die eerst invullen.");
  return new Anthropic({ apiKey: cfg.anthropicKey, maxRetries: 2, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
}

async function adminKey(env) {
  if (!env.ADMIN_PASSWORD) throw new Fout(503, "Er is nog geen admin-wachtwoord ingesteld op de server.");
  // afgeleid van het wachtwoord: een nieuw wachtwoord maakt alle oude admin-sessies ongeldig
  return hmacKey(await crypto.subtle.digest("SHA-256", enc.encode("sessie:" + env.ADMIN_PASSWORD)));
}

async function requireAdmin(req, env) {
  const p = await verifyToken(await adminKey(env), bearer(req));
  if (!p || !p.admin) throw new Fout(401, "Niet ingelogd of je sessie is verlopen.");
}

async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/* ---------- Ingelogde gebruikers: voorstellen ---------- */

async function upload(req, env, u) {
  await rateLimit(env, "upload", u.id, 30, 3600);
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
  const info = { id: meta.id, naam, grootte: buf.byteLength, type, ts: Date.now(), door: u.id };
  await env.KV.put(`upload:${meta.id}`, JSON.stringify(info));
  return json({ id: info.id, naam, grootte: info.grootte }, 201);
}

async function propose(req, env, u) {
  await rateLimit(env, "voorstel", u.id, 5, 3600);
  await rateLimit(env, "voorstel-dag", "alle", 50, 24 * 3600);
  const b = await req.json().catch(() => ({}));
  const v = {
    vak: clean(b.vak, 60), graad: clean(b.graad, 30), nr: clean(b.nr, 10), titel: clean(b.titel, 120),
    opmerking: clean(b.opmerking, 2000)
  };
  if (!v.vak || !v.nr) throw new Fout(400, "Vul minstens het vak en het hoofdstuknummer in.");
  const ids = [...new Set(Array.isArray(b.bestanden) ? b.bestanden : [])].slice(0, MAX_FILES + 1);
  if (!ids.length) throw new Fout(400, "Voeg minstens één bestand toe.");
  if (ids.length > MAX_FILES) throw new Fout(400, `Maximaal ${MAX_FILES} bestanden.`);
  // enkel bestanden die deze gebruiker net via /upload instuurde
  const bestanden = [];
  for (const id of ids) {
    const info = await env.KV.get(`upload:${String(id)}`, "json");
    if (!info || info.door !== u.id) throw new Fout(400, "Een bestand is niet (meer) gevonden. Upload het opnieuw.");
    const { door, ...f } = info;
    bestanden.push(f);
  }
  if (bestanden.reduce((n, f) => n + f.grootte, 0) > MAX_TOTAL) throw new Fout(413, "De bestanden zijn samen te groot (max. 30 MB).");
  const voorstel = { id: newId(), ingediend: Date.now(), ...v, naam: u.naam, email: u.email, gebruiker: u.id, bestanden };
  await env.KV.put(`voorstel:${voorstel.id}`, JSON.stringify(voorstel));
  await Promise.all(bestanden.map(f => env.KV.delete(`upload:${f.id}`)));
  return json({ ok: true, id: voorstel.id }, 201);
}

async function adminLogin(req, env) {
  await rateLimit(env, "login", ip(req), 10, 3600);
  const b = await req.json().catch(() => ({}));
  if (!env.ADMIN_PASSWORD) throw new Fout(503, "Er is nog geen admin-wachtwoord ingesteld op de server.");
  if (!b.wachtwoord || !(await sameSecret(b.wachtwoord, env.ADMIN_PASSWORD))) throw new Fout(401, "Verkeerd wachtwoord.");
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
  return json({ token: await signToken(await adminKey(env), { admin: 1, exp }), verloopt: exp * 1000 });
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

async function showSettings(req, env) {
  const c = await getConfig(env);
  const origin = new URL(req.url).origin;
  const login = {};
  for (const p of auth.PROVIDERS) {
    const x = c[p] || {};
    login[p] = { clientId: x.clientId || "", clientSecret: mask(x.clientSecret), callback: `${origin}/auth/${p}/callback`, ...(p === "smartschool" ? { platform: x.platform || "" } : {}) };
  }
  return { anthropicKey: mask(c.anthropicKey), githubToken: mask(c.githubToken), repo: c.repo, branch: c.branch, login };
}

async function saveSettings(req, env) {
  const b = await req.json().catch(() => ({}));
  const c = await getConfig(env);
  if (typeof b.anthropicKey === "string" && b.anthropicKey.trim()) c.anthropicKey = b.anthropicKey.trim();
  if (typeof b.githubToken === "string" && b.githubToken.trim()) c.githubToken = b.githubToken.trim();
  if (typeof b.repo === "string" && b.repo.trim()) {
    const repo = b.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Fout(400, "Repository moet de vorm eigenaar/naam hebben.");
    c.repo = repo;
  }
  if (typeof b.branch === "string" && b.branch.trim()) c.branch = b.branch.trim();
  // logins: een leeg geheim behoudt het oude; "wis" schakelt de login uit
  for (const p of auth.PROVIDERS) {
    const x = b.login?.[p];
    if (!x) continue;
    const cur = { ...(c[p] || {}) };
    if (x.wis) { c[p] = { clientId: "", clientSecret: "", ...(p === "smartschool" ? { platform: "" } : {}) }; continue; }
    if (typeof x.clientId === "string") cur.clientId = x.clientId.trim();
    if (typeof x.clientSecret === "string" && x.clientSecret.trim()) cur.clientSecret = x.clientSecret.trim();
    if (p === "smartschool" && typeof x.platform === "string") {
      let pl = x.platform.trim().replace(/\/+$/, "");
      if (pl && !/^https:\/\//.test(pl)) pl = "https://" + pl;
      if (pl && !/^https:\/\/[\w-]+\.smartschool\.be$/.test(pl)) throw new Fout(400, "Het Smartschool-adres moet de vorm https://<school>.smartschool.be hebben.");
      cur.platform = pl;
    }
    c[p] = cur;
  }
  await env.KV.put("config", JSON.stringify(c));
  return showSettings(req, env);
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

  // ---- iedereen ----
  if (m === "GET" && p === "/status") {
    const c = await getConfig(env);
    return json({ ok: true, voorstellen: !!c.anthropicKey, logins: auth.enabledProviders(c) });
  }
  if (m === "POST" && p === "/login") return adminLogin(req, env);
  if ((r = p.match(/^\/auth\/(\w+)\/start$/)) && m === "GET") return auth.start(req, env, r[1]);
  if ((r = p.match(/^\/auth\/(\w+)\/callback$/)) && m === "GET") return auth.callback(req, env, r[1]);

  // ---- ingelogde leerling of leerkracht ----
  if (!p.startsWith("/admin/")) {
    const u = await auth.currentUser(req, env);
    if (m === "GET" && p === "/ik") return json(await users.me(env, u));
    if (m === "DELETE" && p === "/ik") return json(await users.deleteMe(env, u));
    if (m === "GET" && p === "/historiek") return json(await users.history(env, u, url.searchParams.get("hoofdstuk")));
    if (m === "POST" && p === "/historiek") return json(await users.addResult(env, u, await req.json().catch(() => null)), 201);
    if (m === "POST" && p === "/historiek/import") return json(await users.importResults(env, u, await req.json().catch(() => null)));
    if ((r = p.match(/^\/gezien\/([\w-]+)$/)) && m === "GET") return json(await users.getSeen(env, u, r[1]));
    if ((r = p.match(/^\/gezien\/([\w-]+)$/)) && m === "PUT") return json(await users.putSeen(env, u, r[1], await req.json().catch(() => null)));
    if (m === "POST" && p === "/klassen/lid") return json(await users.joinClass(env, u, await req.json().catch(() => null)));
    if ((r = p.match(/^\/klassen\/([\w-]+)\/lid$/)) && m === "DELETE") return json(await users.leaveClass(env, u, r[1]));
    if (m === "GET" && p === "/klassen") return json(await users.myClasses(env, u));
    if (m === "POST" && p === "/klassen") return json(await users.createClass(env, u, await req.json().catch(() => null)), 201);
    if ((r = p.match(/^\/klassen\/([\w-]+)$/)) && m === "GET") return json(await users.classOverview(env, u, r[1]));
    if ((r = p.match(/^\/klassen\/([\w-]+)$/)) && m === "DELETE") return json(await users.deleteClass(env, u, r[1]));
    if ((r = p.match(/^\/klassen\/([\w-]+)\/leden\/([\w-]+)$/)) && m === "DELETE") return json(await users.removeMember(env, u, r[1], r[2]));
    if (m === "POST" && p === "/upload") return upload(req, env, u);
    if (m === "POST" && p === "/voorstel") return propose(req, env, u);
    throw new Fout(404, "Niet gevonden.");
  }

  // ---- admin ----
  await requireAdmin(req, env);
  const ap = p.slice("/admin".length);
  if (m === "GET" && ap === "/sessie") return json({ ok: true });
  if (m === "GET" && ap === "/voorstellen") return json(await listProposals(env, ctx));
  if ((r = ap.match(/^\/voorstellen\/([\w-]+)$/)) && m === "DELETE") { await deleteProposal(env, r[1]); return json({ ok: true }); }
  if ((r = ap.match(/^\/voorstellen\/([\w-]+)\/genereer$/)) && m === "POST") return generate(env, r[1], ctx);
  if (m === "GET" && ap === "/instellingen") return json(await showSettings(req, env));
  if (m === "PUT" && ap === "/instellingen") return json(await saveSettings(req, env));
  if (m === "POST" && ap === "/instellingen/test") return json(await testSettings(env));
  if (m === "POST" && ap === "/hoofdstukken") return json(await publish(req, env));
  if ((r = ap.match(/^\/hoofdstukken\/([\w-]+)$/)) && m === "DELETE") return json(await removeChapter(env, r[1]));
  if (m === "GET" && ap === "/gebruikers") return json(await users.listUsers(env));
  if ((r = ap.match(/^\/gebruikers\/([\w-]+)$/)) && m === "PUT") return json(await users.setRole(env, r[1], await req.json().catch(() => null)));
  if ((r = ap.match(/^\/gebruikers\/([\w-]+)$/)) && m === "DELETE") return json(await users.deleteUser(env, r[1]));
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
