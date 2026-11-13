# Gebuisd.be – Oefentoetsen

Oefentoetsen per vak en hoofdstuk voor het secundair onderwijs. Iedereen kan zonder login toetsen maken en een nieuw hoofdstuk voorstellen; de beheerder keurt voorstellen goed en zet ze online.

## Hoe het werkt

**Toetsen maken (iedereen, zonder login)**
- Op de startpagina staan alle hoofdstukken, gegroepeerd per vak.
- Elke toets heeft **20 meerkeuzevragen**, verdeeld over de onderdelen van het hoofdstuk in verhouding tot het aantal vragen per onderdeel in de vragenbank (elk onderdeel minstens één vraag). Vragen die je al kreeg, komen pas terug als een onderdeel op is.
- Na het indienen: score, verbetering met uitleg en score per onderdeel. Optionele tijdslimiet. Scores en een lopende toets worden in de browser bewaard.

**Hoofdstuk voorstellen (iedereen, zonder login)**
- Via **+ Hoofdstuk toevoegen** stuurt een bezoeker de cursus in: vak, jaar, hoofdstuk, optioneel titel, opmerking en naam, plus de leerstof als PDF, foto's of tekst (samen max. 30 MB, max. 20 bestanden). Foto's worden in de browser verkleind.
- De bestanden gaan via de server naar de bestandsopslag van Claude en blijven daar bewaard tot de beheerder het voorstel verwijdert. Uploads waarvoor nooit een voorstel verstuurd werd, worden na een dag opgeruimd.
- Op de pagina's voor bezoekers (startpagina, toets, voorstelformulier, foutmeldingen bij het insturen) wordt Claude nergens vermeld. Alleen de beheerpagina noemt de diensten die erachter zitten.

**Beheer (alleen admin, met wachtwoord)**
- Via het linkje **Beheer** onderaan de startpagina.
- **Voorstellen**: per voorstel *Vragen laten maken*. Claude (Opus 5.5) leest de cursus en bepaalt zelf hoeveel vragen nodig zijn om de leerstof te dekken (minstens 60, zodat er minstens drie verschillende toetsen mogelijk zijn). Dat duurt enkele minuten; de kostprijs wordt getoond.
- **Nakijken**: vragen schrappen, vak/jaar/hoofdstuk/titel aanpassen, eerst zelf uitproberen of als JSON downloaden.
- **Online zetten**: de server commit `data/<id>.json` en werkt `data/catalog.json` bij in deze repo. GitHub Pages publiceert het na ongeveer een minuut. Het voorstel blijft bewaard (gemarkeerd als *online gezet*), zodat je later opnieuw vragen kan laten maken.
- **Hoofdstukken**: bewerken, verwijderen, of een kant-en-klaar JSON-bestand laden.
- **Instellingen**: Claude API-sleutel, GitHub-token, repository en branch. Ze staan enkel op de server en worden alleen gemaskeerd getoond.

## Opbouw

```
index.html            pagina (startpagina, toets, voorstel, beheer)
css/style.css
js/app.js             startpagina, toets en routering
js/voorstel.js        voorstelformulier voor bezoekers
js/beheer.js          beheer (login, voorstellen, nakijken, hoofdstukken, instellingen)
js/api.js             aanroepen naar de server
js/config.js          adres van de server (API_URL)
js/util.js            gedeeld door site en server (formaat, controle, opslaan)
data/catalog.json     lijst van alle hoofdstukken
data/<id>.json        één bestand per hoofdstuk
favicon.svg, apple-touch-icon.png
worker/               de server (Cloudflare Worker), zie worker/README.md
```

De website is statisch (GitHub Pages). De server is een kleine Cloudflare Worker die de geheime sleutels bewaart, zodat ze nooit in de browser van een bezoeker terechtkomen. Zonder server werken de toetsen gewoon; alleen voorstellen en beheer hebben hem nodig.

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

Lokaal testen: `python3 -m http.server 8765` en open http://localhost:8765. Rechtstreeks `index.html` openen werkt niet, omdat de browser dan geen vragenbestanden laadt.

## Veiligheid

- Bezoekers zien nooit sleutels; de server doet alle aanroepen naar Claude en GitHub.
- Het admin-wachtwoord staat als geheim op de server. Na 10 foute pogingen per uur wordt een IP-adres tijdelijk geblokkeerd. Een sessie blijft 7 dagen geldig; een nieuw wachtwoord maakt alle sessies ongeldig.
- Tegen misbruik: per IP max. 30 uploads en 5 voorstellen per uur, en samen max. 50 voorstellen per dag. Claude maakt alleen vragen als de beheerder erop klikt, dus voorstellen kosten op zich niets.
- Het GitHub-token geef je best enkel toegang tot deze repo, met *Contents: Read and write*.
