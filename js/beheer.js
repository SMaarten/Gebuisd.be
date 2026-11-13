// Beheer (enkel admin, met wachtwoord):
//  - voorstellen van bezoekers bekijken en er met Claude een vragenbank van laten maken
//  - vragen nakijken en het hoofdstuk online zetten (de server commit naar GitHub)
//  - bestaande hoofdstukken bewerken of verwijderen
//  - instellingen: Claude-sleutel, GitHub-token, repo en branch (staan enkel op de server)
import { lsGet, lsSet, lsDel, esc, chapterId, validateChapter, serializeChapter } from "./util.js";
import { loadCatalog, clearCatalogCache, LS_LOCAL } from "./app.js";
import { api, apiUrl, session, setSession, logout, ApiFout } from "./api.js";

const LS_DRAFT = "gebuisd.draft";

let root, draft = null, generating = null;

const $ = id => root.querySelector("#" + id);
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " kB";
const datum = ts => new Date(ts).toLocaleDateString("nl-BE", { day: "numeric", month: "short", year: "numeric" });

function status(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = text;
  el.className = "status" + (kind ? " " + kind : "");
}

// Bij een verlopen sessie terug naar het loginscherm.
function handle(e, statusId) {
  if (e instanceof ApiFout && e.status === 401) { renderAdmin(root); return; }
  status(statusId, esc(e.message || String(e)), "err");
}

/* ---------- Login ---------- */

export async function renderAdmin(el) {
  root = el;
  if (!apiUrl()) {
    root.innerHTML = `<header class="top"><span class="eyebrow">Beheer</span><h1>Server nog niet ingesteld</h1></header>
      <p class="panel msg">Vul in <code>js/config.js</code> het adres van de Gebuisd.be API in. Zie <code>worker/README.md</code>.</p>`;
    return;
  }
  if (!session()) return renderLogin();
  draft = lsGet(LS_DRAFT, null);
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Beheer</span>
      <h1>Voorstellen en <mark>hoofdstukken</mark></h1>
      <div class="row"><p class="sub" style="flex:1">Ingelogd als beheerder.</p><button class="btn small" type="button" id="logoutBtn">Uitloggen</button></div>
    </header>
    <section class="panel form" id="proposals"><h2>Voorstellen</h2><p class="sub"><span class="spin"></span>Laden…</p></section>
    <section class="panel form" id="review" hidden></section>
    <section class="panel form" id="existing"><h2>Hoofdstukken</h2><p class="sub"><span class="spin"></span>Laden…</p></section>
    <section class="panel form" id="users"><h2>Gebruikers</h2><p class="sub"><span class="spin"></span>Laden…</p></section>
    <details class="panel settings" id="settings"><summary>Instellingen</summary><div class="form" id="settingsBody"><p class="sub"><span class="spin"></span>Laden…</p></div></details>`;
  $("logoutBtn").onclick = () => { logout(); renderAdmin(root); };
  $("settings").ontoggle = () => { if ($("settings").open) renderSettings(); };
  renderReview();
  await Promise.all([renderProposals(), renderExisting(), renderUsers()]);
}

function renderLogin() {
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Beheer</span>
      <h1>Inloggen</h1>
      <p class="sub">Enkel voor de beheerder. Bezoekers hebben geen login nodig om toetsen te maken of een hoofdstuk voor te stellen.</p>
    </header>
    <form class="panel form login" id="loginForm">
      <label class="field"><span>Wachtwoord</span><input type="password" id="pw" autocomplete="current-password" required></label>
      <div class="row"><button class="btn primary" type="submit">Inloggen</button></div>
      <p class="status" id="lStatus" role="status"></p>
    </form>`;
  $("pw").focus();
  $("loginForm").onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter || root.querySelector("button[type=submit]");
    btn.disabled = true;
    status("lStatus", `<span class="spin"></span>Controleren…`);
    try {
      setSession(await api("/login", { method: "POST", body: { wachtwoord: $("pw").value } }));
      renderAdmin(root);
    } catch (err) {
      status("lStatus", esc(err.message), "err");
      btn.disabled = false;
      $("pw").select();
    }
  };
}

/* ---------- Voorstellen ---------- */

