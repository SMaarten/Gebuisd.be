// Account van leerlingen en leerkrachten: inloggen, historiek, klassen en privacy.
import { lsGet, lsSet, lsDel, esc, fmt } from "./util.js";
import { api, apiUrl, user, setUser, logoutUser, serverStatus } from "./api.js";
import { loadCatalog } from "./app.js";

const NAMEN = { google: "Google", microsoft: "Microsoft", smartschool: "Smartschool" };
const LS_NA_LOGIN = "gebuisd.naLogin";
const datum = ts => new Date(ts).toLocaleDateString("nl-BE", { day: "numeric", month: "short", year: "numeric" });
const tijdstip = ts => { const d = new Date(ts); return d.toLocaleDateString("nl-BE", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }); };

/* ---------- Gegevens voor de toets ---------- */

export const loggedIn = () => !!user();

export async function serverHistory(hoofdstuk) {
  return api("/historiek" + (hoofdstuk ? "?hoofdstuk=" + encodeURIComponent(hoofdstuk) : ""), { auth: true });
}
export const saveResult = r => api("/historiek", { method: "POST", auth: true, body: r });
export const getSeen = h => api(`/gezien/${encodeURIComponent(h)}`, { auth: true }).then(r => r.ids);
export const putSeen = (h, ids) => api(`/gezien/${encodeURIComponent(h)}`, { method: "PUT", auth: true, body: { ids } });

/* ---------- Accountbalk bovenaan ---------- */

export async function renderAccountBar() {
  const el = document.getElementById("account");
  const u = user();
  if (u) {
    el.innerHTML = `<a href="#/mijn" class="acc">${esc(u.naam || "Mijn account")}</a>${u.rol === "leerkracht" ? ` <a href="#/klassen" class="acc">Mijn klassen</a>` : ""}`;
    return;
  }
  const s = await serverStatus();
  el.innerHTML = s.logins?.length ? `<a href="#/login" class="acc">Inloggen</a>` : "";
}

/* ---------- Inloggen ---------- */

