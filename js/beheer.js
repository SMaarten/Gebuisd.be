// Beheer: een nieuw vak of hoofdstuk toevoegen.
// 1. Cursus uploaden (PDF, foto's of tekst)  2. Claude maakt de vragenbank
// 3. Nakijken en vragen schrappen            4. Online zetten = commit naar de GitHub-repo
import { lsGet, lsSet, lsDel, esc, chapterId, validateChapter, catalogEntry, serializeChapter, sortCatalog } from "./util.js";
import { loadCatalog, clearCatalogCache, LS_LOCAL } from "./app.js";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const MODEL = "claude-opus-5-5";
const LS_CFG = "gebuisd.admin";
const LS_DRAFT = "gebuisd.draft";
const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // API-limiet is 32 MB per aanvraag

let root, cfg, files = [], draft = null, busy = false, abortCtl = null;

const SYSTEM = `Je maakt oefentoetsen voor leerlingen in het Vlaamse secundair onderwijs. Je krijgt het cursusmateriaal van één hoofdstuk (PDF's, foto's van een handboek of tekst) en maakt er een vragenbank met meerkeuzevragen van, waarmee een leerling zich voorbereidt op de toets.

Opbouw
- Verdeel het hoofdstuk in de onderdelen die de cursus zelf gebruikt (bv. 3.1, 3.2, ...), met de nummering en titels uit de cursus. Gebruikt de cursus geen onderdelen, maak er dan zelf 3 tot 7 logische, met nummers in de vorm <hoofdstuk>.<volgnummer>.
- Spreid de vragen over alle onderdelen, in verhouding tot hoeveel leerstof elk onderdeel bevat. De toets trekt per onderdeel een vast aantal vragen (zie de opdracht); elk onderdeel moet er minstens drie keer zoveel hebben, zodat een leerling meerdere verschillende toetsen kan maken.

Vragen
- Toets wat in de cursus staat: begrippen, definities, eigenschappen, en vooral toepassingen en oefeningen in de stijl van de cursus. Gebruik de oefeningen uit de cursus als voorbeeld, maar varieer getallen en situaties.
- Elke vraag is op zichzelf te begrijpen, zonder de cursus of een figuur erbij. Verwijs niet naar "de figuur", "oefening 4" of "de tekst hierboven". Heb je een figuur nodig, beschrijf dan in woorden wat de leerling moet weten.
- Precies één antwoord is juist, en dat ondubbelzinnig. Reken elk juist antwoord zelf na en controleer dat geen enkel fout antwoord ook juist kan zijn.
- Geef 3 foute antwoorden. Alleen als een vraag maar twee zinnige opties heeft (zoals waar/onwaar), geef je er 1. Foute antwoorden zijn geloofwaardig: ze volgen uit typische fouten van leerlingen (een rekenfout, de verkeerde volgorde, verwarring met een verwant begrip). Geen grapantwoorden, geen "alle bovenstaande" of "geen van bovenstaande". Alle antwoorden zijn verschillend en ongeveer even lang, zodat de lengte het antwoord niet verraadt.
- De uitleg (1 tot 3 zinnen) legt uit waarom het juiste antwoord juist is en, waar dat helpt, welke denkfout tot een fout antwoord leidt.
- Varieer de moeilijkheid: ongeveer een derde eenvoudig, de helft gemiddeld, de rest uitdagend.
- Herhaal geen vragen: elke vraag toetst iets anders, of hetzelfde met duidelijk andere gegevens.

Taal en notatie
- Schrijf correct Nederlands zoals het in Vlaanderen op school gebruikt wordt, met de terminologie van de cursus. Spreek de leerling aan met "je".
- Getallen: decimale komma en een spatie als duizendtalscheiding (1 250,5). Gebruik in wiskunde · voor vermenigvuldigen en : voor delen, tenzij de cursus het anders doet.
- Schrijf platte tekst met Unicode-tekens voor symbolen en exponenten (x², √, ≤, π, →). Geen LaTeX, geen Markdown.

Velden
- titel: de titel van het hoofdstuk zoals in de cursus.
- beschrijving: één korte zin praktische info voor de leerling, bv. "Zonder rekentoestel." of "Ken de begrippen en hun betekenis."`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["titel", "beschrijving", "onderdelen"],
  properties: {
    titel: { type: "string" },
    beschrijving: { type: "string" },
    onderdelen: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["nr", "titel", "vragen"],
        properties: {
          nr: { type: "string" },
          titel: { type: "string" },
          vragen: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["vraag", "juist", "fout", "uitleg"],
              properties: {
                vraag: { type: "string" },
                juist: { type: "string" },
                fout: { type: "array", items: { type: "string" } },
                uitleg: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

/* ---------- Weergave ---------- */

export async function renderAdmin(el) {
  root = el;
  cfg = { repo: "SMaarten/Gebuisd.be", branch: "main", anthropicKey: "", githubToken: "", ...lsGet(LS_CFG, {}) };
  draft = lsGet(LS_DRAFT, null);
  const cat = await loadCatalog(true).catch(() => []);
  const vakken = [...new Set(cat.map(h => h.vak))];
  const graden = [...new Set(cat.map(h => h.graad).filter(Boolean))];

  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Beheer</span>
      <h1>Vak of hoofdstuk <mark>toevoegen</mark></h1>
      <p class="sub">Upload de cursus. Claude maakt er meerkeuzevragen van. Jij kijkt ze na en zet het hoofdstuk online voor iedereen.</p>
    </header>

    <details class="panel settings" id="settings" ${cfg.anthropicKey && cfg.githubToken ? "" : "open"}>
      <summary>Instellingen ${cfg.anthropicKey && cfg.githubToken ? '<span class="muted" style="font-weight:400">· ingesteld</span>' : '<span class="muted" style="font-weight:400">· nodig voor je begint</span>'}</summary>
      <div class="form">
        <div class="fields">
          <label class="field"><span>Claude API-sleutel</span>
            <input type="password" id="cKey" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(cfg.anthropicKey)}">
            <small>Maak er een op <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a>. Nodig om vragen te laten maken.</small>
          </label>
          <label class="field"><span>GitHub-token</span>
            <input type="password" id="cGh" autocomplete="off" spellcheck="false" placeholder="github_pat_…" value="${esc(cfg.githubToken)}">
            <small>Fine-grained token met enkel <i>Contents: Read and write</i> op deze repo. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Token maken</a>. Nodig om online te zetten.</small>
          </label>
          <label class="field"><span>Repository</span>
            <input id="cRepo" spellcheck="false" value="${esc(cfg.repo)}"><small>eigenaar/naam</small>
          </label>
          <label class="field"><span>Branch</span>
            <input id="cBranch" spellcheck="false" value="${esc(cfg.branch)}"><small>de branch die GitHub Pages publiceert</small>
          </label>
        </div>
        <p class="hint">De sleutels blijven enkel in deze browser op dit toestel. Gebruik dit niet op een gedeelde computer.</p>
        <div class="row">
          <button class="btn primary" type="button" id="cSave">Bewaren</button>
          <button class="btn" type="button" id="cTest">Verbinding testen</button>
          <button class="btn danger" type="button" id="cForget">Sleutels wissen</button>
        </div>
        <p class="status" id="cStatus" role="status"></p>
      </div>
    </details>

    <section class="panel form" id="upload">
      <h2>1. Cursus uploaden</h2>
      <div class="fields">
        <label class="field"><span>Vak</span>
          <input id="fVak" list="vakList" placeholder="bv. Wiskunde, Frans, Geschiedenis" value="${esc(lsGet("gebuisd.lastVak", ""))}">
          <datalist id="vakList">${vakken.map(v => `<option value="${esc(v)}">`).join("")}</datalist>
          <small>Een nieuwe naam maakt een nieuw vak aan.</small>
        </label>
        <label class="field"><span>Jaar</span>
          <input id="fGraad" list="graadList" placeholder="bv. 1ste jaar" value="${esc(lsGet("gebuisd.lastGraad", graden[0] || ""))}">
          <datalist id="graadList">${["1ste jaar", "2de jaar", "3de jaar", "4de jaar", "5de jaar", "6de jaar", ...graden].filter((g, i, a) => a.indexOf(g) === i).map(g => `<option value="${esc(g)}">`).join("")}</datalist>
        </label>
        <label class="field"><span>Hoofdstuk</span>
          <input id="fNr" inputmode="decimal" placeholder="bv. 4">
        </label>
        <label class="field"><span>Titel <small>(mag leeg)</small></span>
          <input id="fTitel" placeholder="Claude neemt de titel uit de cursus">
        </label>
      </div>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Bestanden kiezen">
        <strong>Sleep bestanden hierheen</strong> of klik om te kiezen<br>
        <small>PDF, foto's van de cursus (JPG, PNG) of tekst. Meerdere bestanden mag. Word? Bewaar eerst als PDF.</small>
      </div>
      <input type="file" id="fFiles" multiple accept="application/pdf,image/*,text/plain,.md,.txt" hidden>
      <ul class="files" id="fileList"></ul>
      <div class="fields">
        <label class="field"><span>Aantal vragen in de vragenbank</span>
          <input type="number" id="fCount" min="20" max="250" step="10" value="80">
          <small>Meer vragen = meer verschillende toetsen. 60 tot 120 is een goed aantal.</small>
        </label>
        <label class="field"><span>Vragen per onderdeel in een toets</span>
          <input type="number" id="fPer" min="1" max="10" value="4">
        </label>
      </div>
      <label class="field"><span>Extra instructies <small>(mag leeg)</small></span>
        <textarea id="fExtra" rows="3" placeholder="bv. Paragraaf 4.5 is geen leerstof. Zonder rekentoestel. Leg de nadruk op de woordenschat."></textarea>
      </label>
      <div class="row">
        <button class="btn primary" type="button" id="genBtn">Vragen laten maken</button>
        <button class="btn" type="button" id="stopBtn" hidden>Stoppen</button>
        <span class="muted" style="font-size:14px">of <button type="button" class="linkbtn" id="jsonBtn">laad een kant-en-klaar JSON-bestand</button></span>
        <input type="file" id="fJson" accept="application/json,.json" hidden>
      </div>
      <p class="status" id="gStatus" role="status" aria-live="polite"></p>
    </section>

    <section class="panel form" id="review" hidden></section>

    <section class="panel form" id="existing">
      <h2>Bestaande hoofdstukken</h2>
      ${cat.length ? `<ul class="admlist">${cat.map(h => `<li><span><b>${esc(h.vak)}</b> · ${esc([h.graad, h.nr ? "H" + h.nr : ""].filter(Boolean).join(" "))} ${esc(h.titel)} <span class="muted">(${h.vragen} vragen${h.lokaal ? ", " + esc(h.lokaal) : ""})</span></span>
        <span class="row"><a class="btn small" href="#/toets/${encodeURIComponent(h.id)}">Openen</a><button class="btn small" type="button" data-edit="${esc(h.id)}">Bewerken</button><button class="btn small danger" type="button" data-del="${esc(h.id)}">Verwijderen</button></span></li>`).join("")}</ul>` : `<p class="hint">Nog geen hoofdstukken.</p>`}
      <p class="status" id="eStatus" role="status"></p>
    </section>`;

  bind();
  renderFiles();
  if (draft) renderReview();
}

function $(id) { return root.querySelector("#" + id); }

function status(id, text, kind) {
  const el = $(id);
  el.innerHTML = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function bind() {
  $("cSave").onclick = () => { readCfg(); lsSet(LS_CFG, cfg); status("cStatus", "Bewaard.", "ok"); };
  $("cForget").onclick = () => {
    cfg.anthropicKey = cfg.githubToken = "";
    $("cKey").value = $("cGh").value = "";
    lsSet(LS_CFG, cfg);
    status("cStatus", "Sleutels gewist uit deze browser.", "ok");
  };
  $("cTest").onclick = testConnection;

  const drop = $("drop"), input = $("fFiles");
  drop.onclick = () => input.click();
  drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); };
  input.onchange = () => { addFiles(input.files); input.value = ""; };
  $("fileList").onclick = e => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { files.splice(Number(i), 1); renderFiles(); }
  };

  $("genBtn").onclick = generate;
  $("stopBtn").onclick = () => abortCtl?.abort();
  $("jsonBtn").onclick = () => $("fJson").click();
  $("fJson").onchange = importJson;
  $("existing").onclick = e => {
    if (e.target.dataset.del) removeChapter(e.target.dataset.del, e.target);
    if (e.target.dataset.edit) editChapter(e.target.dataset.edit);
  };
}

function readCfg() {
  cfg.anthropicKey = $("cKey").value.trim();
  cfg.githubToken = $("cGh").value.trim();
  cfg.repo = $("cRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  cfg.branch = $("cBranch").value.trim() || "main";
}

/* ---------- Bestanden ---------- */

const kb = n => n > 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " kB";

function addFiles(list) {
  for (const f of list) {
    const ok = f.type === "application/pdf" || f.type.startsWith("image/") || f.type.startsWith("text/") || /\.(md|txt)$/i.test(f.name);
    if (!ok) { status("gStatus", `${esc(f.name)}: dit bestandstype wordt niet ondersteund. Bewaar het als PDF.`, "err"); continue; }
    files.push(f);
  }
  renderFiles();
}

function renderFiles() {
  $("fileList").innerHTML = files.map((f, i) => `<li><span>${esc(f.name)} <span class="muted">· ${kb(f.size)}</span></span><button class="btn small" type="button" data-rm="${i}">Weg</button></li>`).join("");
}

function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error(`${file.name} kon niet gelezen worden.`));
    how === "text" ? r.readAsText(file) : r.readAsDataURL(file);
  });
}

// Foto's verkleinen tot max. 2000 px (de API weigert beelden boven 5 MB en schaalt groter toch af).
async function imageBlock(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(`${file.name} is geen leesbare afbeelding.`)); im.src = url; });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.85).split(",")[1];
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
  } finally { URL.revokeObjectURL(url); }
}

async function contentBlocks() {
  const blocks = [];
  let bytes = 0;
  for (const f of files) {
    let b;
    if (f.type === "application/pdf") {
      const data = (await readAs(f, "url")).split(",")[1];
      b = { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: f.name };
      bytes += data.length;
    } else if (f.type.startsWith("image/")) {
      b = await imageBlock(f);
      bytes += b.source.data.length;
    } else {
      const data = await readAs(f, "text");
      b = { type: "document", source: { type: "text", media_type: "text/plain", data }, title: f.name };
      bytes += data.length;
    }
    blocks.push(b);
  }
  if (bytes > MAX_REQUEST_BYTES) throw new Error(`De bestanden zijn samen te groot (${kb(bytes)} na omzetting, max. ongeveer 30 MB). Laat overbodige pagina's weg of splits het hoofdstuk.`);
  return blocks;
}

/* ---------- Vragen laten maken ---------- */

function meta() {
  const vak = $("fVak").value.trim(), graad = $("fGraad").value.trim(), nr = $("fNr").value.trim();
  return { vak, graad, nr, titel: $("fTitel").value.trim(), count: Math.min(250, Math.max(10, Number($("fCount").value) || 80)), per: Math.min(10, Math.max(1, Number($("fPer").value) || 4)), extra: $("fExtra").value.trim() };
}

async function generate() {
  if (busy) return;
  readCfg();
  const m = meta();
  if (!cfg.anthropicKey) { $("settings").open = true; return status("gStatus", "Vul eerst je Claude API-sleutel in bij Instellingen.", "err"); }
  if (!m.vak || !m.nr) return status("gStatus", "Vul minstens het vak en het hoofdstuknummer in.", "err");
  if (!files.length) return status("gStatus", "Kies eerst een of meer bestanden met de leerstof.", "err");
  if (draft && !confirm("Er staat nog een niet-opgeslagen vragenbank klaar. Die wordt vervangen. Doorgaan?")) return;
  lsSet(LS_CFG, cfg);
  lsSet("gebuisd.lastVak", m.vak);
  lsSet("gebuisd.lastGraad", m.graad);

  busy = true;
  abortCtl = new AbortController();
  $("genBtn").disabled = true;
  $("stopBtn").hidden = false;
  const t0 = Date.now();
  let shown = 0, timer = null;
  try {
    status("gStatus", `<span class="spin"></span>Bestanden voorbereiden…`);
    const blocks = await contentBlocks();
    status("gStatus", `<span class="spin"></span>Claude leest de cursus…`);
    const { default: Anthropic } = await import(SDK_URL);
    const client = new Anthropic({ apiKey: cfg.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 2 });

    const task = [
      `Vak: ${m.vak}`, m.graad && `Jaar: ${m.graad}`, `Hoofdstuk: ${m.nr}`, m.titel && `Titel: ${m.titel}`,
      `Maak in totaal ongeveer ${m.count} vragen. Een toets trekt ${m.per} vragen per onderdeel.`,
      m.extra && `Extra instructies:\n${m.extra}`
    ].filter(Boolean).join("\n");

    let text = "";
    const tick = () => {
      const n = (text.match(/"vraag"\s*:/g) || []).length;
      const s = Math.round((Date.now() - t0) / 1000);
      status("gStatus", `<span class="spin"></span>${n ? `Claude schrijft vragen… ${n} klaar` : "Claude leest de cursus en plant de vragen…"} <span class="muted">(${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})</span>\n<small class="muted">Dit duurt enkele minuten. Laat dit tabblad open.</small>`);
    };
    timer = setInterval(tick, 1000);

    const params = {
      model: MODEL,
      max_tokens: 64000,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: [...blocks, { type: "text", text: task }] }],
      // bij een weigering door de veiligheidsfilter probeert de API zelf een ander model
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default"
    };
    const run = async p => {
      text = "";
      const stream = client.beta.messages.stream(p, { signal: abortCtl.signal });
      stream.on("text", d => { text += d; });
      return stream.finalMessage();
    };
    let msg;
    try { msg = await run(params); }
    catch (e) {
      // als de fallback-optie (nog) niet aanvaard wordt: opnieuw zonder
      if (e?.status === 400 && /fallback|beta/i.test(e.message || "")) {
        const { betas, fallbacks, ...rest } = params;
        msg = await run(rest);
      } else throw e;
    }

    if (msg.stop_reason === "refusal") throw new Error("Claude weigerde dit materiaal te verwerken. Controleer of de bestanden enkel leerstof bevatten.");
    if (msg.stop_reason === "max_tokens") throw new Error("Het antwoord werd te lang en is afgebroken. Vraag minder vragen of splits het hoofdstuk.");
    // enkel de tekst na een eventuele overstap naar een ander model telt
    let start = 0;
    msg.content.forEach((b, i) => { if (b.type === "fallback") start = i + 1; });
    const json = msg.content.slice(start).filter(b => b.type === "text").map(b => b.text).join("");
    let out;
    try { out = JSON.parse(json); } catch { throw new Error("Het antwoord van Claude was geen geldige vragenbank. Probeer opnieuw."); }

    draft = toChapter(out, m);
    const errs = validateChapter(draft);
    if (errs.length) throw new Error("De vragenbank heeft fouten:\n" + errs.join("\n"));
    lsSet(LS_DRAFT, draft);
    const u = msg.usage || {};
    const cost = ((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6;
    status("gStatus", `Klaar: ${draft.vragen.length} vragen in ${draft.onderdelen.length} onderdelen. <span class="muted">Kostprijs ongeveer $${cost.toFixed(2)}.</span> Kijk ze hieronder na.`, "ok");
    renderReview();
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    status("gStatus", esc(friendlyError(e)), "err");
  } finally {
    clearInterval(timer);
    busy = false;
    $("genBtn").disabled = false;
    $("stopBtn").hidden = true;
  }
}

function friendlyError(e) {
  if (e?.name === "AbortError" || /abort/i.test(e?.message || "")) return "Gestopt.";
  const s = e?.status;
  if (s === 401) return "De Claude API-sleutel klopt niet. Controleer hem bij Instellingen.";
  if (s === 403) return "Deze API-sleutel heeft geen toegang. Controleer je account op platform.claude.com.";
  if (s === 413) return "De bestanden zijn te groot voor één aanvraag. Laat pagina's weg of splits het hoofdstuk.";
  if (s === 429) return "Te veel aanvragen of je tegoed is op. Wacht even of vul je tegoed aan op platform.claude.com.";
  if (s === 529 || s >= 500) return "De Claude-server is even overbelast. Probeer het over een paar minuten opnieuw.";
  if (s === 400) return "De aanvraag werd geweigerd: " + (e.error?.error?.message || e.message);
  if (/Failed to fetch|NetworkError|Load failed/i.test(e?.message || "")) return "Geen verbinding. Controleer je internet en probeer opnieuw.";
  return e?.message || String(e);
}

function toChapter(out, m) {
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
  const titel = m.titel || String(out.titel || "").trim() || `Hoofdstuk ${m.nr}`;
  return {
    id: chapterId(m.vak, m.graad, m.nr),
    vak: m.vak, graad: m.graad, nr: m.nr, titel,
    beschrijving: String(out.beschrijving || "").trim(),
    perOnderdeel: m.per,
    onderdelen, vragen
  };
}

async function importJson() {
  const f = $("fJson").files[0];
  $("fJson").value = "";
  if (!f) return;
  try {
    const c = JSON.parse(await readAs(f, "text"));
    const errs = validateChapter(c);
    if (errs.length) throw new Error(errs.join("\n"));
    if (draft && !confirm("Er staat nog een niet-opgeslagen vragenbank klaar. Die wordt vervangen. Doorgaan?")) return;
    draft = c;
    lsSet(LS_DRAFT, draft);
    status("gStatus", `${esc(f.name)} geladen: ${c.vragen.length} vragen.`, "ok");
    renderReview();
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    status("gStatus", "Dit bestand is geen geldige vragenbank:\n" + esc(e.message), "err");
  }
}

/* ---------- Nakijken ---------- */

function renderReview() {
  const box = $("review");
  if (!draft) { box.hidden = true; box.innerHTML = ""; return; }
  const per = draft.onderdelen.map((_, s) => draft.vragen.filter(q => q.o === s).length);
  box.innerHTML = `
    <h2>2. Nakijken</h2>
    <p class="hint">Lees de vragen na en schrap wat fout of onduidelijk is. Het groene antwoord is het juiste. Wijzigingen worden meteen bewaard in deze browser.</p>
    <div class="fields">
      <label class="field"><span>Vak</span><input data-m="vak" value="${esc(draft.vak)}"></label>
      <label class="field"><span>Jaar</span><input data-m="graad" value="${esc(draft.graad)}"></label>
      <label class="field"><span>Hoofdstuk</span><input data-m="nr" value="${esc(draft.nr)}"></label>
      <label class="field"><span>Vragen per onderdeel in een toets</span><input type="number" min="1" max="10" data-m="perOnderdeel" value="${esc(draft.perOnderdeel)}"></label>
    </div>
    <label class="field"><span>Titel</span><input data-m="titel" value="${esc(draft.titel)}"></label>
    <label class="field"><span>Korte info voor de leerling</span><input data-m="beschrijving" value="${esc(draft.beschrijving || "")}"></label>
    <p class="hint">Bestandsnaam: <code>data/${esc(draft.id)}.json</code></p>
    ${draft.onderdelen.map((o, s) => `
      <details ${s === 0 ? "open" : ""}>
        <summary><b>${esc(o.nr)} ${esc(o.titel)}</b> <span class="muted">· ${per[s]} vragen${per[s] < (draft.perOnderdeel || 4) ? " · te weinig voor een toets" : ""}</span></summary>
        <div class="preview" style="margin-top:10px">
          ${draft.vragen.map((q, i) => q.o !== s ? "" : `
            <div class="pq"><div class="top"><p>${esc(q.v)}</p><button class="btn small danger" type="button" data-rmq="${i}">Schrappen</button></div>
              <ul>${q.a.map((a, k) => `<li class="${k === 0 ? "ok" : ""}">${esc(a)}</li>`).join("")}</ul>
              ${q.u ? `<p class="u">${esc(q.u)}</p>` : ""}
            </div>`).join("")}
        </div>
      </details>`).join("")}
    <h2>3. Online zetten</h2>
    <div class="row">
      <button class="btn primary" type="button" id="pubBtn">Online zetten</button>
      <button class="btn" type="button" id="tryBtn">Eerst zelf uitproberen</button>
      <button class="btn" type="button" id="dlBtn">JSON downloaden</button>
      <button class="btn danger" type="button" id="discardBtn">Weggooien</button>
    </div>
    <p class="hint">Online zetten bewaart het hoofdstuk in de repo (<code>${esc(cfg.repo)}</code>). GitHub Pages heeft daarna ongeveer een minuut nodig; op dit toestel staat het er meteen.</p>
    <p class="status" id="pStatus" role="status"></p>`;
  box.hidden = false;

  box.oninput = e => {
    const k = e.target.dataset.m;
    if (!k) return;
    draft[k] = k === "perOnderdeel" ? Math.min(10, Math.max(1, Number(e.target.value) || 4)) : e.target.value.trim();
    if (["vak", "graad", "nr"].includes(k)) draft.id = chapterId(draft.vak, draft.graad, draft.nr);
    lsSet(LS_DRAFT, draft);
    const code = box.querySelector("code");
    if (code) code.textContent = `data/${draft.id}.json`;
  };
  box.onchange = e => { if (e.target.dataset.m === "perOnderdeel") renderReview(); };
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

function download() {
  if (!checkDraft()) return;
  const blob = new Blob([serializeChapter(draft)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = draft.id + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function tryLocal() {
  if (!checkDraft()) return;
  const local = lsGet(LS_LOCAL, {});
  local[draft.id] = { chapter: draft, published: false };
  lsSet(LS_LOCAL, local);
  clearCatalogCache();
  location.hash = "#/toets/" + encodeURIComponent(draft.id);
}

/* ---------- GitHub ---------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function gh(path, opts = {}) {
  if (!cfg.githubToken) throw new Error("Vul eerst een GitHub-token in bij Instellingen.");
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${cfg.githubToken}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) }
  });
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).message; } catch {}
    if (r.status === 401) throw new Error("Het GitHub-token klopt niet of is verlopen.");
    if (r.status === 403) throw new Error("Het GitHub-token mag niet schrijven in deze repo. Geef het 'Contents: Read and write'.");
    if (r.status === 404) throw new Error(`Repo of branch niet gevonden (${cfg.repo}, ${cfg.branch}), of het token heeft er geen toegang toe.`);
    if (r.status === 409) { const e = new Error("conflict"); e.conflict = true; throw e; }
    throw new Error(`GitHub gaf een fout (${r.status}): ${detail}`);
  }
  return r.status === 204 ? null : r.json();
}

const ref = () => `?ref=${encodeURIComponent(cfg.branch)}`;

async function getFile(path) {
  const f = await gh(`/contents/${path}${ref()}`, { allow404: true });
  return f ? { sha: f.sha, text: b64decode(f.content) } : null;
}

async function putFile(path, text, sha, message) {
  return gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: b64encode(text), branch: cfg.branch, ...(sha ? { sha } : {}) }) });
}

// Catalogus aanpassen; bij een conflict (iemand anders schreef net) één keer opnieuw.
async function updateCatalog(change, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await getFile("data/catalog.json");
    const cat = f ? JSON.parse(f.text) : { hoofdstukken: [] };
    cat.hoofdstukken = sortCatalog(change(cat.hoofdstukken || []));
    try { return await putFile("data/catalog.json", JSON.stringify(cat, null, 2) + "\n", f?.sha, message); }
    catch (e) { if (!e.conflict || attempt) throw e; }
  }
}

async function testConnection() {
  readCfg();
  lsSet(LS_CFG, cfg);
  const lines = [];
  status("cStatus", `<span class="spin"></span>Testen…`);
  try {
    if (!cfg.githubToken) lines.push("GitHub: geen token ingevuld.");
    else {
      const repo = await gh("");
      await gh(`/branches/${encodeURIComponent(cfg.branch)}`);
      lines.push(repo.permissions?.push === false ? "GitHub: verbonden, maar het token mag niet schrijven." : `GitHub: in orde (${repo.full_name}, branch ${cfg.branch}).`);
    }
  } catch (e) { lines.push("GitHub: " + e.message); }
  try {
    if (!cfg.anthropicKey) lines.push("Claude: geen sleutel ingevuld.");
    else {
      const { default: Anthropic } = await import(SDK_URL);
      const client = new Anthropic({ apiKey: cfg.anthropicKey, dangerouslyAllowBrowser: true });
      await client.models.retrieve(MODEL);
      lines.push("Claude: in orde.");
    }
  } catch (e) { lines.push("Claude: " + friendlyError(e)); }
  const bad = lines.some(l => !/in orde/.test(l));
  status("cStatus", lines.map(esc).join("\n"), bad ? "err" : "ok");
}

async function publish(btn) {
  if (!checkDraft()) return;
  readCfg();
  if (!cfg.githubToken) { $("settings").open = true; return status("pStatus", "Vul eerst een GitHub-token in bij Instellingen.", "err"); }
  btn.disabled = true;
  try {
    status("pStatus", `<span class="spin"></span>Controleren…`);
    const path = `data/${draft.id}.json`;
    const existing = await getFile(path);
    if (existing && !confirm(`Er bestaat al een hoofdstuk met deze naam (${path}). Overschrijven?`)) { status("pStatus", "Niet online gezet."); return; }
    const label = `${draft.vak} ${draft.graad} H${draft.nr}`.replace(/\s+/g, " ");
    status("pStatus", `<span class="spin"></span>Hoofdstuk opslaan…`);
    await putFile(path, serializeChapter(draft), existing?.sha, `${existing ? "Bijwerken" : "Toevoegen"}: ${label} ${draft.titel} (${draft.vragen.length} vragen)`);
    status("pStatus", `<span class="spin"></span>Lijst met hoofdstukken bijwerken…`);
    const entry = catalogEntry(draft);
    await updateCatalog(list => [...list.filter(h => h.id !== draft.id), entry], `Catalogus: ${label} ${draft.titel}`);

    const local = lsGet(LS_LOCAL, {});
    local[draft.id] = { chapter: draft, published: true };
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    const id = draft.id;
    draft = null;
    lsDel(LS_DRAFT);
    renderReview();
    status("gStatus", `Online gezet. Over ongeveer een minuut staat het voor iedereen op de site. <a href="#/toets/${encodeURIComponent(id)}">Toets openen</a>`, "ok");
    files = [];
    renderFiles();
  } catch (e) {
    status("pStatus", esc(e.message), "err");
  } finally { btn.disabled = false; }
}

async function editChapter(id) {
  if (draft && !confirm("Er staat nog een niet-opgeslagen vragenbank klaar. Die wordt vervangen. Doorgaan?")) return;
  try {
    const local = lsGet(LS_LOCAL, {});
    let c = local[id]?.chapter;
    if (!c) {
      const cat = await loadCatalog();
      const r = await fetch(cat.find(h => h.id === id).bestand, { cache: "no-cache" });
      c = await r.json();
    }
    draft = c;
    lsSet(LS_DRAFT, draft);
    renderReview();
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { status("eStatus", "Kon dit hoofdstuk niet openen.", "err"); }
}

async function removeChapter(id, btn) {
  const local = lsGet(LS_LOCAL, {});
  if (local[id] && !local[id].published) {
    delete local[id];
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    return renderAdmin(root);
  }
  if (!confirm(`Hoofdstuk "${id}" voor iedereen van de site verwijderen? De vragen blijven in de git-geschiedenis.`)) return;
  readCfg();
  btn.disabled = true;
  try {
    status("eStatus", `<span class="spin"></span>Verwijderen…`);
    await updateCatalog(list => list.filter(h => h.id !== id), `Catalogus: ${id} verwijderd`);
    const f = await getFile(`data/${id}.json`);
    if (f) await gh(`/contents/data/${id}.json`, { method: "DELETE", body: JSON.stringify({ message: `Verwijderen: ${id}`, sha: f.sha, branch: cfg.branch }) });
    delete local[id];
    lsSet(LS_LOCAL, local);
    clearCatalogCache();
    await renderAdmin(root);
    status("eStatus", "Verwijderd. Over ongeveer een minuut is het ook online weg.", "ok");
  } catch (e) {
    status("eStatus", esc(e.message), "err");
    btn.disabled = false;
  }
}