async function renderProposals() {
  const box = $("proposals");
  let list;
  try { list = await api("/admin/voorstellen", { admin: true }); }
  catch (e) { if (e.status === 401) return renderAdmin(root); box.innerHTML = `<h2>Voorstellen</h2><p class="status err">${esc(e.message)}</p>`; return; }
  const open = list.filter(v => !v.online).length;
  box.innerHTML = `<h2>Voorstellen <span class="muted" style="font-weight:400;font-size:15px">· ${open} te behandelen</span></h2>
    ${list.length ? "" : `<p class="hint">Nog geen voorstellen. Bezoekers sturen ze in via "+ Hoofdstuk toevoegen" op de startpagina.</p>`}
    ${list.map(v => `
      <div class="vs" data-id="${esc(v.id)}">
        <div class="top">
          <p><b>${esc(v.vak)}</b> · ${esc([v.graad, "hoofdstuk " + v.nr].filter(Boolean).join(" · "))}${v.titel ? " · " + esc(v.titel) : ""}
            ${v.online ? `<span class="tag">online gezet</span>` : ""}</p>
          <span class="row">
            <button class="btn small primary" type="button" data-gen="${esc(v.id)}">${v.online ? "Opnieuw vragen maken" : "Vragen laten maken"}</button>
            <button class="btn small danger" type="button" data-delv="${esc(v.id)}">Verwijderen</button>
          </span>
        </div>
        <p class="muted">Ingediend ${datum(v.ingediend)}${v.naam ? " door " + esc(v.naam) : ""}${v.email ? ` (${esc(v.email)})` : ""}${v.online ? ` · online sinds ${datum(v.online)}` : ""}</p>
        <p class="muted">${v.bestanden.map(f => `${esc(f.naam)} (${kb(f.grootte)})`).join(" · ")}</p>
        ${v.opmerking ? `<p>“${esc(v.opmerking)}”</p>` : ""}
        <p class="status" id="g-${esc(v.id)}" role="status" aria-live="polite"></p>
      </div>`).join("")}`;
  box.onclick = e => {
    const g = e.target.dataset.gen, d = e.target.dataset.delv;
    if (g) generate(list.find(v => v.id === g), e.target);
    if (d) deleteProposal(d, e.target);
  };
}

async function deleteProposal(id, btn) {
  if (!confirm("Dit voorstel en de ingestuurde cursus verwijderen? Een hoofdstuk dat al online staat, blijft online.")) return;
  btn.disabled = true;
  try { await api(`/admin/voorstellen/${id}`, { method: "DELETE", admin: true }); await renderProposals(); }
  catch (e) { btn.disabled = false; handle(e, "g-" + id); }
}

async function generate(v, btn) {
  if (generating) return status("g-" + v.id, "Er wordt al een vragenbank gemaakt. Wacht tot die klaar is.", "err");
  if (draft && !confirm("Er staat nog een niet-opgeslagen vragenbank klaar om na te kijken. Die wordt vervangen. Doorgaan?")) return;
  generating = v.id;
  root.querySelectorAll("[data-gen]").forEach(b => { b.disabled = true; });
  const sid = "g-" + v.id;
  const t0 = Date.now();
  let n = 0;
  const show = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    status(sid, `<span class="spin"></span>${n ? `Claude schrijft vragen… ${n} klaar` : "Claude leest de cursus en plant de vragen…"} <span class="muted">(${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})</span>\n<small class="muted">Dit duurt enkele minuten. Laat dit tabblad open.</small>`);
  };
  show();
  const timer = setInterval(show, 1000);
  try {
    const res = await api(`/admin/voorstellen/${v.id}/genereer`, { method: "POST", admin: true, raw: true });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "bezig") n = ev.vragen;
        if (ev.type === "fout") throw new Error(ev.melding);
        if (ev.type === "klaar") done = ev;
      }
      if (end) break;
    }
    if (!done) throw new Error("De verbinding met de server werd onderbroken. Probeer opnieuw.");
    if (done.stop_reason === "refusal") throw new Error("Claude weigerde dit materiaal te verwerken. Controleer of de bestanden enkel leerstof bevatten.");
    if (done.stop_reason === "max_tokens") throw new Error("Het antwoord werd te lang en is afgebroken. Splits het hoofdstuk in twee voorstellen.");
    let out;
    try { out = JSON.parse(done.tekst); } catch { throw new Error("Het antwoord van Claude was geen geldige vragenbank. Probeer opnieuw."); }
    draft = toChapter(out, v);
    const errs = validateChapter(draft);
    if (errs.length) throw new Error("De vragenbank heeft fouten:\n" + errs.join("\n"));
    lsSet(LS_DRAFT, draft);
    const u = done.usage || {};
    const cost = ((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6;
    status(sid, `Klaar: ${draft.vragen.length} vragen in ${draft.onderdelen.length} onderdelen. <span class="muted">Kostprijs ongeveer $${cost.toFixed(2)}.</span> Kijk ze hieronder na.`, "ok");
    renderReview();
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    handle(e, sid);
  } finally {
    clearInterval(timer);
    generating = null;
    root.querySelectorAll("[data-gen]").forEach(b => { b.disabled = false; });
  }
}

