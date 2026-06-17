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
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3300;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ───────────────────────────────────────────────────────────────────────────
//  Persistenz
// ───────────────────────────────────────────────────────────────────────────
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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

// Speichert ein Bild aus einer Data-URL auf der Platte und gibt den Dateinamen zurück.
function saveDataUrlImage(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null; // Sicherheitslimit 8 MB
  const fname = uid('foto') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
  return fname;
}

function deleteUploadFile(fileUrl) {
  try {
    const fp = path.join(UPLOADS_DIR, path.basename(fileUrl || ''));
    if (fp.startsWith(UPLOADS_DIR) && fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {
    /* ignorieren */
  }
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
      (removed.fotos || []).forEach((f) => deleteUploadFile(f.datei));
      const removedInfra = (db.infrastruktur || []).filter((i) => i.studioId === removed.id);
      removedInfra.forEach((i) => (i.fotos || []).forEach((f) => deleteUploadFile(f.datei)));
      db.infrastruktur = (db.infrastruktur || []).filter((i) => i.studioId !== removed.id);
      db.nachrichten = (db.nachrichten || []).filter((n) => n.studioId !== removed.id);
    }
    if (collection === 'infrastruktur') {
      (removed.fotos || []).forEach((f) => deleteUploadFile(f.datei));
    }
    writeDb(db);
    res.json({ ok: true, removed });
  });

  return router;
}

// ───────────────────────────────────────────────────────────────────────────
//  Benutzer & Berechtigungen
// ───────────────────────────────────────────────────────────────────────────
// Teams (Zugehörigkeit) und Regel, welche Teams Superadmin werden dürfen.
const TEAM_CODES = ['standort', 'dls', 'it', 'medien', 'immo'];
const SUPER_ALLOWED = ['dls', 'immo'];

function validateUser(b) {
  if (!b || !(b.vorname || '').trim()) return 'Vorname ist erforderlich';
  if (!(b.nachname || '').trim()) return 'Nachname ist erforderlich';
  if (!TEAM_CODES.includes(b.team)) return 'Ungültiges Team';
  if (b.superadmin && !SUPER_ALLOWED.includes(b.team))
    return 'Superadmin-Rechte sind nur für DLS oder Immobilienmanagement erlaubt';
  return null;
}

function getActor(db, req) {
  const id = (req.header('X-Acting-User') || '').trim();
  if (!id) return null;
  return (db.users || []).find((u) => u.id === id) || null;
}

function countActiveSuperadmins(users, exceptId) {
  return (users || []).filter(
    (u) => u.superadmin && u.aktiv !== false && u.id !== exceptId
  ).length;
}

// Zentrale Berechtigungsprüfung für alle schreibenden API-Zugriffe.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const sub = req.path.slice(4); // Pfad ohne führendes "/api"
  const db = readDb();
  const users = db.users || [];

  // Bootstrap: Solange kein Benutzer existiert, darf der erste (Super-)Admin angelegt werden.
  if (users.length === 0 && req.method === 'POST' && sub === '/users') return next();

  const actor = getActor(db, req);
  if (!actor) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
  if (actor.aktiv === false) return res.status(403).json({ error: 'Dieser Benutzer ist deaktiviert.' });

  // Benutzerverwaltung nur für Superadmins.
  if (sub === '/users' || sub.startsWith('/users/')) {
    if (!actor.superadmin)
      return res.status(403).json({ error: 'Nur Superadmins dürfen Benutzer verwalten.' });
    return next();
  }

  // Superadmins dürfen alles Übrige.
  if (actor.superadmin) return next();

  // Standort-Melder dürfen ausschließlich Mängel melden (+ Fotos/Kommentare dazu).
  if (actor.team === 'standort') {
    const ok =
      req.method === 'POST' &&
      (sub === '/infrastruktur' ||
        /^\/infrastruktur\/[^/]+\/(fotos|kommentare)$/.test(sub));
    if (!ok)
      return res
        .status(403)
        .json({ error: 'Standort-Melder dürfen ausschließlich Mängel melden.' });
    return next();
  }

  // Reguläre Team-Mitglieder (DLS/IT/Medien/Immo): voller operativer Zugriff.
  return next();
});

// Benutzer auflisten (für Login-Auswahl und Verwaltung).
app.get('/api/users', (req, res) => {
  res.json(readDb().users || []);
});

