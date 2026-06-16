/**
 * DLS ↔ Immomanagement – Kommunikationsportal
 * Express-Backend mit dateibasiertem JSON-Speicher (geteilt für alle Nutzer).
 *
 * Deployment-Hinweis: läuft wie das Immomanagement-Programm via `node server.js`
 * bzw. unter pm2 (`pm2 start server.js --name dls-portal`).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3300;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────────────────────────────────────────────────────
//  Persistenz
// ───────────────────────────────────────────────────────────────────────────
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const seed = fs.existsSync(SEED_FILE)
      ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
      : { studios: [], infrastruktur: [], nachrichten: [], tools: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  // Atomares Schreiben: erst in temp, dann umbenennen.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Generischer CRUD-Helfer für eine Collection.
function makeCrud(collection, { idPrefix, validate }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const db = readDb();
    res.json(db[collection] || []);
  });

  router.get('/:id', (req, res) => {
    const db = readDb();
    const item = (db[collection] || []).find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(item);
  });

  router.post('/', (req, res) => {
    const db = readDb();
    const err = validate ? validate(req.body) : null;
    if (err) return res.status(400).json({ error: err });
    const item = {
      ...req.body,
      id: uid(idPrefix),
      erstelltAm: nowIso(),
      geaendertAm: nowIso(),
    };
    db[collection] = db[collection] || [];
    db[collection].push(item);
    writeDb(db);
    res.status(201).json(item);
  });

  router.put('/:id', (req, res) => {
    const db = readDb();
    const list = db[collection] || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
    const err = validate ? validate({ ...list[idx], ...req.body }) : null;
    if (err) return res.status(400).json({ error: err });
    list[idx] = {
      ...list[idx],
      ...req.body,
      id: list[idx].id,
      erstelltAm: list[idx].erstelltAm,
      geaendertAm: nowIso(),
    };
    writeDb(db);
    res.json(list[idx]);
  });

  router.delete('/:id', (req, res) => {
    const db = readDb();
    const list = db[collection] || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
    const [removed] = list.splice(idx, 1);
    // Abhängige Datensätze miträumen.
    if (collection === 'studios') {
      db.infrastruktur = (db.infrastruktur || []).filter((i) => i.studioId !== removed.id);
      db.nachrichten = (db.nachrichten || []).filter((n) => n.studioId !== removed.id);
    }
    writeDb(db);
    res.json({ ok: true, removed });
  });

  return router;
}

// ───────────────────────────────────────────────────────────────────────────
//  API-Routen
// ───────────────────────────────────────────────────────────────────────────
app.use(
  '/api/studios',
  makeCrud('studios', {
    idPrefix: 'std',
    validate: (b) => (!b.name ? 'Name ist erforderlich' : null),
  })
);

app.use(
  '/api/infrastruktur',
  makeCrud('infrastruktur', {
    idPrefix: 'inf',
    validate: (b) =>
      !b.studioId ? 'studioId ist erforderlich' : !b.titel ? 'Titel ist erforderlich' : null,
  })
);

app.use(
  '/api/nachrichten',
  makeCrud('nachrichten', {
    idPrefix: 'msg',
    validate: (b) => (!b.text ? 'Text ist erforderlich' : null),
  })
);

// Registry erweiterbarer Tools/Module.
app.use(
  '/api/tools',
  makeCrud('tools', {
    idPrefix: 'tool',
    validate: (b) => (!b.name ? 'Name ist erforderlich' : null),
  })
);

// Gesamter Zustand auf einen Schlag (für initiales Laden des Frontends).
app.get('/api/state', (req, res) => {
  res.json(readDb());
});

// Health-Check.
app.get('/api/health', (req, res) => res.json({ ok: true, time: nowIso() }));

// SPA-Fallback.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDb();
app.listen(PORT, () => {
  console.log(`DLS ↔ Immo-Portal läuft auf http://localhost:${PORT}`);
});
