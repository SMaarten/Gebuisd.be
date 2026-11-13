// Aanroepen naar de Gebuisd.be API (Cloudflare Worker).
// Twee soorten sessies: een leerling/leerkracht (login via Google, Microsoft of Smartschool)
// en de beheerder (wachtwoord). Ze staan los van elkaar.
import { API_URL } from "./config.js";
import { lsGet, lsSet, lsDel } from "./util.js";

const LS_ADMIN = "gebuisd.sessie";
const LS_USER = "gebuisd.gebruiker";

// voor lokaal testen kan het adres overschreven worden via localStorage "gebuisd.api"
export function apiUrl() { return (lsGet("gebuisd.api", "") || API_URL).replace(/\/$/, ""); }

export class ApiFout extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const valid = s => s && s.verloopt > Date.now() ? s : null;

// admin
export function session() { return valid(lsGet(LS_ADMIN, null))?.token || null; }
export function setSession(s) { lsSet(LS_ADMIN, s); }
export function logout() { lsDel(LS_ADMIN); }

// leerling / leerkracht: { token, verloopt, naam, rol }
export function user() { return valid(lsGet(LS_USER, null)); }
export function setUser(s) { lsSet(LS_USER, s); }
export function logoutUser() { lsDel(LS_USER); }

export async function api(path, { method = "GET", body, headers = {}, raw = false, admin = false, auth = false } = {}) {
  const base = apiUrl();
  if (!base) throw new ApiFout(0, "De server is nog niet ingesteld.");
  const h = { ...headers };
  if (admin) { const t = session(); if (t) h.Authorization = "Bearer " + t; }
  if (auth) { const u = user(); if (u) h.Authorization = "Bearer " + u.token; }
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  let r;
  try { r = await fetch(base + path, { method, headers: h, body }); }
  catch { throw new ApiFout(0, "Geen verbinding met de server. Controleer je internet en probeer opnieuw."); }
  if (r.status === 401 && admin) logout();
  if (r.status === 401 && auth) logoutUser();
  if (!r.ok) {
    let msg = `Fout ${r.status}`;
    try { msg = (await r.json()).fout || msg; } catch {}
    throw new ApiFout(r.status, msg);
  }
  return raw ? r : r.json();
}

let statusCache = null;
export async function serverStatus() {
  if (!apiUrl()) return { ok: false, logins: [], voorstellen: false };
  if (!statusCache) statusCache = api("/status").catch(() => { statusCache = null; return { ok: false, logins: [], voorstellen: false }; });
  return statusCache;
}