app.post('/api/users', (req, res) => {
  const db = readDb();
  const err = validateUser(req.body);
  if (err) return res.status(400).json({ error: err });
  db.users = db.users || [];
  const dup = db.users.find(
    (u) =>
      u.vorname.trim().toLowerCase() === req.body.vorname.trim().toLowerCase() &&
      u.nachname.trim().toLowerCase() === req.body.nachname.trim().toLowerCase()
  );
  if (dup) return res.status(400).json({ error: 'Benutzer mit diesem Namen existiert bereits.' });
  const user = {
    id: uid('usr'),
    vorname: req.body.vorname.trim(),
    nachname: req.body.nachname.trim(),
    team: req.body.team,
    superadmin: !!req.body.superadmin && SUPER_ALLOWED.includes(req.body.team),
    aktiv: req.body.aktiv !== false,
    erstelltAm: nowIso(),
    geaendertAm: nowIso(),
  };
  db.users.push(user);
  writeDb(db);
  res.status(201).json(user);
});

app.put('/api/users/:id', (req, res) => {
  const db = readDb();
  const list = db.users || [];
  const idx = list.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const merged = { ...list[idx], ...req.body };
  const err = validateUser(merged);
  if (err) return res.status(400).json({ error: err });
  const nextSuper = !!merged.superadmin && SUPER_ALLOWED.includes(merged.team);
  const wouldDeactivate = req.body.aktiv === false || !nextSuper;
  // Aussperren verhindern: mindestens ein aktiver Superadmin muss bestehen bleiben.
  if (list[idx].superadmin && list[idx].aktiv !== false && wouldDeactivate) {
    if (countActiveSuperadmins(list, list[idx].id) === 0)
      return res
        .status(400)
        .json({ error: 'Mindestens ein aktiver Superadmin muss erhalten bleiben.' });
  }
  list[idx] = {
    ...list[idx],
    vorname: merged.vorname.trim(),
    nachname: merged.nachname.trim(),
    team: merged.team,
    superadmin: nextSuper,
    aktiv: merged.aktiv !== false,
    geaendertAm: nowIso(),
  };
  writeDb(db);
  res.json(list[idx]);
});

app.delete('/api/users/:id', (req, res) => {
  const db = readDb();
  const list = db.users || [];
  const idx = list.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (list[idx].superadmin && list[idx].aktiv !== false && countActiveSuperadmins(list, list[idx].id) === 0)
    return res
      .status(400)
      .json({ error: 'Der letzte aktive Superadmin kann nicht gelöscht werden.' });
  const [removed] = list.splice(idx, 1);
  writeDb(db);
  res.json({ ok: true, removed });
});

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

// ───────────────────────────────────────────────────────────────────────────
//  Tool-Einträge (Listen-/Checklisten-Punkte eigener Tools)
// ───────────────────────────────────────────────────────────────────────────
const TOOL_ENTRY_STATUS = ['offen', 'in_arbeit', 'erledigt'];
const TOOL_ENTRY_PRIO = ['niedrig', 'mittel', 'hoch'];

function findTool(db, id) {
  return (db.tools || []).find((t) => t.id === id);
}

