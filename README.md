# DLS ↔ Immomanagement – Studio-Kommunikationsportal

Kollaboratives Portal, über das **DLS-Team** und **Immobilienmanagement** den Stand der
Studios gemeinsam aktuell halten – im Look der FOM-/Immobilienmanagement-Programme
(Türkis-Theme, Sidebar, Cards, Badges).

## Was kann es?

- **Studio-Übersicht** – geplante, im Bau befindliche und aktive Studios auf einen Blick (mit Status-Filter).
- **Infrastruktur-Status je Studio** – z. B. „Mobiles Klimagerät: Abluftschlauch nur mit Ductape fixiert, ohne Abluftfolie" inkl. Bewertung **Reicht es aus?** (ja / vorerst / nein) und Status (OK / provisorisch / Handlungsbedarf / kritisch).
- **Kommunikation** – gemeinsamer Meldungs-Verlauf zwischen beiden Teams, optional einem Studio zugeordnet, „Wichtig"-Markierung.
- **Dashboard** – Kennzahlen, offene Punkte und letzte Meldungen.
- **Erweiterbar** – eigene Tools/Module können über die UI angelegt und aktiviert werden; tiefere Logik lässt sich im Code (`Modules` in `public/index.html` bzw. neue API-Route in `server.js`) ergänzen. Wie MS Teams, nur selbst weiter-codierbar.

Alle Daten liegen serverseitig in einer geteilten JSON-Datei, sodass mehrere Personen
denselben Stand sehen und bearbeiten.

## Schnellstart

```powershell
npm install
npm start
```

Dann im Browser: <http://localhost:3300>

Beim ersten Start wird `data/db.json` aus `data/seed.json` erzeugt (Beispiel-Studios inkl.
Klimagerät-/Ductape-Beispiel). `db.json` ist per `.gitignore` ausgenommen – die echten
Daten bleiben also lokal/auf dem Server.

## Deployment (wie Immomanagement)

```powershell
pm2 start server.js --name dls-portal
pm2 save
```

Port via Umgebungsvariable `PORT` anpassbar (Standard `3300`).

## Projektstruktur

```
dls-immo-portal/
├─ server.js          # Express-Backend + REST-API + JSON-Speicher
├─ public/
│  └─ index.html      # Komplette Single-Page-App (FOM-Design)
├─ data/
│  ├─ seed.json       # Beispiel-Startdaten
│  └─ db.json         # Laufender Datenstand (wird automatisch erzeugt)
└─ package.json
```

## API (REST)

| Methode | Pfad | Zweck |
|--------|------|-------|
| GET | `/api/state` | Gesamter Datenstand |
| GET/POST | `/api/studios` | Studios lesen/anlegen |
| PUT/DELETE | `/api/studios/:id` | Studio ändern/löschen |
| GET/POST | `/api/infrastruktur` | Infrastruktur-Einträge |
| PUT/DELETE | `/api/infrastruktur/:id` | ändern/löschen |
| GET/POST | `/api/nachrichten` | Meldungen |
| GET/POST/PUT/DELETE | `/api/tools` | Tool-Registry |

## Neues Tool ergänzen

1. **Schnell (über UI):** Tab „Tools verwalten" → „+ Tool" → aktivieren. Es erscheint in der Seitenleiste.
2. **Mit eigener Logik:** in `public/index.html` einen Eintrag im Array `Modules` hinzufügen und eine `renderXyz(content, actions)`-Funktion schreiben. Bei Bedarf eine neue Collection im `server.js` über `makeCrud(...)` registrieren.
