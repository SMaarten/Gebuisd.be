import { lsGet, lsSet, lsDel, esc, shuffle, fmt, sortCatalog, catalogEntry } from "./util.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const LS_LIMIT = "gebuisd.limit";
// Hoofdstukken die op dit toestel klaarstaan: net online gezet (GitHub Pages bouwt nog) of enkel lokaal uitgeprobeerd.
export const LS_LOCAL = "gebuisd.local";

const $ = id => document.getElementById(id);

/* ---------- Gegevens laden ---------- */

let catalogCache = null;

export async function loadCatalog(force) {
  if (catalogCache && !force) return catalogCache;
  let remote = [];
  try {
    const r = await fetch("data/catalog.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    remote = (await r.json()).hoofdstukken || [];
  } catch (e) {
    if (location.protocol === "file:") throw new Error("Open de site via een webserver (bv. GitHub Pages of `python3 -m http.server`), niet als los bestand: de browser blokkeert dan het laden van de vragen.");
    throw new Error("De lijst met hoofdstukken kon niet geladen worden.");
  }
  // lokale kopieën opruimen zodra de online versie er is
  const local = lsGet(LS_LOCAL, {});
  let changed = false;
  for (const id of Object.keys(local)) {
    const onl = remote.find(h => h.id === id);
    if (local[id].published && onl && onl.vragen === local[id].chapter.vragen.length) { delete local[id]; changed = true; }
  }
  if (changed) lsSet(LS_LOCAL, local);
  const list = remote.filter(h => !local[h.id]);
  for (const [id, l] of Object.entries(local)) list.push({ ...catalogEntry(l.chapter), lokaal: l.published ? "wordt online gezet" : "alleen op dit toestel" });
  catalogCache = sortCatalog(list);
  return catalogCache;
}

export function clearCatalogCache() { catalogCache = null; }

async function loadChapter(id) {
  const local = lsGet(LS_LOCAL, {});
  if (local[id]) return local[id].chapter;
  const cat = await loadCatalog();
  const entry = cat.find(h => h.id === id);
  if (!entry) throw new Error("Dit hoofdstuk bestaat niet (meer).");
  const r = await fetch(entry.bestand, { cache: "no-cache" });
  if (!r.ok) throw new Error("Het hoofdstuk kon niet geladen worden.");
  return r.json();
}

/* ---------- Router ---------- */

function show(view) {
  for (const v of ["viewHome", "viewTest", "viewAdmin"]) $(v).hidden = v !== view;
  const bar = view === "viewTest";
  $("bar").hidden = !bar;
  document.body.classList.toggle("has-bar", bar);
  $("loadMsg").hidden = true;
}

function message(text, isErr) {
  const m = $("loadMsg");
  m.textContent = text;
  m.classList.toggle("err", !!isErr);
  m.hidden = false;
}

function crumbs(items) {
  $("crumbs").innerHTML = items.map(([label, href]) => href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`).join("<span aria-hidden=\"true\">›</span>");
}

async function route() {
  saveRun();
  clearInterval(tick);
  const h = location.hash.replace(/^#\/?/, "");
  const [page, arg] = h.split("/");
  try {
    if (page === "toets" && arg) {
      show("viewTest");
      const ch = await loadChapter(decodeURIComponent(arg));
      openTest(ch);
    } else if (page === "beheer") {
      show("viewAdmin");
      crumbs([["Alle hoofdstukken", "#/"], ["Beheer"]]);
      document.title = "Beheer · Gebuisd.be";
      const mod = await import("./beheer.js");
      await mod.renderAdmin($("viewAdmin"));
    } else {
      show("viewHome");
      crumbs([]);
      document.title = "Gebuisd.be Oefentoetsen";
      await renderHome();
    }
  } catch (e) {
    console.error(e);
    $("viewTest").hidden = true;
    $("bar").hidden = true;
    message(e.message || String(e), true);
  }
  window.scrollTo({ top: 0 });
}

/* ---------- Startpagina ---------- */

async function renderHome() {
  const el = $("catalog");
  el.innerHTML = `<p class="sub"><span class="spin"></span>Hoofdstukken laden…</p>`;
  const cat = await loadCatalog(true);
  if (!cat.length) { el.innerHTML = `<p class="panel">Er zijn nog geen hoofdstukken. Voeg er een toe.</p>`; return; }
  const byVak = new Map();
  for (const h of cat) { if (!byVak.has(h.vak)) byVak.set(h.vak, []); byVak.get(h.vak).push(h); }
  el.innerHTML = [...byVak].map(([vak, list]) => `
    <section class="vak"><h2>${esc(vak)}</h2><div class="cards">
      ${list.map(h => {
        const hist = lsGet(`gebuisd.${h.id}.hist`, []);
        const best = hist.length ? ` · laatste ${hist[0].s}/${hist[0].n || 20}` : "";
        return `<a class="card" href="#/toets/${encodeURIComponent(h.id)}">
          <span class="k">${esc([h.graad, h.nr ? "Hoofdstuk " + h.nr : ""].filter(Boolean).join(" · "))}</span>
          <b>${esc(h.titel)}</b>
          <span class="meta">${h.vragen} vragen${best}${h.lokaal ? ` · <em>${esc(h.lokaal)}</em>` : ""}</span>
        </a>`;
      }).join("")}
    </div></section>`).join("");
}

/* ---------- Toets ---------- */

let ch = null;      // huidig hoofdstuk
let state = null;   // huidige toets
let tick = null;
let pendingConfirm = false;

const key = k => `gebuisd.${ch.id}.${k}`;

function migrateOldKeys() {
  // eerdere versie van de site bewaarde enkel hoofdstuk 3 wiskunde onder deze sleutels
  if (ch.id !== "wiskunde-1-h3") return;
  const old = lsGet("h3toets.history", null);
  if (old && !lsGet(key("hist"), null)) lsSet(key("hist"), old.map(h => ({ ...h, n: 20 })));
  const seen = lsGet("h3toets.seen", null);
  if (seen && !lsGet(key("seen"), null)) lsSet(key("seen"), seen);
  lsDel("h3toets.history"); lsDel("h3toets.seen");
}

function openTest(chapter) {
  ch = chapter;
  migrateOldKeys();
  document.title = `${ch.titel} · Gebuisd.be`;
  crumbs([["Alle hoofdstukken", "#/"], [ch.vak], [ch.nr ? "Hoofdstuk " + ch.nr : ch.titel]]);
  $("tEyebrow").textContent = [ch.vak, ch.graad, ch.nr ? "Hoofdstuk " + ch.nr : ""].filter(Boolean).join(" · ");
  $("tTitle").textContent = ch.titel;
  const total = testSize();
  $("tSub").textContent = `${total} meerkeuzevragen, ${perSection()} per onderdeel. ${ch.beschrijving || ""}`.trim();
  $("limit").value = lsGet(LS_LIMIT, "0");

  const saved = lsGet(key("run"), null);
  if (saved && !saved.submitted && saved.ids.every(i => ch.vragen[i])) {
    state = saved;
    state.start = Date.now() - (saved.elapsedAtSave || 0) * 1000;
    render();
    startTimer();
  } else {
    newTest();
  }
}

function perSection() { return Math.max(1, Number(ch.perOnderdeel) || 4); }

function testSize() {
  return ch.onderdelen.reduce((n, _, s) => n + Math.min(perSection(), ch.vragen.filter(q => q.o === s).length), 0);
}

function pickQuestions() {
  let seen = lsGet(key("seen"), []).filter(i => ch.vragen[i]);
  const picked = [];
  ch.onderdelen.forEach((_, sec) => {
    const ids = ch.vragen.map((q, i) => q.o === sec ? i : -1).filter(i => i >= 0);
    let fresh = ids.filter(i => !seen.includes(i));
    if (fresh.length < perSection()) {
      // alle vragen van dit onderdeel gezien: opnieuw beginnen
      seen = seen.filter(i => ch.vragen[i].o !== sec);
      fresh = ids;
    }
    picked.push(...shuffle(fresh).slice(0, perSection()));
  });
  lsSet(key("seen"), seen.concat(picked));
  return picked;
}

function newTest() {
  const ids = pickQuestions();
  state = {
    ids,
    orders: ids.map(i => shuffle(ch.vragen[i].a.map((_, k) => k))),
    answers: ids.map(() => null),
    submitted: false,
    start: Date.now(),
    elapsed: 0,
    limit: Number($("limit").value) || 0
  };
  saveRun();
  render();
  startTimer();
  window.scrollTo({ top: 0 });
}

function saveRun() {
  if (!state || !ch) return;
  if (state.submitted) { lsDel(key("run")); return; }
  lsSet(key("run"), { ...state, elapsedAtSave: elapsedNow() });
}

function elapsedNow() { return state.submitted ? state.elapsed : (Date.now() - state.start) / 1000; }

function updateTimer() {
  const el = $("timer");
  const e = elapsedNow();
  if (state.limit && !state.submitted) {
    const left = state.limit * 60 - e;
    el.textContent = fmt(left);
    el.title = "Resterende tijd";
    el.classList.toggle("warn", left <= 60);
    if (left <= 0) submit(true);
  } else {
    el.textContent = fmt(e);
    el.title = state.submitted ? "Gebruikte tijd" : "Verstreken tijd";
    el.classList.remove("warn");
  }
}

function startTimer() { clearInterval(tick); updateTimer(); tick = setInterval(updateTimer, 500); }

function secLabel(s) { return ch.onderdelen[s].nr || String(s + 1); }

function render() {
  let html = "";
  let lastSec = -1;
  state.ids.forEach((id, qi) => {
    const q = ch.vragen[id];
    if (q.o !== lastSec) {
      if (lastSec >= 0) html += "</section>";
      html += `<section class="sec"><h2><span class="secnr">${esc(secLabel(q.o))}</span>${esc(ch.onderdelen[q.o].titel)}</h2>`;
      lastSec = q.o;
    }
    const n = qi + 1;
    const chosen = state.answers[qi];
    let cls = "q";
    if (state.submitted) cls += chosen === 0 ? " right" : " wrong";
    html += `<div class="${cls}" id="q${qi}"><div class="qhead"><span class="qnr">${n}</span><p class="qtext">${esc(q.v)}</p></div><div class="opts" role="radiogroup" aria-label="Vraag ${n}">`;
    state.orders[qi].forEach((oi, pos) => {
      let oc = "opt";
      if (chosen === oi) oc += " sel";
      if (state.submitted) {
        if (oi === 0) oc += " is-correct";
        else if (chosen === oi) oc += " is-wrong";
      }
      html += `<button type="button" class="${oc}" role="radio" aria-checked="${chosen === oi}" data-q="${qi}" data-o="${oi}" ${state.submitted ? "disabled" : ""}><span class="letter">${LETTERS[pos]}</span><span class="val">${esc(q.a[oi])}</span></button>`;
    });
    html += "</div>";
    if (state.submitted) {
      const lead = chosen === null ? "Niet beantwoord." : chosen === 0 ? "Juist!" : "Fout.";
      html += `<p class="expl"><b>${lead}</b>${esc(q.u)}</p>`;
    }
    html += "</div>";
  });
  if (lastSec >= 0) html += "</section>";
  $("test").innerHTML = html;
  renderResult();
  updateProgress();
  renderHistory();
}

function score() { return state.answers.filter(a => a === 0).length; }

function updateProgress() {
  const done = state.answers.filter(a => a !== null).length;
  const total = state.ids.length;
  $("progText").textContent = state.submitted ? `Ingediend · ${score()} van ${total} juist` : `${done} van ${total} beantwoord`;
  $("progBar").style.width = (state.submitted ? score() : done) / total * 100 + "%";
  $("submitBtn").textContent = state.submitted ? "Nieuwe vragen" : "Indienen";
  $("confirmMsg").hidden = true;
  pendingConfirm = false;
}

function verdict(s, n) {
  const p = s / n;
  if (p >= .9) return "Uitstekend! Je beheerst dit hoofdstuk.";
  if (p >= .7) return "Goed gedaan. Bekijk de fouten nog even.";
  if (p >= .5) return "Voldoende. Herhaal de onderdelen met de meeste fouten.";
  return "Nog niet voldoende. Lees de theorie opnieuw en probeer nog een toets.";
}

function renderResult() {
  const box = $("result");
  if (!state.submitted) { box.hidden = true; box.innerHTML = ""; return; }
  const s = score(), n = state.ids.length;
  let secs = "";
  ch.onderdelen.forEach((o, sec) => {
    let ok = 0, tot = 0;
    state.ids.forEach((id, qi) => { if (ch.vragen[id].o === sec) { tot++; if (state.answers[qi] === 0) ok++; } });
    if (tot) secs += `<div><b>${ok}/${tot}</b>${esc(secLabel(sec))} ${esc(o.titel)}</div>`;
  });
  box.innerHTML = `<div class="big">${s}<small>/${n}</small></div>
    <div><p><strong>${verdict(s, n)}</strong></p><p class="sub">Tijd: ${fmt(state.elapsed)}${state.timedOut ? " · de tijd was om" : ""}. De juiste antwoorden staan in het groen, met uitleg.</p></div>
    <div class="bysec">${secs}</div>`;
  box.hidden = false;
}

function submit(force) {
  if (state.submitted) return;
  const open = state.answers.filter(a => a === null).length;
  if (open && !force && !pendingConfirm) {
    pendingConfirm = true;
    const m = $("confirmMsg");
    m.textContent = `Nog ${open} open. Klik opnieuw om toch in te dienen.`;
    m.hidden = false;
    $("submitBtn").textContent = "Toch indienen";
    return;
  }
  state.elapsed = (Date.now() - state.start) / 1000;
  if (state.limit) state.elapsed = Math.min(state.elapsed, state.limit * 60);
  state.timedOut = !!force;
  state.submitted = true;
  const hist = lsGet(key("hist"), []);
  hist.unshift({ d: Date.now(), s: score(), n: state.ids.length, t: Math.round(state.elapsed) });
  lsSet(key("hist"), hist.slice(0, 30));
  saveRun();
  render();
  updateTimer();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function renderHistory() {
  const el = $("hist");
  const hist = lsGet(key("hist"), []);
  if (!hist.length) {
    el.innerHTML = `<h3>Jouw scores</h3><p class="empty">Nog geen toetsen ingediend. Na het indienen verschijnt je score hier, zodat je je vooruitgang ziet.</p>`;
    return;
  }
  const pct = h => h.s / (h.n || 20);
  const avg = hist.reduce((a, h) => a + pct(h), 0) / hist.length * 100;
  const rows = hist.slice(0, 10).map(h => {
    const d = new Date(h.d);
    const ds = d.toLocaleDateString("nl-BE", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" });
    return `<li><span class="muted">${ds}</span><span class="hb"><i style="width:${pct(h) * 100}%"></i></span><b>${h.s}/${h.n || 20}</b><span class="t muted">${fmt(h.t)}</span></li>`;
  }).join("");
  el.innerHTML = `<h3>Jouw scores <span class="muted" style="font-weight:400;font-size:14px">· gemiddeld ${Math.round(avg)}% over ${hist.length} toets${hist.length > 1 ? "en" : ""}</span></h3><ol>${rows}</ol>
    <p style="margin:10px 0 0"><button type="button" class="linkbtn" id="clearHist">Scores wissen</button></p>`;
}

/* ---------- Events ---------- */

$("test").addEventListener("click", e => {
  const b = e.target.closest(".opt");
  if (!b || state.submitted) return;
  const qi = Number(b.dataset.q), oi = Number(b.dataset.o);
  state.answers[qi] = oi;
  b.parentElement.querySelectorAll(".opt").forEach(x => {
    const on = Number(x.dataset.o) === oi;
    x.classList.toggle("sel", on);
    x.setAttribute("aria-checked", on);
  });
  saveRun();
  updateProgress();
});

$("submitBtn").addEventListener("click", () => { if (state.submitted) newTest(); else submit(false); });
$("newBtn").addEventListener("click", newTest);
$("limit").addEventListener("change", e => {
  lsSet(LS_LIMIT, e.target.value);
  if (!state.submitted) { state.limit = Number(e.target.value) || 0; saveRun(); updateTimer(); }
});
$("hist").addEventListener("click", e => {
  if (e.target.id !== "clearHist") return;
  if (e.target.dataset.armed) { lsSet(key("hist"), []); renderHistory(); }
  else { e.target.dataset.armed = "1"; e.target.textContent = "Klik nogmaals om alle scores te wissen"; }
});
addEventListener("pagehide", saveRun);
addEventListener("hashchange", route);
route();
