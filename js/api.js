// Aanroepen naar de Gebuisd.be API (Cloudflare Worker).
import { API_URL } from "./config.js";
import { lsGet, lsSet, lsDel } from "./util.js";

const LS_SESSION = "gebuisd.sessie";

// voor lokaal testen kan het adres overschreven worden via localStorage "gebuisd.api"
export function apiUrl() { return (lsGet("gebuisd.api", "") || API_URL).replace(/\/$/, ""); }

export class ApiFout extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function session() {
  const s = lsGet(LS_SESSION, null);
  return s && s.verloopt > Date.now() ? s.token : null;
}
export function setSession(s) { lsSet(LS_SESSION, s); }
export function logout() { lsDel(LS_SESSION); }

export async function api(path, { method = "GET", body, headers = {}, raw = false, admin = false } = {}) {
  const base = apiUrl();
  if (!base) throw new ApiFout(0, "De server is nog niet ingesteld (js/config.js).");
  const h = { ...headers };
  if (admin) { const t = session(); if (t) h.Authorization = "Bearer " + t; }
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  let r;
  try { r = await fetch(base + path, { method, headers: h, body }); }
  catch { throw new ApiFout(0, "Geen verbinding met de server. Controleer je internet en probeer opnieuw."); }
  if (r.status === 401 && admin) logout();
  if (!r.ok) {
    let msg = `Fout ${r.status}`;
    try { msg = (await r.json()).fout || msg; } catch {}
    throw new ApiFout(r.status, msg);
  }
  return raw ? r : r.json();
}
