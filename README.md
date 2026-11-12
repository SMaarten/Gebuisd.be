# Gebuisd.be – Oefentoetsen

Oefentoetsen per vak en hoofdstuk. Elke toets trekt meerkeuzevragen uit de vragenbank van het hoofdstuk, met verbetering en uitleg na het indienen, een timer en een scoreoverzicht (bewaard in de browser).

## Structuur

```
index.html          pagina (startpagina, toets en beheer)
css/style.css
js/app.js           startpagina en toets
js/beheer.js        hoofdstuk toevoegen (upload → Claude → nakijken → online zetten)
js/util.js
data/catalog.json   lijst van alle hoofdstukken
data/<id>.json      één bestand per hoofdstuk
```

Een hoofdstukbestand ziet er zo uit (het eerste antwoord in `a` is altijd het juiste; de toets schudt de volgorde):

```json
{
  "id": "wiskunde-1-h3", "vak": "Wiskunde", "graad": "1ste jaar", "nr": "3",
  "titel": "Bewerkingen met positieve getallen",
  "beschrijving": "Zonder rekentoestel.",
  "perOnderdeel": 4,
  "onderdelen": [{ "nr": "3.1", "titel": "Ordenen en de getallenas" }],
  "vragen": [{ "o": 0, "v": "Welk getal is het kleinst?", "a": ["52,000 9", "52,001", "52,01", "52,1"], "u": "Uitleg…" }]
}
```

## Online zetten (GitHub Pages)

Settings → Pages → *Deploy from a branch* → `main`, map `/ (root)`. Voor het domein gebuisd.be: vul het in onder *Custom domain*.

Lokaal testen: `python3 -m http.server 8765` en open http://localhost:8765. Rechtstreeks `index.html` openen werkt niet, omdat de browser dan geen vragenbestanden laadt.

## Een vak of hoofdstuk toevoegen

Klik op de startpagina op **+ Hoofdstuk toevoegen** (of ga naar `#/beheer`).

1. Vul eenmalig de instellingen in:
   - een **Claude API-sleutel** van https://platform.claude.com/settings/keys (betalend per gebruik; een hoofdstuk kost meestal enkele tientallen dollarcent);
   - een **GitHub-token**: fine-grained personal access token, enkel voor deze repo, met permissie *Contents: Read and write*.

   Beide blijven alleen in die browser bewaard. Gebruik het beheer niet op een gedeelde computer.
2. Vul vak, jaar en hoofdstuknummer in en upload de cursus (PDF, foto's van het handboek of tekst).
3. Claude (Opus 5.5) maakt de vragenbank. Dat duurt enkele minuten.
4. Kijk de vragen na en schrap wat niet klopt.
5. **Online zetten** commit `data/<id>.json` en werkt `data/catalog.json` bij. GitHub Pages heeft daarna ongeveer een minuut nodig.

Zonder sleutels kan je ook een kant-en-klaar JSON-bestand laden, of een hoofdstuk downloaden en zelf in `data/` zetten (vergeet dan `catalog.json` niet).
