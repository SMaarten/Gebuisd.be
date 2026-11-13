# Gebuisd.be API (Cloudflare Worker)

Kleine server voor de website. Hij bewaart de Claude API-sleutel, het GitHub-token en de login-gegevens, regelt het inloggen van leerlingen (Google, Microsoft, Smartschool), bewaart hun resultaten en klassen, ontvangt voorstellen en doet voor de beheerder de aanroepen naar Claude en GitHub. Een gratis Cloudflare-account volstaat.

## Eenmalig installeren

Je hebt [Node.js](https://nodejs.org) nodig. Alle commando's voer je uit in de map `worker`, niet in de hoofdmap van de repo:

```bash
cd worker
npm install
npx wrangler login                      # opent de browser om in te loggen bij Cloudflare
npx wrangler kv namespace create KV     # maakt de opslag aan en toont een id
npx wrangler d1 create gebuisd          # maakt de database aan en toont een database_id
```

Zet het KV-id in `wrangler.toml` op de plaats van `VERVANG_DOOR_KV_ID` en het database_id op de plaats van `VERVANG_DOOR_D1_ID`. Maak daarna de tabellen aan:

```bash
npx wrangler d1 execute gebuisd --remote --file schema.sql
```

Kies dan een lang, sterk admin-wachtwoord en zet de server online:

```bash
npx wrangler secret put ADMIN_PASSWORD  # typ het wachtwoord, het wordt niet getoond
npx wrangler deploy
```

`wrangler deploy` toont het adres van de server, bv. `https://gebuisd-api.<naam>.workers.dev`. Vul dat in `../js/config.js` in (`API_URL`) en commit.

Daarna op de website: **Beheer** → inloggen → **Instellingen** → Claude API-sleutel en GitHub-token invullen → **Verbinding testen**.

## Logins voor leerlingen

Per dienst registreer je de website één keer. Je krijgt een *client ID* en een *client secret*, die je invult onder **Beheer → Instellingen → Logins**. Als *redirect URI* geef je exact het adres op dat daar bij de dienst staat, bv. `https://gebuisd-api.<naam>.workers.dev/auth/google/callback`.

- **Google**: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → project maken → *OAuth-toestemmingsscherm* instellen (extern, scopes `openid`, `email`, `profile`) → *OAuth-client-ID* → type *Webtoepassing* → redirect URI toevoegen.
- **Microsoft**: [Microsoft Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) → *Nieuwe registratie* → *Accounts in elke organisatiemap en persoonlijke Microsoft-accounts* → platform *Web* met de redirect URI → *Certificaten en geheimen* → nieuw clientgeheim. In veel schoolomgevingen mogen leerlingen zelf geen toestemming geven aan een externe app; dan moet de ICT-beheerder van de school de app eenmalig goedkeuren (*admin consent*).
- **Smartschool**: aanvragen via het [aanvraagformulier voor scholen](https://www.smartschool.be/oauth/oauth-aanvraagformulier-voor-scholen/) (meer uitleg op [smartschool.be/OAuth](https://smartschool.be/OAuth)), met scope `userinfo` en de redirect URI. Vul naast client ID en secret ook het adres van de school in (`https://<school>.smartschool.be`). Smartschool geeft geen e-mailadres door, enkel naam en een vaste id. Co-accounts (ouders) worden geweigerd.

Iedereen die inlogt, is eerst *leerling*. Leerkrachten geef je de rol *leerkracht* onder **Beheer → Gebruikers**.

## Aanpassen

- **Websites die de server mogen gebruiken**: `ALLOWED_ORIGINS` in `wrangler.toml`. Komt de site op een ander adres, voeg het toe en voer `npx wrangler deploy` opnieuw uit.
- **Admin-wachtwoord wijzigen**: `npx wrangler secret put ADMIN_PASSWORD`. Alle bestaande sessies worden ongeldig.
- **Opdracht voor Claude** (hoe de vragen gemaakt worden): `src/prompt.js`, daarna `npx wrangler deploy`.

## Opslag

| Waar | Wat |
|---|---|
| Cloudflare KV | instellingen (sleutels, repo, branch, logins), voorstellen, lopende logins, tellers tegen misbruik |
| Cloudflare D1 | gebruikers, resultaten, al gekregen vragen, klassen en leden (`schema.sql`) |
| Claude Files API | de ingestuurde cursusbestanden, zonder vervaldatum; verwijderd als de beheerder het voorstel verwijdert |
| GitHub-repo | de online gezette hoofdstukken (`data/`) |

## Kosten

- Cloudflare Workers, KV en D1: het gratis plan volstaat voor normaal gebruik.
- Google-, Microsoft- en Smartschool-logins zijn gratis.
- Claude: enkel wanneer de beheerder op *Vragen laten maken* klikt, betaald via de API-sleutel. Bestanden uploaden en verwijderen bij Claude is gratis.

Op het gratis plan van Cloudflare is de rekentijd per aanvraag beperkt. Mislukt het uploaden van een groot bestand, splits het dan in kleinere PDF's (of neem het betaalde Workers-plan van $5 per maand).

## Lokaal testen

Maak een bestand `.dev.vars` (staat in `.gitignore`) met `ADMIN_PASSWORD="iets"`, maak de lokale database aan met `npx wrangler d1 execute gebuisd --local --file schema.sql` en start `npx wrangler dev --port 8787`. Met `OAUTH_MOCK="http://..."` in `.dev.vars` gaan alle logins naar een eigen testserver in plaats van naar Google, Microsoft of Smartschool; zet dat nooit in productie. Zet in de browserconsole van de lokale site `localStorage.setItem("gebuisd.api", JSON.stringify("http://localhost:8787"))` om de site naar de lokale server te laten wijzen.
