-- Gebuisd.be: leerlingen, resultaten en klassen (Cloudflare D1)
-- Uitvoeren:  npx wrangler d1 execute gebuisd --remote --file schema.sql

CREATE TABLE IF NOT EXISTS gebruikers (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,              -- google | microsoft | smartschool
  sub         TEXT NOT NULL,              -- vaste id bij de provider
  naam        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  rol         TEXT NOT NULL DEFAULT 'leerling',   -- leerling | leerkracht
  aangemaakt  INTEGER NOT NULL,
  laatst      INTEGER NOT NULL,
  UNIQUE (provider, sub)
);

CREATE TABLE IF NOT EXISTS resultaten (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gebruiker   TEXT NOT NULL REFERENCES gebruikers(id) ON DELETE CASCADE,
  hoofdstuk   TEXT NOT NULL,
  datum       INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  n           INTEGER NOT NULL,
  tijd        INTEGER NOT NULL DEFAULT 0,
  onderdelen  TEXT NOT NULL DEFAULT '[]',  -- [[nr, juist, totaal], ...]
  UNIQUE (gebruiker, hoofdstuk, datum)
);
CREATE INDEX IF NOT EXISTS resultaten_gebruiker ON resultaten (gebruiker, hoofdstuk, datum);

CREATE TABLE IF NOT EXISTS gezien (
  gebruiker   TEXT NOT NULL REFERENCES gebruikers(id) ON DELETE CASCADE,
  hoofdstuk   TEXT NOT NULL,
  ids         TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (gebruiker, hoofdstuk)
);

CREATE TABLE IF NOT EXISTS klassen (
  id          TEXT PRIMARY KEY,
  naam        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  leerkracht  TEXT NOT NULL REFERENCES gebruikers(id) ON DELETE CASCADE,
  aangemaakt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leden (
  klas        TEXT NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
  gebruiker   TEXT NOT NULL REFERENCES gebruikers(id) ON DELETE CASCADE,
  sinds       INTEGER NOT NULL,
  PRIMARY KEY (klas, gebruiker)
);
CREATE INDEX IF NOT EXISTS leden_gebruiker ON leden (gebruiker);
