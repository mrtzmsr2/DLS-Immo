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

app.get('/api/export/pdf', (req, res) => {
  const standort = (req.query.standort || '').trim();
  const rows = buildReportRows(standort);
  const fname = `Maengelbericht_${standort || 'Alle'}_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\w.\-]/g, '_')}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  doc.fillColor('#008c82').fontSize(20).text('Mängelbericht', { continued: false });
  doc
    .fillColor('#5a626d')
    .fontSize(11)
    .text(`Standort: ${standort || 'Alle Standorte'}`)
    .text(`Erstellt: ${new Date().toLocaleString('de-DE')}`)
    .text(`Einträge: ${rows.length}`);
  doc.moveDown(0.6);

  if (!rows.length) {
    doc.fillColor('#2c333b').fontSize(12).text('Keine Einträge vorhanden.');
    doc.end();
    return;
  }

  rows.forEach(({ i, s }, n) => {
    if (doc.y > 740) doc.addPage();
    const statusColor =
      i.status === 'kritisch'
        ? '#dc3545'
        : i.status === 'handlungsbedarf'
        ? '#fd7e14'
        : i.status === 'provisorisch'
        ? '#d39e00'
        : '#28a745';
    doc
      .fillColor('#2c333b')
      .fontSize(12.5)
      .text(`${n + 1}. ${s.standort || '—'} · ${s.name || '—'} — ${i.titel || i.kategorie || 'Mangel'}`);
    doc
      .fillColor(statusColor)
      .fontSize(10)
      .text(
        `Status: ${STATUS_LABEL[i.status] || i.status || '—'}  |  Bearbeitung: ${
          BEARB_LABEL[i.bearbeitungsstatus] || 'Offen'
        }  |  Reicht aus: ${AUSR_LABEL[i.ausreichend] || '—'}`
      );
    doc.fillColor('#5a626d').fontSize(10);
    if (i.zustaendig || i.faelligBis)
      doc.text(`Zuständig: ${i.zustaendig || '—'}   Fällig bis: ${i.faelligBis || '—'}`);
    if (i.beschreibung) doc.text(`Beschreibung: ${i.beschreibung}`);
    if (i.vorhandeneGeraete) doc.text(`Vorhanden: ${i.vorhandeneGeraete}`);
    if (i.benoetigt) doc.fillColor('#856404').text(`Benötigt: ${i.benoetigt}`).fillColor('#5a626d');
    const nf = (i.fotos || []).length;
    const nk = (i.kommentare || []).length;
    if (nf || nk) doc.text(`Fotos: ${nf}   Kommentare: ${nk}`);
    doc.moveDown(0.5);
    doc
      .strokeColor('#dde2e7')
      .lineWidth(0.5)
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .stroke();
    doc.moveDown(0.4);
  });

  doc.end();
});

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
