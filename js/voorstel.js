// Voorstelformulier voor bezoekers: cursus insturen zonder login. De beheerder keurt het goed.
import { lsGet, lsSet, esc } from "./util.js";
import { api, apiUrl } from "./api.js";

const MB = 1024 * 1024;
const MAX_FILE = 25 * MB, MAX_TOTAL = 30 * MB, MAX_FILES = 20;

let root, files = [], busy = false;

export function renderPropose(el) {
  root = el;
  files = [];
  root.innerHTML = `
    <header class="top">
      <span class="eyebrow">Hoofdstuk voorstellen</span>
      <h1>Stuur je <mark>cursus</mark> in</h1>
      <p class="sub">Upload de leerstof van één hoofdstuk. De beheerder kijkt je voorstel na; na goedkeuring wordt er een oefentoets gemaakt voor iedereen.</p>
    </header>
    ${apiUrl() ? "" : `<p class="panel msg err">Insturen is nog niet mogelijk: de server is nog niet ingesteld.</p>`}
    <section class="panel form" id="form">
      <div class="fields">
        <label class="field"><span>Vak</span>
          <input id="fVak" maxlength="60" placeholder="bv. Wiskunde, Frans, Geschiedenis" value="${esc(lsGet("gebuisd.lastVak", ""))}">
        </label>
        <label class="field"><span>Jaar</span>
          <input id="fGraad" maxlength="30" list="graadList" placeholder="bv. 1ste jaar" value="${esc(lsGet("gebuisd.lastGraad", ""))}">
          <datalist id="graadList">${["1ste jaar", "2de jaar", "3de jaar", "4de jaar", "5de jaar", "6de jaar"].map(g => `<option value="${g}">`).join("")}</datalist>
        </label>
        <label class="field"><span>Hoofdstuk</span>
          <input id="fNr" maxlength="10" inputmode="decimal" placeholder="bv. 4">
        </label>
        <label class="field"><span>Titel <small>(mag leeg)</small></span>
          <input id="fTitel" maxlength="120" placeholder="bv. Breuken">
        </label>
      </div>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Bestanden kiezen">
        <strong>Sleep bestanden hierheen</strong> of klik om te kiezen<br>
        <small>PDF, foto's van de cursus (JPG, PNG) of tekst. Meerdere bestanden mag, samen max. 30 MB. Word? Bewaar eerst als PDF.</small>
      </div>
      <input type="file" id="fFiles" multiple accept="application/pdf,image/*,text/plain,.md,.txt" hidden>
      <ul class="files" id="fileList"></ul>
      <label class="field"><span>Opmerking <small>(mag leeg)</small></span>
        <textarea id="fOpm" rows="3" maxlength="2000" placeholder="bv. Paragraaf 4.5 is geen leerstof. De toets is zonder rekentoestel."></textarea>
      </label>
      <label class="field"><span>Je naam <small>(mag leeg, enkel zichtbaar voor de beheerder)</small></span>
        <input id="fNaam" maxlength="80">
      </label>
      <div class="row"><button class="btn primary" type="button" id="sendBtn">Voorstel versturen</button></div>
      <p class="status" id="sStatus" role="status" aria-live="polite"></p>
    </section>`;

  const drop = $("drop"), input = $("fFiles");
  drop.onclick = () => input.click();
  drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); };
  input.onchange = () => { addFiles(input.files); input.value = ""; };
  $("fileList").onclick = e => { const i = e.target.dataset.rm; if (i !== undefined && !busy) { files.splice(Number(i), 1); renderFiles(); } };
  $("sendBtn").onclick = send;
}

const $ = id => root.querySelector("#" + id);
const kb = n => n > MB ? (n / MB).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " kB";

function status(text, kind) { const el = $("sStatus"); el.innerHTML = text; el.className = "status" + (kind ? " " + kind : ""); }

function fileType(f) {
  if (f.type === "application/pdf") return "application/pdf";
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("text/") || /\.(md|txt)$/i.test(f.name)) return "text/plain";
  return null;
}

