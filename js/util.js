// Gedeelde hulpfuncties voor de toets en het beheer.

export function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
export function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

export function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

export function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function fmt(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }

export function slug(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function chapterId(vak, graad, nr) {
  return [slug(vak), slug(graad).replace(/-?(ste|de|e)-?jaar$/, "").replace(/-?jaar$/, ""), "h" + slug(nr)].filter(Boolean).join("-");
}

/**
 * Hoofdstukformaat (data/<id>.json):
 * { id, vak, graad, nr, titel, beschrijving, perOnderdeel,
 *   onderdelen: [{ nr, titel }],
 *   vragen: [{ o: index onderdeel, v: vraag, a: [juist, fout, ...], u: uitleg }] }
 * Het eerste antwoord in `a` is altijd het juiste; de toets schudt de volgorde.
 */
export function validateChapter(c) {
  const errs = [];
  if (!c || typeof c !== "object") return ["Geen geldig hoofdstukbestand."];
  for (const k of ["id", "vak", "titel"]) if (!c[k] || typeof c[k] !== "string") errs.push(`Veld "${k}" ontbreekt.`);
  if (c.id && !/^[a-z0-9-]+$/.test(c.id)) errs.push(`Id "${c.id}" mag enkel kleine letters, cijfers en - bevatten.`);
  if (!Array.isArray(c.onderdelen) || !c.onderdelen.length) errs.push("Er zijn geen onderdelen.");
  if (!Array.isArray(c.vragen) || !c.vragen.length) errs.push("Er zijn geen vragen.");
  if (errs.length) return errs;
  c.vragen.forEach((q, i) => {
    const n = i + 1;
    if (!Number.isInteger(q.o) || q.o < 0 || q.o >= c.onderdelen.length) errs.push(`Vraag ${n}: onderdeel ${q.o} bestaat niet.`);
    if (!q.v || typeof q.v !== "string") errs.push(`Vraag ${n}: vraagtekst ontbreekt.`);
    if (!Array.isArray(q.a) || q.a.length < 2 || q.a.length > 6) errs.push(`Vraag ${n}: moet 2 tot 6 antwoorden hebben.`);
    else if (new Set(q.a.map(x => String(x).trim())).size !== q.a.length) errs.push(`Vraag ${n}: twee antwoorden zijn gelijk.`);
  });
  return errs.slice(0, 12);
}

export function catalogEntry(c) {
  return { id: c.id, vak: c.vak, graad: c.graad || "", nr: c.nr || "", titel: c.titel, vragen: c.vragen.length, bestand: `data/${c.id}.json` };
}

// Eén vraag per regel, zodat wijzigingen in git leesbaar blijven.
export function serializeChapter(c) {
  const { vragen, ...rest } = c;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
  return head + ',\n  "vragen": [\n' + vragen.map(v => "    " + JSON.stringify({ o: v.o, v: v.v, a: v.a, u: v.u || "" })).join(",\n") + "\n  ]\n}\n";
}

export function sortCatalog(list) {
  const num = s => parseFloat(String(s).replace(",", ".")) || 0;
  return list.slice().sort((a, b) =>
    a.vak.localeCompare(b.vak, "nl") || String(a.graad).localeCompare(String(b.graad), "nl") || num(a.nr) - num(b.nr) || a.titel.localeCompare(b.titel, "nl"));
}