export async function renderLogin(root, params) {
  if (user()) { location.hash = "#/mijn"; return; }
  const s = await serverStatus();
  const fout = params.get("fout");
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Account</span>
      <h1><mark>Inloggen</mark></h1>
      <p class="sub">Inloggen is niet nodig om toetsen te maken. Met een account zie je je historiek op elk toestel, kan je lid worden van een klas en een hoofdstuk voorstellen.</p>
    </header>
    ${fout ? `<p class="panel msg err">${esc(fout)}</p>` : ""}
    <section class="panel form login">
      ${s.logins?.length ? s.logins.map(p => `<a class="btn provider" href="${esc(startUrl(p))}" data-p="${p}">Inloggen met ${NAMEN[p]}</a>`).join("") : `<p class="hint">Inloggen is nog niet beschikbaar.</p>`}
      <p class="hint">Door in te loggen ga je akkoord met de <a href="#/privacy">privacyverklaring</a>.</p>
    </section>`;
  root.querySelectorAll("[data-p]").forEach(a => a.addEventListener("click", () => {
    const na = lsGet(LS_NA_LOGIN, "");
    if (!na) lsSet(LS_NA_LOGIN, "#/mijn");
  }));
}

function startUrl(p) {
  return `${apiUrl()}/auth/${p}/start?terug=${encodeURIComponent(location.origin + location.pathname)}`;
}

// Elders op de site: "log eerst in" en daarna terugkomen.
export function loginFirst(back) {
  lsSet(LS_NA_LOGIN, back || location.hash || "#/");
  location.hash = "#/login";
}

export async function handleCallback(root, params) {
  const token = params.get("t"), exp = Number(params.get("exp"));
  history.replaceState(null, "", location.pathname + "#/");   // token niet in de adresbalk laten staan
  if (!token) { location.hash = "#/login"; return; }
  root.innerHTML = `<p class="panel msg"><span class="spin"></span>Inloggen…</p>`;
  setUser({ token, verloopt: exp || Date.now() + 86400000 });
  try {
    const me = await api("/ik", { auth: true });
    setUser({ token, verloopt: exp, naam: me.naam, rol: me.rol });
    await importLocalHistory();
  } catch (e) {
    logoutUser();
    location.hash = "#/login?fout=" + encodeURIComponent(e.message);
    return;
  }
  const na = lsGet(LS_NA_LOGIN, "") || "#/mijn";
  lsDel(LS_NA_LOGIN);
  location.hash = na;
}

// Scores die al in deze browser stonden, mee naar het account (dubbels worden genegeerd).
async function importLocalHistory() {
  const items = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = /^gebuisd\.([a-z0-9-]+)\.hist$/.exec(k || "");
      if (!m) continue;
      for (const h of lsGet(k, [])) items.push({ hoofdstuk: m[1], datum: h.d, score: h.s, n: h.n || 20, tijd: h.t || 0, onderdelen: h.o || [] });
    }
  } catch {}
  if (items.length) await api("/historiek/import", { method: "POST", auth: true, body: { items } }).catch(() => {});
}

/* ---------- Mijn resultaten ---------- */

export async function renderMine(root) {
  if (!user()) return loginFirst("#/mijn");
  root.innerHTML = `<p class="sub"><span class="spin"></span>Laden…</p>`;
  let me, hist, cat;
  try { [me, hist, cat] = await Promise.all([api("/ik", { auth: true }), serverHistory(), loadCatalog().catch(() => [])]); }
  catch (e) { if (e.status === 401) return loginFirst("#/mijn"); root.innerHTML = `<p class="panel msg err">${esc(e.message)}</p>`; return; }
  setUser({ ...user(), naam: me.naam, rol: me.rol });
  renderAccountBar();
  const titel = id => { const h = cat.find(c => c.id === id); return h ? `${h.vak} · ${h.nr ? "H" + h.nr + " " : ""}${h.titel}` : id; };
  const per = new Map();
  for (const r of hist) { if (!per.has(r.hoofdstuk)) per.set(r.hoofdstuk, []); per.get(r.hoofdstuk).push(r); }

  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Mijn account · ${esc(NAMEN[me.provider] || me.provider)}${me.rol === "leerkracht" ? " · leerkracht" : ""}</span>
      <h1>${esc(me.naam || "Mijn resultaten")}</h1>
      <p class="sub">${hist.length ? `${hist.length} toets${hist.length > 1 ? "en" : ""} gemaakt in ${per.size} hoofdstuk${per.size > 1 ? "ken" : ""}.` : "Nog geen toetsen gemaakt met dit account."}</p>
    </header>
    ${[...per].map(([id, list]) => {
      const avg = Math.round(list.reduce((a, r) => a + r.score / r.n, 0) / list.length * 100);
      return `<section class="panel hist">
        <h3><a href="#/toets/${encodeURIComponent(id)}">${esc(titel(id))}</a> <span class="muted" style="font-weight:400;font-size:14px">· gemiddeld ${avg}% over ${list.length} toets${list.length > 1 ? "en" : ""}</span></h3>
        <ol>${list.slice(0, 20).map(r => `<li><span class="muted">${tijdstip(r.datum)}</span><span class="hb"><i style="width:${r.score / r.n * 100}%"></i></span><b>${r.score}/${r.n}</b><span class="t muted">${fmt(r.tijd)}</span></li>`).join("")}</ol>
      </section>`;
    }).join("")}
    <section class="panel form">
      <h2>Mijn klassen</h2>
      ${me.klassen.length ? `<ul class="admlist">${me.klassen.map(k => `<li><span><b>${esc(k.naam)}</b> <span class="muted">· ${esc(k.leerkracht)}</span></span><button class="btn small" type="button" data-leave="${esc(k.id)}">Klas verlaten</button></li>`).join("")}</ul>` : `<p class="hint">Je zit nog in geen enkele klas.</p>`}
      <form class="row" id="joinForm">
        <input id="code" placeholder="Klascode, bv. K7M2QX" maxlength="12" autocomplete="off" style="text-transform:uppercase;flex:1 1 160px">
        <button class="btn primary" type="submit">Lid worden</button>
      </form>
      <p class="hint">Je leerkracht ziet de scores van toetsen die je maakt nadat je lid werd.</p>
      <p class="status" id="kStatus" role="status"></p>
    </section>
    <section class="panel form">
      <h2>Account</h2>
      <div class="row">
        <button class="btn" type="button" id="logoutBtn">Uitloggen</button>
        <button class="btn danger" type="button" id="delBtn">Mijn account en gegevens verwijderen</button>
      </div>
      <p class="hint"><a href="#/privacy">Privacyverklaring</a></p>
      <p class="status" id="aStatus" role="status"></p>
    </section>`;

  root.querySelector("#joinForm").onsubmit = async e => {
    e.preventDefault();
    const code = root.querySelector("#code").value.trim();
    if (!code) return;
    try { const r = await api("/klassen/lid", { method: "POST", auth: true, body: { code } }); await renderMine(root); status(root, "kStatus", `Je bent lid van ${esc(r.klas)}.`, "ok"); }
    catch (err) { status(root, "kStatus", esc(err.message), "err"); }
  };
  root.onclick = async e => {
    const id = e.target.dataset.leave;
    if (id && confirm("Deze klas verlaten? Je leerkracht ziet je scores dan niet meer.")) {
      try { await api(`/klassen/${id}/lid`, { method: "DELETE", auth: true }); await renderMine(root); } catch (err) { status(root, "kStatus", esc(err.message), "err"); }
    }
    if (e.target.id === "logoutBtn") { logoutUser(); renderAccountBar(); location.hash = "#/"; }
    if (e.target.id === "delBtn" && confirm("Je account, al je resultaten en je klaslidmaatschappen definitief verwijderen? Dit kan niet ongedaan gemaakt worden.")) {
      try { await api("/ik", { method: "DELETE", auth: true }); logoutUser(); renderAccountBar(); location.hash = "#/"; }
      catch (err) { status(root, "aStatus", esc(err.message), "err"); }
    }
  };
}