function toChapter(out, v) {
  const onderdelen = [], vragen = [];
  for (const o of out.onderdelen || []) {
    const qs = (o.vragen || []).filter(q => q.vraag && q.juist && Array.isArray(q.fout) && q.fout.length);
    if (!qs.length) continue;
    const idx = onderdelen.length;
    onderdelen.push({ nr: String(o.nr || "").trim(), titel: String(o.titel || "").trim() });
    for (const q of qs) {
      const a = [q.juist, ...q.fout.slice(0, 5)].map(x => String(x).trim());
      if (new Set(a).size !== a.length) continue; // dubbele antwoorden: vraag overslaan
      vragen.push({ o: idx, v: q.vraag.trim(), a, u: (q.uitleg || "").trim() });
    }
  }
  return {
    id: chapterId(v.vak, v.graad, v.nr),
    vak: v.vak, graad: v.graad, nr: v.nr,
    titel: v.titel || String(out.titel || "").trim() || `Hoofdstuk ${v.nr}`,
    beschrijving: String(out.beschrijving || "").trim(),
    onderdelen, vragen,
    voorstel: v.id
  };
}

/* ---------- Nakijken ---------- */

function renderReview() {
  const box = $("review");
  if (!draft) { box.hidden = true; box.innerHTML = ""; return; }
  const per = draft.onderdelen.map((_, s) => draft.vragen.filter(q => q.o === s).length);
  const tests = Math.floor(draft.vragen.length / 20);
  box.innerHTML = `
    <h2>Nakijken</h2>
    <p class="hint">Lees de vragen na en schrap wat fout of onduidelijk is. Het groene antwoord is het juiste. Wijzigingen worden meteen bewaard in deze browser.
      ${draft.vragen.length} vragen: genoeg voor ${tests || "minder dan"} ${tests === 1 ? "toets" : "toetsen"} van 20 zonder herhaling.</p>
    <div class="fields">
      <label class="field"><span>Vak</span><input data-m="vak" value="${esc(draft.vak)}"></label>
      <label class="field"><span>Jaar</span><input data-m="graad" value="${esc(draft.graad)}"></label>
      <label class="field"><span>Hoofdstuk</span><input data-m="nr" value="${esc(draft.nr)}"></label>
    </div>
    <label class="field"><span>Titel</span><input data-m="titel" value="${esc(draft.titel)}"></label>
    <label class="field"><span>Korte info voor de leerling</span><input data-m="beschrijving" value="${esc(draft.beschrijving || "")}"></label>
    <p class="hint">Bestandsnaam: <code>data/${esc(draft.id)}.json</code></p>
    ${draft.onderdelen.map((o, s) => `
      <details ${s === 0 ? "open" : ""}>
        <summary><b>${esc(o.nr)} ${esc(o.titel)}</b> <span class="muted">· ${per[s]} vragen</span></summary>
        <div class="preview" style="margin-top:10px">
          ${draft.vragen.map((q, i) => q.o !== s ? "" : `
            <div class="pq"><div class="top"><p>${esc(q.v)}</p><button class="btn small danger" type="button" data-rmq="${i}">Schrappen</button></div>
              <ul>${q.a.map((a, k) => `<li class="${k === 0 ? "ok" : ""}">${esc(a)}</li>`).join("")}</ul>
              ${q.u ? `<p class="u">${esc(q.u)}</p>` : ""}
            </div>`).join("")}
        </div>
      </details>`).join("")}
    <div class="row">
      <button class="btn primary" type="button" id="pubBtn">Online zetten</button>
      <button class="btn" type="button" id="tryBtn">Eerst zelf uitproberen</button>
      <button class="btn" type="button" id="dlBtn">JSON downloaden</button>
      <button class="btn danger" type="button" id="discardBtn">Weggooien</button>
    </div>
    <p class="hint">Online zetten bewaart het hoofdstuk in de repo. GitHub Pages heeft daarna ongeveer een minuut nodig; op dit toestel staat het er meteen.</p>
    <p class="status" id="pStatus" role="status"></p>`;
  box.hidden = false;

  box.oninput = e => {
    const k = e.target.dataset.m;
    if (!k) return;
    draft[k] = e.target.value.trim();
    if (["vak", "graad", "nr"].includes(k)) draft.id = chapterId(draft.vak, draft.graad, draft.nr);
    lsSet(LS_DRAFT, draft);
    const code = box.querySelector("code");
    if (code) code.textContent = `data/${draft.id}.json`;
  };
  box.onclick = e => {
    const t = e.target;
    if (t.dataset.rmq !== undefined) {
      draft.vragen.splice(Number(t.dataset.rmq), 1);
      lsSet(LS_DRAFT, draft);
      const open = [...box.querySelectorAll("details")].map(d => d.open);
      renderReview();
      box.querySelectorAll("details").forEach((d, i) => { d.open = open[i]; });
    }
    if (t.id === "dlBtn") download();
    if (t.id === "tryBtn") tryLocal();
    if (t.id === "pubBtn") publish(t);
    if (t.id === "discardBtn" && confirm("Deze vragenbank weggooien?")) { draft = null; lsDel(LS_DRAFT); renderReview(); }
  };
}

