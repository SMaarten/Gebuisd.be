# Gebuisd.be API (Cloudflare Worker)

Kleine server voor de website. Hij bewaart de Claude API-sleutel en het GitHub-token, ontvangt voorstellen van bezoekers en doet voor de beheerder de aanroepen naar Claude en GitHub. Een gratis Cloudflare-account volstaat.

## Eenmalig installeren

Je hebt [Node.js](https://nodejs.org) nodig. Alle commando's voer je uit in de map `worker`, niet in de hoofdmap van de repo:

```bash
cd worker
npm install
npx wrangler login                      # opent de browser om in te loggen bij Cloudflare
npx wrangler kv namespace create KV     # maakt de opslag aan en toont een id
```

Zet het getoonde id in `wrangler.toml` op de plaats van `VERVANG_DOOR_KV_ID`. Kies dan een lang, sterk admin-wachtwoord en zet de server online:

```bash
npx wrangler secret put ADMIN_PASSWORD  # typ het wachtwoord, het wordt niet getoond
npx wrangler deploy
```

`wrangler deploy` toont het adres van de server, bv. `https://gebuisd-api.<naam>.workers.dev`. Vul dat in `../js/config.js` in (`API_URL`) en commit.

Daarna op de website: **Beheer** → inloggen → **Instellingen** → Claude API-sleutel en GitHub-token invullen → **Verbinding testen**.

## Aanpassen

- **Websites die de server mogen gebruiken**: `ALLOWED_ORIGINS` in `wrangler.toml`. Komt de site op een ander adres, voeg het toe en voer `npx wrangler deploy` opnieuw uit.
- **Admin-wachtwoord wijzigen**: `npx wrangler secret put ADMIN_PASSWORD`. Alle bestaande sessies worden ongeldig.
- **Opdracht voor Claude** (hoe de vragen gemaakt worden): `src/prompt.js`, daarna `npx wrangler deploy`.

## Opslag

| Waar | Wat |
|---|---|
| Cloudflare KV | instellingen (sleutels, repo, branch), voorstellen, tellers tegen misbruik |
| Claude Files API | de ingestuurde cursusbestanden, zonder vervaldatum; verwijderd als de beheerder het voorstel verwijdert |
| GitHub-repo | de online gezette hoofdstukken (`data/`) |

## Kosten

- Cloudflare Workers en KV: het gratis plan volstaat voor normaal gebruik.
- Claude: enkel wanneer de beheerder op *Vragen laten maken* klikt, betaald via de API-sleutel. Bestanden uploaden en verwijderen bij Claude is gratis.

Op het gratis plan van Cloudflare is de rekentijd per aanvraag beperkt. Mislukt het uploaden van een groot bestand, splits het dan in kleinere PDF's (of neem het betaalde Workers-plan van $5 per maand).

## Lokaal testen

Maak een bestand `.dev.vars` (staat in `.gitignore`) met `ADMIN_PASSWORD="iets"` en start `npx wrangler dev --port 8787`. Zet in de browserconsole van de lokale site `localStorage.setItem("gebuisd.api", JSON.stringify("http://localhost:8787"))` om de site naar de lokale server te laten wijzen.
