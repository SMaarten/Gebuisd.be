# Gebuisd.be – Oefentoetsen

Oefentoetsen per vak en hoofdstuk voor het secundair onderwijs. Iedereen kan zonder login toetsen maken. Wie inlogt (Google, Microsoft of Smartschool), ziet zijn historiek op elk toestel, kan lid worden van een klas en een hoofdstuk voorstellen. Leerkrachten zien de scores van hun klassen. De beheerder keurt voorstellen goed en zet ze online.

## Hoe het werkt

**Toetsen maken (iedereen, zonder login)**
- Op de startpagina staan alle hoofdstukken, gegroepeerd per vak.
- Elke toets heeft **20 meerkeuzevragen**, verdeeld over de onderdelen van het hoofdstuk in verhouding tot het aantal vragen per onderdeel in de vragenbank (elk onderdeel minstens één vraag). Vragen die je al kreeg, komen pas terug als een onderdeel op is.
- Na het indienen: score, verbetering met uitleg en score per onderdeel. Optionele tijdslimiet.
- Zonder login worden scores, de al gekregen vragen en een lopende toets enkel in de browser bewaard.

**Account (optioneel, voor leerlingen en leerkrachten)**
- Inloggen via de knop rechtsboven, met Google, Microsoft of Smartschool (enkel de logins die de beheerder instelde, worden getoond). Smartschool-co-accounts (ouders) worden geweigerd.
- Met een account: de historiek van alle toetsen en de al gekregen vragen staan op de server, dus op elk toestel dezelfde. Scores die al in de browser stonden, gaan bij het inloggen mee naar het account. Lukt het opslaan even niet (geen internet), dan wordt het later opnieuw geprobeerd.
- **Mijn account** (`#/mijn`): alle resultaten per hoofdstuk, lid worden van een klas met een klascode, klas verlaten, uitloggen, account en alle gegevens verwijderen.
- **Leerkrachten** (rol toegekend door de beheerder) maken via **Mijn klassen** (`#/klassen`) klassen aan en krijgen per klas een code van 6 tekens. In het klasoverzicht zien ze per leerling en per hoofdstuk de laatste score, de beste score en het aantal toetsen, enkel van toetsen gemaakt nadat de leerling lid werd.
- Een **privacyverklaring** staat op `#/privacy` (link onderaan de startpagina).

**Hoofdstuk voorstellen (ingelogd)**
- Via **+ Hoofdstuk toevoegen** stuurt een ingelogde gebruiker de cursus in: vak, jaar, hoofdstuk, optioneel titel en opmerking, plus de leerstof als PDF, foto's of tekst (samen max. 30 MB, max. 20 bestanden). Foto's worden in de browser verkleind.
- De bestanden gaan via de server naar de bestandsopslag van Claude en blijven daar bewaard tot de beheerder het voorstel verwijdert. Uploads waarvoor nooit een voorstel verstuurd werd, worden na een dag opgeruimd.
- Naam en e-mail van de indiener komen van het account.
- Op de pagina's voor bezoekers (startpagina, toets, voorstelformulier, foutmeldingen bij het insturen) wordt Claude nergens vermeld. Alleen de beheerpagina noemt de diensten die erachter zitten.

**Beheer (alleen admin, met wachtwoord)**
- Via het linkje **Beheer** onderaan de startpagina.
- **Voorstellen**: per voorstel *Vragen laten maken*. Claude (Opus 5.5) leest de cursus en bepaalt zelf hoeveel vragen nodig zijn om de leerstof te dekken (minstens 60, zodat er minstens drie verschillende toetsen mogelijk zijn). Dat duurt enkele minuten; de kostprijs wordt getoond.
- **Nakijken**: vragen schrappen, vak/jaar/hoofdstuk/titel aanpassen, eerst zelf uitproberen of als JSON downloaden.
- **Online zetten**: de server commit `data/<id>.json` en werkt `data/catalog.json` bij in deze repo. GitHub Pages publiceert het na ongeveer een minuut. Het voorstel blijft bewaard (gemarkeerd als *online gezet*), zodat je later opnieuw vragen kan laten maken.
- **Hoofdstukken**: bewerken, verwijderen, of een kant-en-klaar JSON-bestand laden.
- **Gebruikers**: iedereen die ooit inlogde, met de rol (leerling of leerkracht) aan te passen, of te verwijderen.
- **Instellingen**: Claude API-sleutel, GitHub-token, repository, branch en de logins (client ID en secret per dienst; voor Smartschool ook het adres van de school). Geheimen staan enkel op de server en worden alleen gemaskeerd getoond. Bij elke login staat de redirect URI die je bij de registratie moet opgeven.