app.post('/api/tools/:id/eintraege', (req, res) => {
  const db = readDb();
  const tool = findTool(db, req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool nicht gefunden' });
  const titel = (req.body.titel || '').trim();
  if (!titel) return res.status(400).json({ error: 'Titel ist erforderlich' });
  const eintrag = {
    id: uid('te'),
    titel,
    notiz: (req.body.notiz || '').trim(),
    status: TOOL_ENTRY_STATUS.includes(req.body.status) ? req.body.status : 'offen',
    erledigt: !!req.body.erledigt,
    prioritaet: TOOL_ENTRY_PRIO.includes(req.body.prioritaet) ? req.body.prioritaet : 'mittel',
    zustaendig: (req.body.zustaendig || '').trim(),
    studioId: (req.body.studioId || '').trim() || null,
    faelligBis: (req.body.faelligBis || '').trim(),
    autor: (req.body.autor || '').trim(),
    erstelltAm: nowIso(),
    geaendertAm: nowIso(),
  };
  tool.eintraege = tool.eintraege || [];
  tool.eintraege.push(eintrag);
  tool.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(eintrag);
});

app.put('/api/tools/:id/eintraege/:eid', (req, res) => {
  const db = readDb();
  const tool = findTool(db, req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool nicht gefunden' });
  const list = tool.eintraege || [];
  const idx = list.findIndex((e) => e.id === req.params.eid);
  if (idx === -1) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  const next = { ...list[idx] };
  if (req.body.titel !== undefined) {
    const t = (req.body.titel || '').trim();
    if (!t) return res.status(400).json({ error: 'Titel ist erforderlich' });
    next.titel = t;
  }
  if (req.body.notiz !== undefined) next.notiz = (req.body.notiz || '').trim();
  if (req.body.status !== undefined && TOOL_ENTRY_STATUS.includes(req.body.status))
    next.status = req.body.status;
  if (req.body.erledigt !== undefined) next.erledigt = !!req.body.erledigt;
  if (req.body.prioritaet !== undefined && TOOL_ENTRY_PRIO.includes(req.body.prioritaet))
    next.prioritaet = req.body.prioritaet;
  if (req.body.zustaendig !== undefined) next.zustaendig = (req.body.zustaendig || '').trim();
  if (req.body.studioId !== undefined) next.studioId = (req.body.studioId || '').trim() || null;
  if (req.body.faelligBis !== undefined) next.faelligBis = (req.body.faelligBis || '').trim();
  next.geaendertAm = nowIso();
  list[idx] = next;
  tool.geaendertAm = nowIso();
  writeDb(db);
  res.json(next);
});

app.delete('/api/tools/:id/eintraege/:eid', (req, res) => {
  const db = readDb();
  const tool = findTool(db, req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool nicht gefunden' });
  const list = tool.eintraege || [];
  const idx = list.findIndex((e) => e.id === req.params.eid);
  if (idx === -1) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  tool.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true, removed });
});

// ───────────────────────────────────────────────────────────────────────────
//  Studio-Fotos
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/studios/:id/fotos', (req, res) => {
  const db = readDb();
  const studio = (db.studios || []).find((s) => s.id === req.params.id);
  if (!studio) return res.status(404).json({ error: 'Studio nicht gefunden' });
  const fname = saveDataUrlImage(req.body.dataUrl);
  if (!fname)
    return res.status(400).json({ error: 'Ungültiges oder zu großes Bild (max. 8 MB, JPG/PNG/WebP)' });
  const foto = {
    id: uid('foto'),
    datei: '/uploads/' + fname,
    raum: (req.body.raum || '').trim(),
    beschreibung: (req.body.beschreibung || '').trim(),
    hochgeladenVon: (req.body.hochgeladenVon || '').trim(),
    hochgeladenAm: nowIso(),
  };
  studio.fotos = studio.fotos || [];
  studio.fotos.push(foto);
  studio.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(foto);
});

app.delete('/api/studios/:id/fotos/:fotoId', (req, res) => {
  const db = readDb();
  const studio = (db.studios || []).find((s) => s.id === req.params.id);
  if (!studio) return res.status(404).json({ error: 'Studio nicht gefunden' });
  const list = studio.fotos || [];
  const idx = list.findIndex((f) => f.id === req.params.fotoId);
  if (idx === -1) return res.status(404).json({ error: 'Foto nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  deleteUploadFile(removed.datei);
  studio.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true, removed });
});

// ───────────────────────────────────────────────────────────────────────────
//  Mangel-Fotos & Kommentare (Infrastruktur)
// ───────────────────────────────────────────────────────────────────────────
function findInfra(db, id) {
  return (db.infrastruktur || []).find((i) => i.id === id);
}

app.post('/api/infrastruktur/:id/fotos', (req, res) => {
  const db = readDb();
  const infra = findInfra(db, req.params.id);
  if (!infra) return res.status(404).json({ error: 'Mangel nicht gefunden' });
  const fname = saveDataUrlImage(req.body.dataUrl);
  if (!fname)
    return res.status(400).json({ error: 'Ungültiges oder zu großes Bild (max. 8 MB, JPG/PNG/WebP)' });
  const foto = {
    id: uid('foto'),
    datei: '/uploads/' + fname,
    beschreibung: (req.body.beschreibung || '').trim(),
    hochgeladenVon: (req.body.hochgeladenVon || '').trim(),
    hochgeladenAm: nowIso(),
  };
  infra.fotos = infra.fotos || [];
  infra.fotos.push(foto);
  infra.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(foto);
});