function status(root, id, text, kind) { const el = root.querySelector("#" + id); if (el) { el.innerHTML = text; el.className = "status" + (kind ? " " + kind : ""); } }

/* ---------- Klassen (leerkracht) ---------- */

export async function renderClasses(root, id) {
  const u = user();
  if (!u) return loginFirst(location.hash);
  if (u.rol !== "leerkracht") {
    root.innerHTML = `<header class="top"><span class="eyebrow">Klassen</span><h1>Enkel voor leerkrachten</h1></header>
      <p class="panel msg">Ben je leerkracht? Vraag de beheerder van Gebuisd.be om je account de rol leerkracht te geven.</p>`;
    return;
  }
  if (id) return renderClass(root, id);
  root.innerHTML = `<p class="sub"><span class="spin"></span>Laden…</p>`;
  let list;
  try { list = await api("/klassen", { auth: true }); }
  catch (e) { root.innerHTML = `<p class="panel msg err">${esc(e.message)}</p>`; return; }
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Leerkracht</span>
      <h1>Mijn <mark>klassen</mark></h1>
      <p class="sub">Maak een klas en geef de klascode aan je leerlingen. Zodra ze ingelogd lid worden, zie je hun scores.</p>
    </header>
    <section class="panel form">
      ${list.length ? `<ul class="admlist">${list.map(k => `<li><span><a href="#/klassen/${esc(k.id)}"><b>${esc(k.naam)}</b></a> <span class="muted">· code <code>${esc(k.code)}</code> · ${k.leden} leerling${k.leden === 1 ? "" : "en"}</span></span>
        <span class="row"><a class="btn small" href="#/klassen/${esc(k.id)}">Resultaten</a><button class="btn small danger" type="button" data-delk="${esc(k.id)}">Verwijderen</button></span></li>`).join("")}</ul>` : `<p class="hint">Nog geen klassen.</p>`}
      <form class="row" id="newClass">
        <input id="kNaam" placeholder="Naam van de klas, bv. 1A wiskunde" maxlength="60" style="flex:1 1 200px">
        <button class="btn primary" type="submit">Klas maken</button>
      </form>
      <p class="status" id="cStatus" role="status"></p>
    </section>`;
  root.querySelector("#newClass").onsubmit = async e => {
    e.preventDefault();
    const naam = root.querySelector("#kNaam").value.trim();
    if (!naam) return;
    try { const k = await api("/klassen", { method: "POST", auth: true, body: { naam } }); await renderClasses(root); status(root, "cStatus", `Klas gemaakt. Klascode: <code>${esc(k.code)}</code>`, "ok"); }
    catch (err) { status(root, "cStatus", esc(err.message), "err"); }
  };
  root.onclick = async e => {
    const k = e.target.dataset.delk;
    if (k && confirm("Deze klas verwijderen? De leerlingen blijven hun eigen resultaten zien.")) {
      try { await api(`/klassen/${k}`, { method: "DELETE", auth: true }); await renderClasses(root); } catch (err) { status(root, "cStatus", esc(err.message), "err"); }
    }
  };
}

async function renderClass(root, id) {
  root.innerHTML = `<p class="sub"><span class="spin"></span>Laden…</p>`;
  let d, cat;
  try { [d, cat] = await Promise.all([api(`/klassen/${encodeURIComponent(id)}`, { auth: true }), loadCatalog().catch(() => [])]); }
  catch (e) { root.innerHTML = `<p class="panel msg err">${esc(e.message)}</p>`; return; }
  const chapters = [...new Set(d.resultaten.map(r => r.hoofdstuk))];
  const info = hid => cat.find(c => c.id === hid);
  chapters.sort((a, b) => (info(a)?.vak || a).localeCompare(info(b)?.vak || b, "nl") || (parseFloat(info(a)?.nr) || 0) - (parseFloat(info(b)?.nr) || 0));
  const cell = (uid, hid) => {
    const r = d.resultaten.find(x => x.gebruiker === uid && x.hoofdstuk === hid);
    return r ? `<td><b>${esc(r.laatste)}</b><br><span class="muted">beste ${Math.round(r.beste * 100)}% · ${r.aantal}×</span></td>` : `<td class="muted">–</td>`;
  };
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow"><a href="#/klassen">Mijn klassen</a></span>
      <h1>${esc(d.klas.naam)}</h1>
      <p class="sub">Klascode <code>${esc(d.klas.code)}</code> · ${d.leden.length} leerling${d.leden.length === 1 ? "" : "en"}. Per hoofdstuk: laatste score, beste score en aantal toetsen sinds de leerling lid werd.</p>
    </header>
    <section class="panel">
      ${d.leden.length ? `<div class="tablewrap"><table class="overview">
        <thead><tr><th>Leerling</th>${chapters.map(h => `<th>${esc(info(h) ? `${info(h).vak} H${info(h).nr}` : h)}<br><span class="muted">${esc(info(h)?.titel || "")}</span></th>`).join("")}<th></th></tr></thead>
        <tbody>${d.leden.map(l => `<tr><th>${esc(l.naam || l.email || "leerling")}<br><span class="muted">lid sinds ${datum(l.sinds)}</span></th>${chapters.map(h => cell(l.id, h)).join("")}<td><button class="btn small danger" type="button" data-rm="${esc(l.id)}">Uit klas</button></td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="hint">Nog geen leerlingen. Geef hen de klascode <code>${esc(d.klas.code)}</code>; ze vullen die in bij "Mijn account".</p>`}
      ${d.leden.length && !chapters.length ? `<p class="hint">Nog geen toetsen gemaakt sinds de leerlingen lid werden.</p>` : ""}
      <p class="status" id="oStatus" role="status"></p>
    </section>`;
  root.onclick = async e => {
    const uid = e.target.dataset.rm;
    if (uid && confirm("Deze leerling uit de klas halen?")) {
      try { await api(`/klassen/${encodeURIComponent(id)}/leden/${uid}`, { method: "DELETE", auth: true }); await renderClass(root, id); }
      catch (err) { status(root, "oStatus", esc(err.message), "err"); }
    }
  };
}

/* ---------- Privacy ---------- */

export function renderPrivacy(root) {
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Gebuisd.be</span>
      <h1>Privacyverklaring</h1>
    </header>
    <section class="panel prose">
      <h3>Zonder account</h3>
      <p>Je kan alle toetsen maken zonder in te loggen. Je scores en de vragen die je al kreeg, worden dan enkel in je eigen browser bewaard. Wij ontvangen niets.</p>
      <h3>Met een account</h3>
      <p>Log je in met Google, Microsoft of Smartschool, dan bewaren we:</p>
      <ul>
        <li>je naam, en je e-mailadres als de login dat doorgeeft (Smartschool geeft geen e-mailadres door);</li>
        <li>een vaste code van je account bij die dienst, zodat we je herkennen;</li>
        <li>de resultaten van je toetsen: hoofdstuk, datum, score en duur, en welke vragen je al kreeg;</li>
        <li>de klassen waarvan je lid bent.</li>
      </ul>
      <p>We krijgen nooit je wachtwoord. We gebruiken deze gegevens enkel om je historiek te tonen en, als je lid wordt van een klas, om je scores aan de leerkracht van die klas te tonen. We delen ze met niemand anders en gebruiken ze niet voor reclame.</p>
      <h3>Een hoofdstuk voorstellen</h3>
      <p>Stuur je cursusmateriaal in, dan bewaren we de bestanden, je opmerking en je naam tot de beheerder het voorstel verwijdert. De bestanden worden door een externe dienst verwerkt om de vragen te maken. Stuur alleen leerstof in, geen persoonlijke gegevens.</p>
      <h3>Waar staan de gegevens?</h3>
      <p>Accounts, resultaten en voorstellen staan op servers van Cloudflare. De website zelf staat op GitHub Pages.</p>
      <h3>Je rechten</h3>
      <p>Je kan op elk moment je account en al je gegevens zelf verwijderen via <a href="#/mijn">Mijn account</a>. Je kan ook een klas verlaten, waarna je leerkracht je scores niet meer ziet. Voor andere vragen over je gegevens kan je terecht bij de beheerder van Gebuisd.be. (info@cloudvision.be)</p>
      <p class="muted">Ben je jonger dan 13 jaar, vraag dan eerst toestemming aan je ouders voor je een account aanmaakt.</p>
    </section>`;
}