## Opbouw

```
index.html            pagina (startpagina, toets, voorstel, beheer)
css/style.css
js/app.js             startpagina, toets en routering
js/account.js         inloggen, mijn account, klassen (leerkracht), privacy
js/voorstel.js        voorstelformulier
js/beheer.js          beheer (login, voorstellen, nakijken, hoofdstukken, instellingen)
js/api.js             aanroepen naar de server
js/config.js          adres van de server (API_URL)
js/util.js            gedeeld door site en server (formaat, controle, opslaan)
data/catalog.json     lijst van alle hoofdstukken
data/<id>.json        één bestand per hoofdstuk
favicon.svg, apple-touch-icon.png
worker/               de server (Cloudflare Worker), zie worker/README.md
```

De website is statisch (GitHub Pages). De server is een kleine Cloudflare Worker die de geheime sleutels bewaart, zodat ze nooit in de browser van een bezoeker terechtkomen, en die de accounts, resultaten en klassen bijhoudt in een Cloudflare D1-database. Zonder server werken de toetsen gewoon (zonder login); alleen accounts, voorstellen en beheer hebben hem nodig.

### Hoofdstukformaat

Het eerste antwoord in `a` is altijd het juiste; de toets schudt de volgorde. 2 tot 6 antwoorden per vraag. `o` is de index van het onderdeel.

```json
{
  "id": "wiskunde-1-h3", "vak": "Wiskunde", "graad": "1ste jaar", "nr": "3",
  "titel": "Bewerkingen met positieve getallen",
  "beschrijving": "Zonder rekentoestel.",
  "onderdelen": [{ "nr": "3.1", "titel": "Ordenen en de getallenas" }],
  "vragen": [{ "o": 0, "v": "Welk getal is het kleinst?", "a": ["52,000 9", "52,001", "52,01", "52,1"], "u": "Uitleg…" }]
}
```

## Installeren

1. **Website**: Settings → Pages → *Deploy from a branch* → `main`, map `/ (root)`. Voor gebuisd.be: vul het in onder *Custom domain*.
2. **Server**: volg [worker/README.md](worker/README.md) en vul daarna het adres van de server in `js/config.js` in.
3. **Eerste keer inloggen**: ga naar *Beheer*, log in met het admin-wachtwoord en vul onder *Instellingen* de Claude API-sleutel en het GitHub-token in. Klik op *Verbinding testen*.
4. **Logins voor leerlingen**: registreer de app bij Google, Microsoft en/of Smartschool (zie [worker/README.md](worker/README.md#logins-voor-leerlingen)) en vul de gegevens in onder *Instellingen*.
5. **Privacyverklaring**: lees `#/privacy` na (tekst in `js/account.js`) en vul aan waar nodig, bv. een contactadres.

Lokaal testen: `python3 -m http.server 8765` en open http://localhost:8765. Rechtstreeks `index.html` openen werkt niet, omdat de browser dan geen vragenbestanden laadt.

## Veiligheid

- Bezoekers zien nooit sleutels; de server doet alle aanroepen naar Claude en GitHub.
- Logins gebruiken OAuth2 met `state` (en PKCE bij Google en Microsoft). De site krijgt nooit een wachtwoord van een leerling. Een leerlingensessie blijft 30 dagen geldig en is ondertekend met een geheime sleutel die de server zelf aanmaakt.
- Een leerkracht ziet enkel leerlingen die met de klascode zelf lid werden, en enkel hun toetsen van na dat moment.
- Het admin-wachtwoord staat als geheim op de server. Na 10 foute pogingen per uur wordt een IP-adres tijdelijk geblokkeerd. Een sessie blijft 7 dagen geldig; een nieuw wachtwoord maakt alle sessies ongeldig.
- Tegen misbruik: per gebruiker max. 30 uploads en 5 voorstellen per uur, en samen max. 50 voorstellen per dag. Claude maakt alleen vragen als de beheerder erop klikt, dus voorstellen kosten op zich niets.
- Het GitHub-token geef je best enkel toegang tot deze repo, met *Contents: Read and write*.