app.delete('/api/infrastruktur/:id/fotos/:fotoId', (req, res) => {
  const db = readDb();
  const infra = findInfra(db, req.params.id);
  if (!infra) return res.status(404).json({ error: 'Mangel nicht gefunden' });
  const list = infra.fotos || [];
  const idx = list.findIndex((f) => f.id === req.params.fotoId);
  if (idx === -1) return res.status(404).json({ error: 'Foto nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  deleteUploadFile(removed.datei);
  infra.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true, removed });
});

app.post('/api/infrastruktur/:id/kommentare', (req, res) => {
  const db = readDb();
  const infra = findInfra(db, req.params.id);
  if (!infra) return res.status(404).json({ error: 'Mangel nicht gefunden' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text ist erforderlich' });
  const kommentar = {
    id: uid('kom'),
    text,
    team: (req.body.team || '').trim(),
    autor: (req.body.autor || '').trim(),
    typ: req.body.typ === 'status' ? 'status' : 'kommentar',
    erstelltAm: nowIso(),
  };
  infra.kommentare = infra.kommentare || [];
  infra.kommentare.push(kommentar);
  infra.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(kommentar);
});

app.delete('/api/infrastruktur/:id/kommentare/:kid', (req, res) => {
  const db = readDb();
  const infra = findInfra(db, req.params.id);
  if (!infra) return res.status(404).json({ error: 'Mangel nicht gefunden' });
  const list = infra.kommentare || [];
  const idx = list.findIndex((k) => k.id === req.params.kid);
  if (idx === -1) return res.status(404).json({ error: 'Kommentar nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  infra.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true, removed });
});

// ───────────────────────────────────────────────────────────────────────────
//  Mängelbericht-Export (Excel / PDF) – optional je Standort
// ───────────────────────────────────────────────────────────────────────────
const STATUS_LABEL = {
  ok: 'OK',
  provisorisch: 'Provisorisch',
  handlungsbedarf: 'Handlungsbedarf',
  kritisch: 'Kritisch',
};
const BEARB_LABEL = { offen: 'Offen', in_arbeit: 'In Arbeit', erledigt: 'Erledigt' };
const AUSR_LABEL = { ja: 'Reicht aus', ja_vorerst: 'Reicht vorerst', nein: 'Reicht nicht' };

function buildReportRows(standort) {
  const db = readDb();
  const studioById = {};
  (db.studios || []).forEach((s) => (studioById[s.id] = s));
  return (db.infrastruktur || [])
    .map((i) => ({ i, s: studioById[i.studioId] }))
    .filter(({ s }) => s && (!standort || s.standort === standort))
    .sort((a, b) => {
      const rank = { kritisch: 4, handlungsbedarf: 3, provisorisch: 2, ok: 1 };
      return (
        (rank[b.i.status] || 0) - (rank[a.i.status] || 0) ||
        (a.s.standort || '').localeCompare(b.s.standort || '', 'de')
      );
    });
}

app.get('/api/export/excel', (req, res) => {
  const standort = (req.query.standort || '').trim();
  const rows = buildReportRows(standort);
  const data = rows.map(({ i, s }) => ({
    Standort: s.standort || '',
    Studio: s.name || '',
    Kategorie: i.kategorie || '',
    Titel: i.titel || '',
    Status: STATUS_LABEL[i.status] || i.status || '',
    Bearbeitung: BEARB_LABEL[i.bearbeitungsstatus] || 'Offen',
    'Reicht aus?': AUSR_LABEL[i.ausreichend] || '',
    Zuständig: i.zustaendig || '',
    'Fällig bis': i.faelligBis || '',
    Vorhanden: i.vorhandeneGeraete || '',
    Benötigt: i.benoetigt || '',
    Beschreibung: i.beschreibung || '',
    Fotos: (i.fotos || []).length,
    Kommentare: (i.kommentare || []).length,
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ Hinweis: 'Keine Einträge' }]);
  ws['!cols'] = [
    { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 28 }, { wch: 16 }, { wch: 14 },
    { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 40 },
    { wch: 7 }, { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mängelbericht');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `Maengelbericht_${standort || 'Alle'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\w.\-]/g, '_')}"`);
  res.send(buf);
});

// FOM-Farbpalette für den PDF-Export.
const FOM = {
  primary: '#00bfb3',
  primaryDark: '#008c82',
  primaryLight: '#00d9cc',
  bandText: '#dffffb',
  ink: '#2c333b',
  muted: '#5a626d',
  faint: '#8b92a0',
  border: '#dde2e7',
  cardBg: '#fbfdfd',
};
const STATUS_COLOR = {
  kritisch: '#dc3545',
  handlungsbedarf: '#fd7e14',
  provisorisch: '#d39e00',
  ok: '#28a745',
};

app.get('/api/export/pdf', (req, res) => {
  const standort = (req.query.standort || '').trim();
  const rows = buildReportRows(standort);
  const fname = `Maengelbericht_${standort || 'Alle'}_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\w.\-]/g, '_')}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  doc.pipe(res);

  // Seiten zählen (bufferPages() existiert in dieser pdfkit-Version nicht).
  let pageCount = 1;
  doc.on('pageAdded', () => {
    pageCount++;
  });

  const M = 40;
  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const contentW = PAGE_W - M * 2;
  const bottomLimit = PAGE_H - 56;

  const statusColorOf = (st) => STATUS_COLOR[st] || FOM.muted;

  // Kopf-Banner im FOM-Farbverlauf (gestuft simuliert).
  function drawBand() {
    const bandH = 78;
    const steps = 60;
    for (let k = 0; k < steps; k++) {
      const t = k / (steps - 1);
      const c = lerpColor('#00d9cc', '#008c82', t);
      doc.rect((PAGE_W * k) / steps, 0, PAGE_W / steps + 1, bandH).fill(c);
    }
    doc.rect(0, bandH, PAGE_W, 4).fill(FOM.primaryLight);
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(21)
      .text('Mängelbericht', M, 22);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(FOM.bandText)
      .text(`DLS ↔ Immomanagement · Studio-Kommunikationsportal`, M, 50);
    doc
      .fontSize(9)
      .fillColor(FOM.bandText)
      .text(`Erstellt: ${new Date().toLocaleString('de-DE')}`, M, 50, {
        width: contentW,
        align: 'right',
      });
    doc.fillColor(FOM.ink).font('Helvetica');
    doc.y = bandH + 18;
  }

  // Farbige „Pille" mit Text; gibt die belegte Breite zurück.
  function pill(x, y, label, bg, fg = '#ffffff') {
    doc.font('Helvetica-Bold').fontSize(8.5);
    const w = doc.widthOfString(label) + 14;
    doc.roundedRect(x, y, w, 16, 8).fill(bg);
    doc.fillColor(fg).text(label, x + 7, y + 4.2, { lineBreak: false });
    doc.fillColor(FOM.ink).font('Helvetica');
    return w;
  }

  function newPageIfNeeded(estHeight) {
    if (doc.y + estHeight > bottomLimit) {
      doc.addPage();
      drawBand();
    }
  }

  drawBand();

  if (!rows.length) {
    doc.fillColor(FOM.muted).font('Helvetica').fontSize(12)
      .text('Keine Einträge vorhanden.', M, doc.y + 10);
    finishWithFooter(doc, M, PAGE_W, PAGE_H, contentW, pageCount);
    return;
  }

  // ── Übersicht: Statuszähler als Pillen ──────────────────────────────────
  const counts = { kritisch: 0, handlungsbedarf: 0, provisorisch: 0, ok: 0 };
  rows.forEach(({ i }) => {
    counts[i.status] = (counts[i.status] || 0) + 1;
  });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(FOM.primaryDark)
    .text(`Übersicht — ${standort || 'Alle Standorte'}`, M, doc.y);
  doc.font('Helvetica').fontSize(9.5).fillColor(FOM.muted)
    .text(`${rows.length} Einträge gesamt`, M, doc.y + 2);
  doc.moveDown(0.5);
  let sx = M;
  const sy = doc.y;
  [
    ['Kritisch', counts.kritisch, STATUS_COLOR.kritisch],
    ['Handlungsbedarf', counts.handlungsbedarf, STATUS_COLOR.handlungsbedarf],
    ['Provisorisch', counts.provisorisch, STATUS_COLOR.provisorisch],
    ['OK', counts.ok, STATUS_COLOR.ok],
  ].forEach(([lbl, cnt, col]) => {
    const w = pill(sx, sy, `${lbl}: ${cnt}`, col);
    sx += w + 8;
  });
  doc.y = sy + 26;
  doc.strokeColor(FOM.border).lineWidth(1).moveTo(M, doc.y).lineTo(PAGE_W - M, doc.y).stroke();
  doc.y += 14;

  // ── Einträge als Karten ─────────────────────────────────────────────────
  rows.forEach(({ i, s }, n) => {
    const statusColor = statusColorOf(i.status);
    const innerX = M + 16;
    const innerW = contentW - 30;

    // Höhe grob schätzen, damit Karten nicht über den Seitenrand brechen.
    let est = 64;
    [i.beschreibung, i.vorhandeneGeraete, i.benoetigt].forEach((tx) => {
      if (tx)
        est += doc.font('Helvetica').fontSize(9.5).heightOfString(tx, { width: innerW }) + 3;
    });
    newPageIfNeeded(est);

    const startY = doc.y;
    doc.y = startY + 12;

    // Titel.
    doc.fillColor(FOM.ink).font('Helvetica-Bold').fontSize(11.5)
      .text(`${n + 1}.  ${i.titel || i.kategorie || 'Mangel'}`, innerX, doc.y, { width: innerW });
    // Standort/Studio.
    doc.fillColor(FOM.muted).font('Helvetica').fontSize(9)
      .text(`${s.standort || '—'} · ${s.name || '—'}${i.kategorie ? '  ·  ' + i.kategorie : ''}`, innerX, doc.y + 1, { width: innerW });
    doc.moveDown(0.4);

    // Status-Pillen (mit Umbruch).
    let px = innerX;
    let py = doc.y;
    const addPill = (label, bg) => {
      doc.font('Helvetica-Bold').fontSize(8.5);
      const w = doc.widthOfString(label) + 14;
      if (px + w > innerX + innerW) {
        px = innerX;
        py += 20;
      }
      pill(px, py, label, bg);
      px += w + 6;
    };
    addPill(`Status: ${STATUS_LABEL[i.status] || i.status || '—'}`, statusColor);
    addPill(`Bearbeitung: ${BEARB_LABEL[i.bearbeitungsstatus] || 'Offen'}`, FOM.muted);
    if (i.ausreichend) addPill(`Reicht aus: ${AUSR_LABEL[i.ausreichend] || '—'}`, FOM.faint);
    doc.y = py + 22;

    // Detailzeilen.
    doc.font('Helvetica').fontSize(9.5);
    const line = (lbl, val, color = FOM.muted) => {
      if (!val) return;
      doc.fillColor(FOM.faint).font('Helvetica-Bold').fontSize(9)
        .text(lbl, innerX, doc.y, { continued: true, width: innerW });
      doc.fillColor(color).font('Helvetica').fontSize(9.5).text(' ' + val);
    };
    if (i.zustaendig || i.faelligBis)
      line('Zuständig:', `${i.zustaendig || '—'}    Fällig bis: ${i.faelligBis || '—'}`);
    line('Beschreibung:', i.beschreibung);
    line('Vorhanden:', i.vorhandeneGeraete);
    line('Benötigt:', i.benoetigt, '#9a6700');
    const nf = (i.fotos || []).length;
    const nk = (i.kommentare || []).length;
    if (nf || nk) line('Anhänge:', `${nf} Foto(s) · ${nk} Kommentar(e)`);

    const endY = doc.y + 12;
    // Kartenrahmen + farbige Statuskante zeichnen (hinter dem Text-Layout).
    doc.roundedRect(M, startY, contentW, endY - startY, 7).lineWidth(1).stroke(FOM.border);
    doc.roundedRect(M, startY, 5, endY - startY, 2).fill(statusColor);
    doc.fillColor(FOM.ink);
    doc.y = endY + 12;
  });

  finishWithFooter(doc, M, PAGE_W, PAGE_H, contentW, pageCount);
});

// Lineare Interpolation zweier Hex-Farben (für den Banner-Verlauf).
function lerpColor(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const c = pa.map((v, k) => Math.round(v + (pb[k] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Fußzeile mit Seitenzahlen auf alle gepufferten Seiten schreiben und schließen.
function finishWithFooter(doc, M, PAGE_W, PAGE_H, contentW, pageCount) {
  for (let p = 0; p < pageCount; p++) {
    doc.switchToPage(p);
    const fy = PAGE_H - 34;
    doc.strokeColor('#dde2e7').lineWidth(0.5).moveTo(M, fy - 6).lineTo(PAGE_W - M, fy - 6).stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#8b92a0')
      .text('DLS ↔ Immomanagement · Mängelbericht', M, fy, { lineBreak: false });
    doc.fontSize(8).fillColor('#8b92a0')
      .text(`Seite ${p + 1} von ${pageCount}`, M, fy, { width: contentW, align: 'right', lineBreak: false });
  }
  doc.flushPages();
  doc.end();
}

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