function addFiles(list) {
  for (const f of list) {
    if (!fileType(f)) { status(`${esc(f.name)}: dit bestandstype wordt niet ondersteund. Bewaar het als PDF.`, "err"); continue; }
    if (fileType(f) !== "image" && f.size > MAX_FILE) { status(`${esc(f.name)} is te groot (max. 25 MB).`, "err"); continue; }
    if (files.length >= MAX_FILES) { status(`Maximaal ${MAX_FILES} bestanden.`, "err"); break; }
    files.push({ file: f, state: "" });
  }
  renderFiles();
}

function renderFiles() {
  $("fileList").innerHTML = files.map((x, i) => `<li><span>${esc(x.file.name)} <span class="muted">· ${kb(x.file.size)}${x.state ? " · " + esc(x.state) : ""}</span></span>${busy ? "" : `<button class="btn small" type="button" data-rm="${i}">Weg</button>`}</li>`).join("");
}

// Foto's verkleinen tot max. 2000 px: sneller uploaden en de API weigert beelden boven 5 MB.
async function shrinkImage(file) {
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
    return await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
  } finally { URL.revokeObjectURL(url); }
}

async function send() {
  if (busy) return;
  const v = {
    vak: $("fVak").value.trim(), graad: $("fGraad").value.trim(), nr: $("fNr").value.trim(),
    titel: $("fTitel").value.trim(), opmerking: $("fOpm").value.trim(), naam: $("fNaam").value.trim()
  };
  if (!v.vak || !v.nr) return status("Vul minstens het vak en het hoofdstuknummer in.", "err");
  if (!files.length) return status("Kies eerst een of meer bestanden met de leerstof.", "err");
  lsSet("gebuisd.lastVak", v.vak);
  lsSet("gebuisd.lastGraad", v.graad);

  busy = true;
  $("sendBtn").disabled = true;
  try {
    // eerst alles klaarmaken en de totale grootte controleren
    const blobs = [];
    for (const x of files) {
      const t = fileType(x.file);
      const blob = t === "image" ? await shrinkImage(x.file) : x.file;
      blobs.push({ blob, type: t === "image" ? "image/jpeg" : t, name: t === "image" ? x.file.name.replace(/\.\w+$/, "") + ".jpg" : x.file.name });
    }
    const total = blobs.reduce((n, b) => n + b.blob.size, 0);
    if (total > MAX_TOTAL) throw new Error(`De bestanden zijn samen te groot (${kb(total)}, max. 30 MB). Laat overbodige pagina's weg.`);

    const ids = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i].id) { ids.push(files[i].id); continue; }
      files[i].state = "uploaden…"; renderFiles();
      status(`<span class="spin"></span>Bestand ${i + 1} van ${files.length} uploaden…`);
      const b = blobs[i];
      const res = await api("/upload", { method: "POST", body: b.blob, headers: { "Content-Type": b.type, "X-Bestandsnaam": encodeURIComponent(b.name) } });
      files[i].id = res.id;
      files[i].state = "klaar"; renderFiles();
      ids.push(res.id);
    }
    status(`<span class="spin"></span>Voorstel versturen…`);
    await api("/voorstel", { method: "POST", body: { ...v, bestanden: ids } });
    root.querySelector("#form").innerHTML = `
      <h2>Bedankt!</h2>
      <p class="status ok">Je voorstel voor ${esc(v.vak)}, hoofdstuk ${esc(v.nr)} is verstuurd. Zodra de beheerder het goedkeurt, verschijnt de toets op de startpagina.</p>
      <div class="row"><a class="btn primary" href="#/">Naar de startpagina</a><button class="btn" type="button" id="again">Nog een hoofdstuk insturen</button></div>`;
    root.querySelector("#again").onclick = () => renderPropose(root);
  } catch (e) {
    files.forEach(x => { if (x.state === "uploaden…") x.state = "mislukt"; });
    renderFiles();
    status(esc(e.message || String(e)), "err");
  } finally {
    busy = false;
    const b = root.querySelector("#sendBtn");
    if (b) { b.disabled = false; renderFiles(); }
  }
}