function checkDraft() {
  const errs = validateChapter(draft);
  if (errs.length) { status("pStatus", errs.map(esc).join("\n"), "err"); return false; }
  return true;
}

function chapterOnly(d) { const { voorstel, ...c } = d; return c; }

function download() {
  if (!checkDraft()) return;
  const blob = new Blob([serializeChapter(chapterOnly(draft))], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = draft.id + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function tryLocal() {
  if (!checkDraft()) return;
  const local = lsGet(LS_LOCAL, {});
  local[draft.id] = { chapter: chapterOnly(draft), published: false };
  lsSet(LS_LOCAL, local);
  clearCatalogCache();
  location.hash = "#/toets/" + encodeURIComponent(draft.id);
}

async function publish(btn, overschrijven = false) {
  if (!checkDraft()) return;
  btn.disabled = true;
  status("pStatus", `<span class="spin"></span>Online zetten…`);
  try {
    await api("/admin/hoofdstukken", { method: "POST", admin: true, body: { hoofdstuk: chapterOnly(draft), voorstel: draft.voorstel || null, overschrijven } });
    const local = lsGet(LS_LOCAL, {});
    local[draft.id] = { chapter: chapterOnly(draft), published: true };
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    const id = draft.id;
    draft = null;
    lsDel(LS_DRAFT);
    await renderAdmin(root);
    status("eStatus", `Online gezet. Over ongeveer een minuut staat het voor iedereen op de site. <a href="#/toets/${encodeURIComponent(id)}">Toets openen</a>`, "ok");
    $("existing").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409 && !overschrijven) {
      if (confirm(`Er bestaat al een hoofdstuk data/${draft.id}.json. Overschrijven?`)) return publish(btn, true);
      return status("pStatus", "Niet online gezet. Pas het vak, jaar of hoofdstuknummer aan voor een nieuw hoofdstuk.");
    }
    handle(e, "pStatus");
  }
}

/* ---------- Bestaande hoofdstukken ---------- */

async function renderExisting() {
  const box = $("existing");
  const cat = await loadCatalog(true).catch(() => []);
  box.innerHTML = `<h2>Hoofdstukken</h2>
    ${cat.length ? `<ul class="admlist">${cat.map(h => `<li><span><b>${esc(h.vak)}</b> · ${esc([h.graad, h.nr ? "H" + h.nr : ""].filter(Boolean).join(" "))} ${esc(h.titel)} <span class="muted">(${h.vragen} vragen${h.lokaal ? ", " + esc(h.lokaal) : ""})</span></span>
      <span class="row"><a class="btn small" href="#/toets/${encodeURIComponent(h.id)}">Openen</a><button class="btn small" type="button" data-edit="${esc(h.id)}">Bewerken</button><button class="btn small danger" type="button" data-del="${esc(h.id)}">Verwijderen</button></span></li>`).join("")}</ul>` : `<p class="hint">Nog geen hoofdstukken.</p>`}
    <p class="hint">Een kant-en-klare vragenbank? <button type="button" class="linkbtn" id="jsonBtn">Laad een JSON-bestand</button></p>
    <input type="file" id="fJson" accept="application/json,.json" hidden>
    <p class="status" id="eStatus" role="status"></p>`;
  box.onclick = e => {
    if (e.target.dataset.del) removeChapter(e.target.dataset.del, e.target);
    if (e.target.dataset.edit) editChapter(e.target.dataset.edit);
    if (e.target.id === "jsonBtn") $("fJson").click();
  };
  $("fJson").onchange = importJson;
}

function replaceDraft(c, msg) {
  if (draft && !confirm("Er staat nog een niet-opgeslagen vragenbank klaar. Die wordt vervangen. Doorgaan?")) return;
  draft = c;
  lsSet(LS_DRAFT, draft);
  renderReview();
  if (msg) status("pStatus", msg, "ok");
  $("review").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function importJson() {
  const f = $("fJson").files[0];
  $("fJson").value = "";
  if (!f) return;
  try {
    const c = JSON.parse(await f.text());
    const errs = validateChapter(c);
    if (errs.length) throw new Error(errs.join("\n"));
    replaceDraft(c, `${esc(f.name)} geladen: ${c.vragen.length} vragen.`);
  } catch (e) {
    status("eStatus", "Dit bestand is geen geldige vragenbank:\n" + esc(e.message), "err");
  }
}

async function editChapter(id) {
  try {
    const local = lsGet(LS_LOCAL, {});
    let c = local[id]?.chapter;
    if (!c) {
      const cat = await loadCatalog();
      const r = await fetch(cat.find(h => h.id === id).bestand, { cache: "no-cache" });
      c = await r.json();
    }
    replaceDraft(c);
  } catch (e) { status("eStatus", "Kon dit hoofdstuk niet openen.", "err"); }
}

async function removeChapter(id, btn) {
  const local = lsGet(LS_LOCAL, {});
  if (local[id] && !local[id].published) {
    delete local[id];
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    return renderExisting();
  }
  if (!confirm(`Hoofdstuk "${id}" voor iedereen van de site verwijderen? De vragen blijven in de git-geschiedenis.`)) return;
  btn.disabled = true;
  status("eStatus", `<span class="spin"></span>Verwijderen…`);
  try {
    await api(`/admin/hoofdstukken/${encodeURIComponent(id)}`, { method: "DELETE", admin: true });
    delete local[id];
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    await renderExisting();
    status("eStatus", "Verwijderd. Over ongeveer een minuut is het ook online weg.", "ok");
  } catch (e) { btn.disabled = false; handle(e, "eStatus"); }
}

/* ---------- Gebruikers ---------- */

const NAMEN = { google: "Google", microsoft: "Microsoft", smartschool: "Smartschool" };

async function renderUsers() {
  const box = $("users");
  let list;
  try { list = await api("/admin/gebruikers", { admin: true }); }
  catch (e) { if (e.status === 401) return renderAdmin(root); box.innerHTML = `<h2>Gebruikers</h2><p class="status err">${esc(e.message)}</p>`; return; }
  const lk = list.filter(u => u.rol === "leerkracht").length;
  box.innerHTML = `<h2>Gebruikers <span class="muted" style="font-weight:400;font-size:15px">· ${list.length} account${list.length === 1 ? "" : "s"}, ${lk} leerkracht${lk === 1 ? "" : "en"}</span></h2>
    <p class="hint">Iedereen die inlogt, is eerst leerling. Geef leerkrachten hier de rol leerkracht; dan kunnen ze klassen maken en de scores van hun klassen zien.</p>
    ${list.length > 8 ? `<input id="uZoek" placeholder="Zoeken op naam of e-mail" style="max-width:320px">` : ""}
    ${list.length ? `<ul class="admlist" id="uList">${list.map(u => `<li data-zoek="${esc((u.naam + " " + u.email).toLowerCase())}">
      <span><b>${esc(u.naam || "(geen naam)")}</b> <span class="muted">· ${esc(u.email || NAMEN[u.provider] || u.provider)}${u.email ? " · " + esc(NAMEN[u.provider] || u.provider) : ""} · ${u.toetsen} toets${u.toetsen === 1 ? "" : "en"} · laatst ${datum(u.laatst)}</span></span>
      <span class="row">
        <select data-rol="${esc(u.id)}" aria-label="Rol van ${esc(u.naam)}"><option value="leerling" ${u.rol === "leerling" ? "selected" : ""}>leerling</option><option value="leerkracht" ${u.rol === "leerkracht" ? "selected" : ""}>leerkracht</option></select>
        <button class="btn small danger" type="button" data-delu="${esc(u.id)}">Verwijderen</button>
      </span></li>`).join("")}</ul>` : `<p class="hint">Nog niemand ingelogd.</p>`}
    <p class="status" id="uStatus" role="status"></p>`;
  const zoek = $("uZoek");
  if (zoek) zoek.oninput = () => { const q = zoek.value.trim().toLowerCase(); box.querySelectorAll("#uList li").forEach(li => { li.hidden = q && !li.dataset.zoek.includes(q); }); };
  box.onchange = async e => {
    const id = e.target.dataset.rol;
    if (!id) return;
    try { await api(`/admin/gebruikers/${id}`, { method: "PUT", admin: true, body: { rol: e.target.value } }); status("uStatus", "Rol aangepast. De gebruiker ziet de wijziging na opnieuw laden.", "ok"); }
    catch (err) { handle(err, "uStatus"); }
  };
  box.onclick = async e => {
    const id = e.target.dataset.delu;
    if (!id || !confirm("Dit account met alle resultaten en klassen definitief verwijderen?")) return;
    try { await api(`/admin/gebruikers/${id}`, { method: "DELETE", admin: true }); await renderUsers(); status("uStatus", "Verwijderd.", "ok"); }
    catch (err) { handle(err, "uStatus"); }
  };
}

/* ---------- Instellingen ---------- */

async function renderSettings() {
  const body = $("settingsBody");
  let s;
  try { s = await api("/admin/instellingen", { admin: true }); }
  catch (e) { if (e.status === 401) return renderAdmin(root); body.innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
  body.innerHTML = `
    <p class="hint">De sleutels staan enkel op de server en worden hier nooit volledig getoond. Laat een veld leeg om de huidige waarde te houden.</p>
    <div class="fields">
      <label class="field"><span>Claude API-sleutel</span>
        <input type="password" id="sKey" autocomplete="off" spellcheck="false" placeholder="${esc(s.anthropicKey || "nog niet ingesteld")}">
        <small>Huidig: ${s.anthropicKey ? `<code>${esc(s.anthropicKey)}</code>` : "geen"}. Maak er een op <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a>.</small>
      </label>
      <label class="field"><span>GitHub-token</span>
        <input type="password" id="sGh" autocomplete="off" spellcheck="false" placeholder="${esc(s.githubToken || "nog niet ingesteld")}">
        <small>Huidig: ${s.githubToken ? `<code>${esc(s.githubToken)}</code>` : "geen"}. Fine-grained token, enkel deze repo, <i>Contents: Read and write</i>. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Token maken</a>.</small>
      </label>
      <label class="field"><span>Repository</span><input id="sRepo" spellcheck="false" value="${esc(s.repo)}"><small>eigenaar/naam</small></label>
      <label class="field"><span>Branch</span><input id="sBranch" spellcheck="false" value="${esc(s.branch)}"><small>de branch die GitHub Pages publiceert</small></label>
    </div>
    <div class="row">
      <button class="btn primary" type="button" id="sSave">Bewaren</button>
      <button class="btn" type="button" id="sTest">Verbinding testen</button>
    </div>
    <h3 style="margin-top:8px">Logins voor leerlingen en leerkrachten</h3>
    <p class="hint">Vul per dienst de gegevens in die je bij de registratie van de app krijgt. Gebruik daar als <i>redirect URI</i> exact het adres dat hieronder staat. Laat het geheim leeg om het huidige te houden. Een login zonder volledige gegevens wordt niet getoond.</p>
    ${["google", "microsoft", "smartschool"].map(p => {
      const x = s.login[p];
      const titel = { google: "Google", microsoft: "Microsoft", smartschool: "Smartschool" }[p];
      const help = {
        google: `<a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a> → OAuth-client-ID → type <i>Webtoepassing</i>.`,
        microsoft: `<a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra</a> → App-registraties → <i>Accounts in elke organisatiemap en persoonlijke Microsoft-accounts</i>, platform <i>Web</i>.`,
        smartschool: `Aanvragen via het <a href="https://www.smartschool.be/oauth/oauth-aanvraagformulier-voor-scholen/" target="_blank" rel="noopener">aanvraagformulier voor scholen</a>, met scope <i>userinfo</i>.`
      }[p];
      const actief = x.clientId && x.clientSecret && (p !== "smartschool" || x.platform);
      return `<fieldset class="login-cfg" data-login="${p}">
        <legend><b>${titel}</b> ${actief ? '<span class="tag">actief</span>' : '<span class="muted">· niet actief</span>'}</legend>
        <p class="hint">${help}<br>Redirect URI: <code>${esc(x.callback)}</code></p>
        <div class="fields">
          ${p === "smartschool" ? `<label class="field"><span>Smartschool-adres</span><input data-k="platform" spellcheck="false" placeholder="https://school.smartschool.be" value="${esc(x.platform)}"></label>` : ""}
          <label class="field"><span>Client ID</span><input data-k="clientId" spellcheck="false" value="${esc(x.clientId)}"></label>
          <label class="field"><span>Client secret</span><input data-k="clientSecret" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(x.clientSecret || "nog niet ingesteld")}"></label>
        </div>
        ${actief ? `<button type="button" class="linkbtn" data-wis="${p}">Deze login uitschakelen</button>` : ""}
      </fieldset>`;
    }).join("")}
    <div class="row"><button class="btn primary" type="button" id="sSave2">Logins bewaren</button></div>
    <p class="hint">Het admin-wachtwoord wijzig je op de server met <code>npx wrangler secret put ADMIN_PASSWORD</code> (in de map <code>worker</code>). Daarna moet je overal opnieuw inloggen.</p>
    <p class="status" id="sStatus" role="status"></p>`;
  const loginBody = () => {
    const login = {};
    body.querySelectorAll("[data-login]").forEach(f => {
      const o = {};
      f.querySelectorAll("[data-k]").forEach(i => { o[i.dataset.k] = i.value; });
      login[f.dataset.login] = o;
    });
    return login;
  };
  body.onclick = async e => {
    const p = e.target.dataset.wis;
    if (!p || !confirm("Deze login uitschakelen? Wie zo inlogde, kan dan niet meer inloggen tot je hem opnieuw instelt.")) return;
    try { await api("/admin/instellingen", { method: "PUT", admin: true, body: { login: { [p]: { wis: true } } } }); await renderSettings(); status("sStatus", "Login uitgeschakeld.", "ok"); }
    catch (err) { handle(err, "sStatus"); }
  };
  $("sSave2").onclick = () => $("sSave").click();
  $("sSave").onclick = async () => {
    status("sStatus", `<span class="spin"></span>Bewaren…`);
    try {
      await api("/admin/instellingen", { method: "PUT", admin: true, body: { anthropicKey: $("sKey").value, githubToken: $("sGh").value, repo: $("sRepo").value, branch: $("sBranch").value, login: loginBody() } });
      await renderSettings();
      status("sStatus", "Bewaard.", "ok");
    } catch (e) { handle(e, "sStatus"); }
  };
  $("sTest").onclick = async () => {
    status("sStatus", `<span class="spin"></span>Testen…`);
    try {
      const r = await api("/admin/instellingen/test", { method: "POST", admin: true });
      status("sStatus", `Claude: ${esc(r.claude.melding)}\nGitHub: ${esc(r.github.melding)}`, r.claude.ok && r.github.ok ? "ok" : "err");
    } catch (e) { handle(e, "sStatus"); }
  };
}
