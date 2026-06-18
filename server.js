/**
 * DLS ↔ Immomanagement – Kommunikationsportal
 * Express-Backend mit dateibasiertem JSON-Speicher (geteilt für alle Nutzer).
 *
 * Deployment-Hinweis: läuft wie das Immomanagement-Programm via `node server.js`
 * bzw. unter pm2 (`pm2 start server.js --name dls-portal`).
 */

const express = require('express');
const crypto = require('crypto');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3300;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LAST_GOOD_FILE = path.join(DATA_DIR, 'db.last-good.json');
const WRITE_LOCK_FILE = path.join(DATA_DIR, 'db.write.lock');
const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const BACKUP_RETENTION = Number(process.env.BACKUP_RETENTION || 60);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Fest auf Active-Directory-Anmeldung (wie die Dienstwagen-/Immomanagement-App).
// Über AUTH_MODE=local lässt sich für lokale Entwicklung weiterhin umschalten.
const AUTH_MODE = process.env.AUTH_MODE || 'ad';
const requestContext = new AsyncLocalStorage();

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(session({
  name: 'dls.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SESSION_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use((req, _res, next) => requestContext.run({ req }, next));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' } });
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));
app.use('/uploads', express.static(UPLOADS_DIR));

// ───────────────────────────────────────────────────────────────────────────
//  BCW-Verzeichnis (Active Directory / LDAP) – optionale Personensuche
// ───────────────────────────────────────────────────────────────────────────
// Aktiv, sobald die Umgebungsvariablen gesetzt sind. Die Suche bindet mit einem
// dedizierten, lesenden Service-Account ans AD und liefert Treffer für die
// Benutzeranlage. Ohne Konfiguration bleibt die manuelle Anlage unverändert.
const AD_URL = process.env.AD_URL || 'ldaps://bcw-intern.local:636';
const AD_SUFFIX = process.env.AD_SUFFIX || 'dc=bcw-intern,dc=local';
const AD_DOMAIN = process.env.AD_DOMAIN || 'bcw-intern.local';
const AD_BIND_USER = process.env.AD_BIND_USER || ''; // z.B. svc-dlsportal
const AD_BIND_PASS = process.env.AD_BIND_PASS || '';
// Der Domaincontroller lehnt unverschlüsselte Simple-Binds (Port 389) ab
// (LDAP-Signing/Channel-Binding). Daher LDAPS. Das interne CA-Zertifikat ist
// Node nicht bekannt, deshalb im internen Netz keine Zertifikatsprüfung –
// per AD_TLS_REJECT_UNAUTHORIZED=true erzwingbar, wenn die Root-CA hinterlegt ist.
const AD_TLS_REJECT_UNAUTHORIZED = process.env.AD_TLS_REJECT_UNAUTHORIZED === 'true';
const AD_SERVICE_ENABLED = !!(AD_URL && AD_BIND_USER && AD_BIND_PASS);
const AD_LOGIN_ENABLED = AUTH_MODE === 'ad' && !!AD_URL;
// Fester Erst-Admin (wie in der Dienstwagen-App): dieses AD-Konto erhält beim
// Start garantiert Superadmin-Zugang, damit nach der AD-Umstellung niemand
// ausgesperrt wird. Über DLS_INITIAL_ADMIN überschreibbar.
const INITIAL_ADMIN = (process.env.DLS_INITIAL_ADMIN || 'moritz.moser').trim().toLowerCase();

let LdapClient = null;
if (AD_URL) {
  try {
    ({ Client: LdapClient } = require('ldapts'));
  } catch (e) {
    console.warn('ldapts nicht verfügbar – BCW-Anmeldung/Suche deaktiviert:', e.message);
  }
}

function escapeLdapFilter(value) {
  return String(value || '').replace(/[\\*()\u0000]/g, (c) =>
    '\\' + c.charCodeAt(0).toString(16).padStart(2, '0')
  );
}

// Sucht Personen im AD (Service-Account-Bind). Liefert max. 15 Treffer.
async function ldapSearch(query) {
  if (!AD_SERVICE_ENABLED || !LdapClient) throw new Error('BCW-Verzeichnis ist nicht konfiguriert');
  const q = String(query || '').trim();
  const safe = escapeLdapFilter(q);
  const filter = q.includes('.')
    ? `(|(sAMAccountName=${safe})(mail=${safe}*)(displayName=*${safe}*))`
    : `(|(sAMAccountName=*${safe}*)(displayName=*${safe}*)(givenName=*${safe}*)(sn=*${safe}*))`;
  const client = new LdapClient({
    url: AD_URL,
    connectTimeout: 5000,
    timeout: 8000,
    tlsOptions: { rejectUnauthorized: AD_TLS_REJECT_UNAUTHORIZED },
  });
  try {
    await client.bind(`${AD_BIND_USER}@${AD_DOMAIN}`, AD_BIND_PASS);
    const { searchEntries } = await client.search(AD_SUFFIX, {
      scope: 'sub',
      filter,
      sizeLimit: 15,
      attributes: ['sAMAccountName', 'displayName', 'givenName', 'sn', 'mail', 'department', 'title'],
    });
    return searchEntries
      .filter((e) => e.sAMAccountName)
      .map((e) => ({
        sAMAccountName: String(e.sAMAccountName || ''),
        displayName: String(e.displayName || ''),
        givenName: String(e.givenName || ''),
        sn: String(e.sn || ''),
        mail: String(e.mail || ''),
        department: String(e.department || ''),
        title: String(e.title || ''),
      }));
  } finally {
    try {
      await client.unbind();
    } catch (_) {
      /* ignorieren */
    }
  }
}

async function ldapAuthenticate(username, password) {
  if (!AD_LOGIN_ENABLED || !LdapClient) throw new Error('AD-Anmeldung ist nicht konfiguriert');
  const login = String(username || '').trim().replace(/^.*\\/, '').replace(/@.*$/, '');
  if (!login || !password) throw new Error('Benutzername und Passwort erforderlich');
  const client = new LdapClient({
    url: AD_URL,
    connectTimeout: 5000,
    timeout: 8000,
    tlsOptions: { rejectUnauthorized: AD_TLS_REJECT_UNAUTHORIZED },
  });
  try {
    await client.bind(`${login}@${AD_DOMAIN}`, password);
    const { searchEntries } = await client.search(AD_SUFFIX, {
      scope: 'sub',
      filter: `(sAMAccountName=${escapeLdapFilter(login)})`,
      sizeLimit: 1,
      attributes: ['sAMAccountName', 'displayName', 'givenName', 'sn', 'mail', 'department', 'title'],
    });
    const e = searchEntries[0] || {};
    return {
      sAMAccountName: String(e.sAMAccountName || login).toLowerCase(),
      displayName: String(e.displayName || login),
      givenName: String(e.givenName || ''),
      sn: String(e.sn || ''),
      mail: String(e.mail || ''),
      department: String(e.department || ''),
      title: String(e.title || ''),
    };
  } finally {
    try {
      await client.unbind();
    } catch (_) {
      /* ignorieren */
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Persistenz
// ───────────────────────────────────────────────────────────────────────────
// Standard-Kanäle für das Kommunikationstool (Teams-artige Themen-Kanäle).
const DEFAULT_KANAELE = [
  { id: 'kan_allg', name: 'Allgemein', icon: '💬', beschreibung: 'Allgemeiner Austausch', system: true },
  { id: 'kan_stoerung', name: 'Störungen & Dringend', icon: '🚨', beschreibung: 'Akute Probleme & Eskalationen', system: true },
  { id: 'kan_klima', name: 'Klima & Technik', icon: '❄️', beschreibung: 'Klima, Technik, Medientechnik', system: true },
  { id: 'kan_orga', name: 'Organisation', icon: '🗂️', beschreibung: 'Termine, Abstimmungen, Orga', system: true },
];

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const seed = fs.existsSync(SEED_FILE)
      ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
      : { studios: [], infrastruktur: [], nachrichten: [], tools: [], auditLog: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  }
  // Kleine Migrationen für bestehende JSON-Datenbanken.
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let changed = false;
    if (!Array.isArray(db.kanaele) || db.kanaele.length === 0) {
      db.kanaele = DEFAULT_KANAELE.slice();
      changed = true;
    }
    if (!Array.isArray(db.auditLog)) {
      db.auditLog = [];
      changed = true;
    }
    if (!Array.isArray(db.backups)) {
      db.backups = [];
      changed = true;
    }
    // Erst-Admin im AD-Modus garantieren: keiner darf nach der Umstellung
    // ausgesperrt sein. Vorhandenem Superadmin ohne adUser wird der
    // INITIAL_ADMIN zugeordnet; sonst ein neuer Superadmin angelegt.
    if (AUTH_MODE === 'ad' && INITIAL_ADMIN) {
      const users = Array.isArray(db.users) ? db.users : (db.users = []);
      const mapped = users.find((u) => (u.adUser || '').trim().toLowerCase() === INITIAL_ADMIN);
      if (!mapped) {
        const superNoAd = users.find((u) => u.superadmin && !(u.adUser || '').trim());
        if (superNoAd) {
          superNoAd.adUser = INITIAL_ADMIN;
          superNoAd.aktiv = true;
          changed = true;
        } else {
          users.push({
            id: 'usr_' + crypto.randomBytes(6).toString('hex'),
            vorname: INITIAL_ADMIN.split('.')[0] ? INITIAL_ADMIN.split('.')[0].replace(/^./, (c) => c.toUpperCase()) : INITIAL_ADMIN,
            nachname: INITIAL_ADMIN.split('.')[1] ? INITIAL_ADMIN.split('.')[1].replace(/^./, (c) => c.toUpperCase()) : '',
            team: 'immo',
            email: '',
            adUser: INITIAL_ADMIN,
            abteilung: '',
            superadmin: true,
            aktiv: true,
            letzterLogin: '',
          });
          changed = true;
        }
      } else if (mapped.aktiv === false || !mapped.superadmin) {
        mapped.aktiv = true;
        mapped.superadmin = true;
        changed = true;
      }
    }
    if (changed) {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    }
  } catch (_) {
    /* ignorieren */
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireWriteLock() {
  ensureDb();
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try {
      const fd = fs.openSync(WRITE_LOCK_FILE, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      return fd;
    } catch (e) {
      try {
        const age = Date.now() - fs.statSync(WRITE_LOCK_FILE).mtimeMs;
        if (age > 30000) fs.unlinkSync(WRITE_LOCK_FILE);
      } catch (_) {
        /* ignorieren */
      }
      sleepMs(25);
    }
  }
  throw new Error('Datenbank ist gerade gesperrt. Bitte erneut versuchen.');
}

function releaseWriteLock(fd) {
  try { fs.closeSync(fd); } catch (_) { /* ignorieren */ }
  try { fs.unlinkSync(WRITE_LOCK_FILE); } catch (_) { /* ignorieren */ }
}

function isWriteRequest(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
}

function attachRequestWriteLock(req, res) {
  if (!isWriteRequest(req) || req.writeLockFd) return true;
  try {
    req.writeLockFd = acquireWriteLock();
    res.once('finish', () => {
      if (!req.writeLockFd) return;
      releaseWriteLock(req.writeLockFd);
      req.writeLockFd = null;
    });
    return true;
  } catch (e) {
    res.status(503).json({ error: e.message });
    return false;
  }
}

function actorFromRequest(req, db) {
  const sessionUser = req && req.session && req.session.user;
  if (sessionUser && sessionUser.id) return sessionUser;
  return null;
}

function auditAction(req) {
  if (!req || !req.path.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return null;
  if (/^\/api\/(health|state|bootstrap|me)$/.test(req.path)) return null;
  if (req.path === '/api/login') return 'LOGIN';
  if (req.path === '/api/login-local') return 'LOGIN_LOCAL';
  if (req.path === '/api/logout') return 'LOGOUT';
  if (req.path === '/api/backups') return req.method === 'POST' ? 'BACKUP_MANUELL' : null;
  const parts = req.path.split('/').filter(Boolean);
  const resource = (parts[1] || 'api').toUpperCase();
  const methodMap = { POST: 'ANGELEGT', PUT: 'GEAENDERT', PATCH: 'GEAENDERT', DELETE: 'GELOESCHT' };
  return `${resource}_${methodMap[req.method] || req.method}`;
}

function appendAuditEntry(db) {
  const ctx = requestContext.getStore();
  const req = ctx && ctx.req;
  const action = auditAction(req);
  if (!action) return;
  const actor = actorFromRequest(req, db);
  db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
  db.auditLog.push({
    id: uid('aud'),
    zeit: nowIso(),
    aktion: action,
    pfad: req.path,
    methode: req.method,
    benutzerId: actor ? actor.id : '',
    benutzer: actor ? `${actor.vorname || ''} ${actor.nachname || ''}`.trim() : 'System/Bootstrap',
    team: actor ? actor.team : '',
    ip: req.ip || '',
  });
  if (db.auditLog.length > 2000) db.auditLog = db.auditLog.slice(-2000);
}

function writeDb(db) {
  const ctx = requestContext.getStore();
  const req = ctx && ctx.req;
  const fd = req && req.writeLockFd ? req.writeLockFd : acquireWriteLock();
  const ownsLock = !(req && req.writeLockFd);
  try {
    appendAuditEntry(db);
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, LAST_GOOD_FILE);
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } finally {
    if (ownsLock) releaseWriteLock(fd);
  }
}

function backupFileName(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `db_${stamp}_${reason.replace(/[^a-z0-9_-]/gi, '_')}.json`;
}

function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^db_.*\.json$/.test(f))
    .map((name) => ({ name, path: path.join(BACKUP_DIR, name), mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(BACKUP_RETENTION).forEach((f) => {
    try { fs.unlinkSync(f.path); } catch (_) { /* ignorieren */ }
  });
}

function createBackup(reason = 'scheduled') {
  ensureDb();
  const file = path.join(BACKUP_DIR, backupFileName(reason));
  fs.copyFileSync(DB_FILE, file);
  pruneBackups();
  return {
    name: path.basename(file),
    createdAt: nowIso(),
    bytes: fs.statSync(file).size,
    reason,
  };
}

function listBackups() {
  ensureDb();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^db_.*\.json$/.test(f))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
  if (AUTH_MODE === 'ad' && !(b.adUser || '').trim()) return 'AD-Benutzername ist erforderlich';
  if (b.superadmin && !SUPER_ALLOWED.includes(b.team))
    return 'Superadmin-Rechte sind nur für DLS oder Immobilienmanagement erlaubt';
  return null;
}

function getActor(db, req) {
  const sessionUser = req.session && req.session.user;
  const id = sessionUser && sessionUser.id ? sessionUser.id : '';
  if (!id) return null;
  return (db.users || []).find((u) => u.id === id) || null;
}

function countActiveSuperadmins(users, exceptId) {
  return (users || []).filter(
    (u) => u.superadmin && u.aktiv !== false && u.id !== exceptId
  ).length;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    vorname: u.vorname,
    nachname: u.nachname,
    team: u.team,
    email: u.email || '',
    adUser: u.adUser || '',
    abteilung: u.abteilung || '',
    superadmin: !!u.superadmin,
    aktiv: u.aktiv !== false,
    letzterLogin: u.letzterLogin || '',
  };
}

function setSessionUser(req, user) {
  req.session.user = publicUser(user);
}

function hasUsers(db) {
  return (db.users || []).length > 0;
}

function isPublicApi(req, db) {
  if (req.path === '/api/health') return true;
  if (req.path === '/api/bootstrap') return true;
  if (req.path === '/api/login' || req.path === '/api/login-local' || req.path === '/api/login-users' || req.path === '/api/logout' || req.path === '/api/me') return true;
  return !hasUsers(db) && req.method === 'POST' && req.path === '/api/users';
}

app.get('/api/bootstrap', (_req, res) => {
  const db = readDb();
  res.json({
    hasUsers: hasUsers(db),
    authMode: AUTH_MODE,
    adEnabled: AD_SERVICE_ENABLED,
    adLoginEnabled: AD_LOGIN_ENABLED && !!LdapClient,
  });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  if (AUTH_MODE !== 'ad') return res.status(400).json({ error: 'AD-Anmeldung ist auf diesem System nicht aktiviert.' });
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  try {
    const adUser = await ldapAuthenticate(username, password);
    if (!attachRequestWriteLock(req, res)) return;
    const db = readDb();
    const localUser = (db.users || []).find(
      (u) => (u.adUser || '').trim().toLowerCase() === adUser.sAMAccountName && u.aktiv !== false
    );
    if (!localUser) return res.status(403).json({ error: 'Kein Zugang. Dein AD-Konto ist für DLS-Immo nicht freigeschaltet.' });
    localUser.letzterLogin = nowIso();
    localUser.email = localUser.email || adUser.mail || '';
    localUser.abteilung = localUser.abteilung || adUser.department || '';
    setSessionUser(req, localUser);
    writeDb(db);
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    console.warn('AD-Anmeldung fehlgeschlagen:', e.message);
    res.status(401).json({ error: 'Anmeldung fehlgeschlagen. Benutzername oder Passwort falsch.' });
  }
});

app.post('/api/login-local', loginLimiter, (req, res) => {
  if (AUTH_MODE === 'ad') return res.status(400).json({ error: 'Lokale Anmeldung ist deaktiviert.' });
  if (!attachRequestWriteLock(req, res)) return;
  const db = readDb();
  const user = (db.users || []).find((u) => u.id === req.body.userId && u.aktiv !== false);
  if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden oder deaktiviert.' });
  user.letzterLogin = nowIso();
  setSessionUser(req, user);
  writeDb(db);
  res.json({ ok: true, user: req.session.user });
});

app.get('/api/login-users', (req, res) => {
  if (AUTH_MODE === 'ad') return res.status(404).json({ error: 'Lokale Anmeldung ist deaktiviert.' });
  const db = readDb();
  res.json((db.users || []).filter((u) => u.aktiv !== false).map(publicUser));
});

app.post('/api/logout', (req, res) => {
  try {
    if (!attachRequestWriteLock(req, res)) return;
    const db = readDb();
    writeDb(db);
  } catch (_) {
    /* Audit ist optional beim Logout */
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  const db = readDb();
  const user = getActor(db, req);
  if (!user || user.aktiv === false) return res.status(401).json({ error: 'Sitzung ungültig' });
  setSessionUser(req, user);
  res.json(req.session.user);
});

// Zentrale Berechtigungsprüfung für alle schreibenden API-Zugriffe.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const sub = req.path.slice(4); // Pfad ohne führendes "/api"
  const db = readDb();
  const users = db.users || [];

  if (isPublicApi(req, db)) {
    if (!attachRequestWriteLock(req, res)) return;
    return next();
  }

  // Bootstrap: Solange kein Benutzer existiert, darf der erste (Super-)Admin angelegt werden.
  if (users.length === 0 && req.method === 'POST' && sub === '/users') return next();

  const actor = getActor(db, req);
  if (!actor) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
  if (actor.aktiv === false) return res.status(403).json({ error: 'Dieser Benutzer ist deaktiviert.' });

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  // Benutzerverwaltung nur für Superadmins.
  if (sub === '/users' || sub.startsWith('/users/')) {
    if (!actor.superadmin)
      return res.status(403).json({ error: 'Nur Superadmins dürfen Benutzer verwalten.' });
    if (!attachRequestWriteLock(req, res)) return;
    return next();
  }

  // Superadmins dürfen alles Übrige.
  if (actor.superadmin) {
    if (!attachRequestWriteLock(req, res)) return;
    return next();
  }

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
    if (!attachRequestWriteLock(req, res)) return;
    return next();
  }

  // Reguläre Team-Mitglieder (DLS/IT/Medien/Immo): voller operativer Zugriff.
  if (!attachRequestWriteLock(req, res)) return;
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
  const bootstrap = db.users.length === 0;
  const dup = db.users.find(
    (u) =>
      u.vorname.trim().toLowerCase() === req.body.vorname.trim().toLowerCase() &&
      u.nachname.trim().toLowerCase() === req.body.nachname.trim().toLowerCase()
  );
  if (dup) return res.status(400).json({ error: 'Benutzer mit diesem Namen existiert bereits.' });
  const adUser = (req.body.adUser || '').trim().toLowerCase();
  if (adUser && db.users.some((u) => (u.adUser || '').trim().toLowerCase() === adUser))
    return res.status(400).json({ error: 'Dieser AD-Benutzer ist bereits zugeordnet.' });
  const user = {
    id: uid('usr'),
    vorname: req.body.vorname.trim(),
    nachname: req.body.nachname.trim(),
    team: req.body.team,
    email: (req.body.email || '').trim(),
    adUser,
    abteilung: (req.body.abteilung || '').trim(),
    superadmin: !!req.body.superadmin && SUPER_ALLOWED.includes(req.body.team),
    aktiv: req.body.aktiv !== false,
    erstelltAm: nowIso(),
    geaendertAm: nowIso(),
  };
  db.users.push(user);
  if (bootstrap) setSessionUser(req, user);
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
  const adUser = (merged.adUser || '').trim().toLowerCase();
  if (adUser && list.some((u) => u.id !== req.params.id && (u.adUser || '').trim().toLowerCase() === adUser))
    return res.status(400).json({ error: 'Dieser AD-Benutzer ist bereits zugeordnet.' });
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
    email: (merged.email || '').trim(),
    adUser,
    abteilung: (merged.abteilung || '').trim(),
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

// ─── Kommunikation: Helfer ──────────────────────────────────────────────────
const QUICK_EMOJIS = ['👍', '❤️', '✅', '🙏', '👀', '🎉', '😮'];
function findNachricht(db, id) {
  return (db.nachrichten || []).find((n) => n.id === id);
}
function actorName(actor) {
  return actor ? `${actor.vorname} ${actor.nachname}`.trim() : 'System';
}
// Speichert einen Nachrichten-Anhang (Bild oder PDF) auf der Platte.
function saveDataUrlFile(dataUrl) {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const allowed = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  };
  const ext = allowed[mime];
  if (!ext) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 12 * 1024 * 1024) return null; // 12 MB Limit
  const fname = uid('anh') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, fname), buf);
  return { fname, mime, ext };
}

// Eigene/gelöschte Nachrichten: geschützter DELETE vor dem generischen CRUD.
app.delete('/api/nachrichten/:id', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const actor = getActor(db, req);
  if (n.autorId && actor && n.autorId !== actor.id && !actor.superadmin)
    return res.status(403).json({ error: 'Nur der Verfasser darf die Nachricht löschen.' });
  const replies = (db.nachrichten || []).filter((r) => r.parentId === n.id);
  (n.anhaenge || []).forEach((a) => deleteUploadFile(a.datei));
  replies.forEach((r) => (r.anhaenge || []).forEach((a) => deleteUploadFile(a.datei)));
  db.nachrichten = (db.nachrichten || []).filter((r) => r.id !== n.id && r.parentId !== n.id);
  writeDb(db);
  res.json({ ok: true });
});

app.use(
  '/api/nachrichten',
  makeCrud('nachrichten', {
    idPrefix: 'msg',
    validate: (b) => (!b.text ? 'Text ist erforderlich' : null),
  })
);

// Themen-Kanäle des Kommunikationstools.
// Geschütztes Löschen: System-Kanäle bleiben bestehen, Nachrichten wandern nach kan_allg.
app.delete('/api/kanaele/:id', (req, res) => {
  const db = readDb();
  db.kanaele = db.kanaele || [];
  const kanal = db.kanaele.find((k) => k.id === req.params.id);
  if (!kanal) return res.status(404).json({ error: 'Kanal nicht gefunden' });
  if (kanal.system) return res.status(400).json({ error: 'System-Kanäle können nicht gelöscht werden' });
  (db.nachrichten || []).forEach((n) => {
    if (n.kanalId === kanal.id) n.kanalId = 'kan_allg';
  });
  db.kanaele = db.kanaele.filter((k) => k.id !== kanal.id);
  writeDb(db);
  res.json({ ok: true });
});

app.use(
  '/api/kanaele',
  makeCrud('kanaele', {
    idPrefix: 'kan',
    validate: (b) => (!b.name ? 'Name ist erforderlich' : null),
  })
);

// Reaktion (Emoji) togglen.
app.post('/api/nachrichten/:id/reaktion', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const emoji = (req.body.emoji || '').trim();
  if (!QUICK_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Ungültige Reaktion' });
  const actor = getActor(db, req);
  n.reaktionen = n.reaktionen || [];
  const i = n.reaktionen.findIndex((r) => r.emoji === emoji && r.userId === actor.id);
  if (i >= 0) n.reaktionen.splice(i, 1);
  else n.reaktionen.push({ emoji, userId: actor.id, name: actorName(actor) });
  n.geaendertAm = nowIso();
  writeDb(db);
  res.json(n);
});

// Anhang (Bild/PDF) hinzufügen.
app.post('/api/nachrichten/:id/anhaenge', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const saved = saveDataUrlFile(req.body.dataUrl);
  if (!saved)
    return res
      .status(400)
      .json({ error: 'Ungültige oder zu große Datei (erlaubt: Bilder/PDF, max 12 MB)' });
  n.anhaenge = n.anhaenge || [];
  const att = {
    id: uid('anh'),
    name: (req.body.name || saved.fname).toString().slice(0, 120),
    datei: saved.fname,
    mime: saved.mime,
    hochgeladenAm: nowIso(),
  };
  n.anhaenge.push(att);
  n.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(att);
});

// Anhang löschen.
app.delete('/api/nachrichten/:id/anhaenge/:aid', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const list = n.anhaenge || [];
  const idx = list.findIndex((a) => a.id === req.params.aid);
  if (idx === -1) return res.status(404).json({ error: 'Anhang nicht gefunden' });
  deleteUploadFile(list[idx].datei);
  list.splice(idx, 1);
  n.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true });
});

// Als erledigt/gelöst markieren.
app.post('/api/nachrichten/:id/erledigt', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const actor = getActor(db, req);
  const done = !!req.body.erledigt;
  n.erledigt = done;
  n.erledigtVon = done ? actorName(actor) : null;
  n.erledigtAm = done ? nowIso() : null;
  n.geaendertAm = nowIso();
  writeDb(db);
  res.json(n);
});

// Anpinnen / lösen.
app.post('/api/nachrichten/:id/pin', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  n.angepinnt = !!req.body.angepinnt;
  n.geaendertAm = nowIso();
  writeDb(db);
  res.json(n);
});

// Eigenen Nachrichtentext bearbeiten.
app.put('/api/nachrichten/:id/text', (req, res) => {
  const db = readDb();
  const n = findNachricht(db, req.params.id);
  if (!n) return res.status(404).json({ error: 'Nicht gefunden' });
  const actor = getActor(db, req);
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text ist erforderlich' });
  if (n.autorId && actor && n.autorId !== actor.id && !actor.superadmin)
    return res.status(403).json({ error: 'Nur der Verfasser darf die Nachricht bearbeiten.' });
  n.text = text;
  if (Array.isArray(req.body.mentions)) n.mentions = req.body.mentions;
  n.bearbeitetAm = nowIso();
  n.geaendertAm = nowIso();
  writeDb(db);
  res.json(n);
});

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
//  Vorgänge (Kaskaden) – mehrstufige Abläufe mit Schritten und Rückfragen
// ───────────────────────────────────────────────────────────────────────────
const VORGANG_STATUS = ['offen', 'laufend', 'wartet', 'abgeschlossen', 'abgebrochen'];
const SCHRITT_STATUS = ['offen', 'aktiv', 'erledigt', 'uebersprungen'];

app.use(
  '/api/vorgaenge',
  makeCrud('vorgaenge', {
    idPrefix: 'vor',
    validate: (b) => (!b.titel ? 'Titel ist erforderlich' : null),
  })
);

function findVorgang(db, id) {
  return (db.vorgaenge || []).find((v) => v.id === id);
}

// Schritte (die Kaskade) ─────────────────────────────────────────────────────
app.post('/api/vorgaenge/:id/schritte', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const titel = (req.body.titel || '').trim();
  if (!titel) return res.status(400).json({ error: 'Titel ist erforderlich' });
  const schritt = {
    id: uid('schr'),
    titel,
    notiz: (req.body.notiz || '').trim(),
    status: SCHRITT_STATUS.includes(req.body.status) ? req.body.status : 'offen',
    zustaendig: (req.body.zustaendig || '').trim(),
    faelligBis: (req.body.faelligBis || '').trim(),
    erledigtAm: null,
    erstelltAm: nowIso(),
    geaendertAm: nowIso(),
  };
  v.schritte = v.schritte || [];
  v.schritte.push(schritt);
  v.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(schritt);
});

app.put('/api/vorgaenge/:id/schritte/:sid', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const list = v.schritte || [];
  const idx = list.findIndex((s) => s.id === req.params.sid);
  if (idx === -1) return res.status(404).json({ error: 'Schritt nicht gefunden' });
  const next = { ...list[idx] };
  if (req.body.titel !== undefined) {
    const t = (req.body.titel || '').trim();
    if (!t) return res.status(400).json({ error: 'Titel ist erforderlich' });
    next.titel = t;
  }
  if (req.body.notiz !== undefined) next.notiz = (req.body.notiz || '').trim();
  if (req.body.zustaendig !== undefined) next.zustaendig = (req.body.zustaendig || '').trim();
  if (req.body.faelligBis !== undefined) next.faelligBis = (req.body.faelligBis || '').trim();
  if (req.body.status !== undefined && SCHRITT_STATUS.includes(req.body.status)) {
    next.status = req.body.status;
    next.erledigtAm = req.body.status === 'erledigt' ? nowIso() : null;
  }
  next.geaendertAm = nowIso();
  list[idx] = next;
  v.geaendertAm = nowIso();
  writeDb(db);
  res.json(next);
});

// Schritte umsortieren (komplette Reihenfolge per ID-Liste).
app.put('/api/vorgaenge/:id/schritte-sortieren', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const order = Array.isArray(req.body.reihenfolge) ? req.body.reihenfolge : [];
  const list = v.schritte || [];
  v.schritte = order.map((sid) => list.find((s) => s.id === sid)).filter(Boolean)
    .concat(list.filter((s) => !order.includes(s.id)));
  v.geaendertAm = nowIso();
  writeDb(db);
  res.json(v.schritte);
});

app.delete('/api/vorgaenge/:id/schritte/:sid', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const list = v.schritte || [];
  const idx = list.findIndex((s) => s.id === req.params.sid);
  if (idx === -1) return res.status(404).json({ error: 'Schritt nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  v.geaendertAm = nowIso();
  writeDb(db);
  res.json({ ok: true, removed });
});

// Rückfragen zum Vorgang ─────────────────────────────────────────────────────
app.post('/api/vorgaenge/:id/fragen', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Frage ist erforderlich' });
  const frage = {
    id: uid('frg'),
    text,
    autor: (req.body.autor || '').trim(),
    team: (req.body.team || '').trim(),
    antwort: '',
    beantwortetVon: '',
    beantwortetAm: null,
    erstelltAm: nowIso(),
  };
  v.fragen = v.fragen || [];
  v.fragen.push(frage);
  v.geaendertAm = nowIso();
  writeDb(db);
  res.status(201).json(frage);
});

app.put('/api/vorgaenge/:id/fragen/:fid', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const list = v.fragen || [];
  const idx = list.findIndex((f) => f.id === req.params.fid);
  if (idx === -1) return res.status(404).json({ error: 'Frage nicht gefunden' });
  const next = { ...list[idx] };
  if (req.body.antwort !== undefined) {
    next.antwort = (req.body.antwort || '').trim();
    next.beantwortetVon = (req.body.beantwortetVon || '').trim();
    next.beantwortetAm = next.antwort ? nowIso() : null;
  }
  if (req.body.text !== undefined) {
    const t = (req.body.text || '').trim();
    if (!t) return res.status(400).json({ error: 'Frage ist erforderlich' });
    next.text = t;
  }
  list[idx] = next;
  v.geaendertAm = nowIso();
  writeDb(db);
  res.json(next);
});

app.delete('/api/vorgaenge/:id/fragen/:fid', (req, res) => {
  const db = readDb();
  const v = findVorgang(db, req.params.id);
  if (!v) return res.status(404).json({ error: 'Vorgang nicht gefunden' });
  const list = v.fragen || [];
  const idx = list.findIndex((f) => f.id === req.params.fid);
  if (idx === -1) return res.status(404).json({ error: 'Frage nicht gefunden' });
  const [removed] = list.splice(idx, 1);
  v.geaendertAm = nowIso();
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
  const columns = Object.keys(data[0] || { Hinweis: 'Keine Einträge' });
  const csvEscape = (value) => {
    let str = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
  };
  const csvRows = [
    columns.map(csvEscape).join(';'),
    ...(data.length ? data : [{ Hinweis: 'Keine Einträge' }]).map((row) =>
      columns.map((key) => csvEscape(row[key])).join(';')
    ),
  ];
  const buf = Buffer.from('\ufeff' + csvRows.join('\r\n'), 'utf8');
  const fname = `Maengelbericht_${standort || 'Alle'}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
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

function requireSuperadmin(req, res) {
  const db = readDb();
  const actor = getActor(db, req);
  if (!actor || actor.aktiv === false) {
    res.status(401).json({ error: 'Bitte anmelden.' });
    return null;
  }
  if (!actor.superadmin) {
    res.status(403).json({ error: 'Nur Superadmins dürfen diese Ansicht öffnen.' });
    return null;
  }
  return { db, actor };
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function makeSnippet(text, query) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const idx = normalizeSearchText(raw).indexOf(normalizeSearchText(query));
  const start = idx > 35 ? idx - 35 : 0;
  const snippet = raw.slice(start, start + 180);
  return (start ? '...' : '') + snippet + (start + 180 < raw.length ? '...' : '');
}

function searchDb(db, query) {
  const q = normalizeSearchText(query);
  const results = [];
  const studios = Object.fromEntries((db.studios || []).map((s) => [s.id, s]));
  const add = (type, title, text, meta, target) => {
    const hay = normalizeSearchText(`${title} ${text} ${meta || ''}`);
    if (!hay.includes(q)) return;
    results.push({
      type,
      title,
      snippet: makeSnippet(`${text} ${meta || ''}`, query),
      meta,
      target,
      score: hay.startsWith(q) ? 3 : title && normalizeSearchText(title).includes(q) ? 2 : 1,
    });
  };
  (db.studios || []).forEach((s) => add('Studio', s.name, `${s.standort || ''} ${s.adresse || ''} ${s.notizen || ''}`, s.standort || '', { view: 'studios', id: s.id }));
  (db.infrastruktur || []).forEach((i) => {
    const s = studios[i.studioId];
    add('Mangel', i.titel, `${i.beschreibung || ''} ${i.benoetigt || ''} ${i.vorhandeneGeraete || ''} ${(i.kommentare || []).map((k) => k.text).join(' ')}`, s ? `${s.standort || ''} · ${s.name || ''}` : '', { view: 'infrastruktur', id: i.id, studioId: i.studioId });
  });
  (db.nachrichten || []).forEach((n) => add('Nachricht', n.text || 'Nachricht', `${n.autor || ''} ${n.team || ''}`, n.kanalId || '', { view: 'kommunikation', id: n.id, kanalId: n.kanalId }));
  (db.vorgaenge || []).forEach((v) => add('Vorgang', v.titel, `${v.beschreibung || ''} ${(v.schritte || []).map((s) => s.titel + ' ' + (s.notiz || '')).join(' ')} ${(v.fragen || []).map((f) => f.text + ' ' + (f.antwort || '')).join(' ')}`, v.kategorie || '', { view: 'vorgaenge', id: v.id }));
  (db.tools || []).forEach((t) => add('Tool', t.name, `${t.beschreibung || ''} ${(t.eintraege || []).map((e) => e.titel + ' ' + (e.notiz || '')).join(' ')}`, t.aktiv ? 'aktiv' : 'inaktiv', { view: 'tools', id: t.id }));
  results.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type, 'de'));
  const counts = results.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {});
  const answer = results.length
    ? `Ich habe ${results.length} Treffer gefunden. Am stärksten vertreten: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ')}.`
    : 'Ich habe dazu noch keinen passenden Treffer gefunden.';
  return { query, answer, counts, results: results.slice(0, 60) };
}

app.get('/api/search', (req, res) => {
  const db = readDb();
  const actor = getActor(db, req);
  if (!actor || actor.aktiv === false) return res.status(401).json({ error: 'Bitte anmelden.' });
  if (actor.team === 'standort') return res.status(403).json({ error: 'Die Suche ist nur für Team-Mitglieder verfügbar.' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, answer: 'Gib mindestens zwei Zeichen ein.', counts: {}, results: [] });
  res.json(searchDb(db, q));
});

app.get('/api/audit', (req, res) => {
  const ctx = requireSuperadmin(req, res);
  if (!ctx) return;
  const q = normalizeSearchText(req.query.q || '');
  const limit = Math.min(Number(req.query.limit || 200), 500);
  let rows = (ctx.db.auditLog || []).slice().reverse();
  if (q) rows = rows.filter((r) => normalizeSearchText(`${r.aktion} ${r.benutzer} ${r.team} ${r.pfad} ${r.ip}`).includes(q));
  res.json(rows.slice(0, limit));
});

app.get('/api/backups', (req, res) => {
  const ctx = requireSuperadmin(req, res);
  if (!ctx) return;
  res.json(listBackups());
});

app.post('/api/backups', (req, res) => {
  const ctx = requireSuperadmin(req, res);
  if (!ctx) return;
  const backup = createBackup('manual');
  ctx.db.auditLog = ctx.db.auditLog || [];
  ctx.db.auditLog.push({ id: uid('aud'), zeit: nowIso(), aktion: 'BACKUP_MANUELL', pfad: '/api/backups', methode: 'POST', benutzerId: ctx.actor.id, benutzer: `${ctx.actor.vorname} ${ctx.actor.nachname}`.trim(), team: ctx.actor.team, ip: req.ip || '', details: backup.name });
  writeDb(ctx.db);
  res.status(201).json(backup);
});

// Gesamter Zustand auf einen Schlag (für initiales Laden des Frontends).
app.get('/api/state', (req, res) => {
  res.json({ ...readDb(), me: req.session ? req.session.user || null : null, adEnabled: AD_SERVICE_ENABLED, adLoginEnabled: AD_LOGIN_ENABLED && !!LdapClient, authMode: AUTH_MODE });
});

// BCW-Verzeichnissuche (nur Superadmins; GET umgeht die Schreib-Middleware).
app.get('/api/ad/search', async (req, res) => {
  const db = readDb();
  const actor = getActor(db, req);
  if (!actor || actor.aktiv === false) return res.status(401).json({ error: 'Bitte anmelden.' });
  if (!actor.superadmin)
    return res.status(403).json({ error: 'Nur Superadmins dürfen das BCW-Verzeichnis durchsuchen.' });
  if (!AD_SERVICE_ENABLED) return res.status(503).json({ error: 'BCW-Verzeichnis (AD) ist nicht konfiguriert.' });
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.status(400).json({ error: 'Bitte mindestens 2 Zeichen eingeben.' });
  try {
    res.json(await ldapSearch(q));
  } catch (e) {
    console.error('BCW-Suche fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'BCW-Suche fehlgeschlagen: ' + e.message });
  }
});

// Health-Check.
app.get('/api/health', (req, res) => res.json({ ok: true, time: nowIso() }));

// SPA-Fallback.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function newestBackupAgeMs() {
  const backups = listBackups();
  if (!backups.length) return Infinity;
  return Date.now() - new Date(backups[0].createdAt).getTime();
}

function scheduleBackups() {
  try {
    if (newestBackupAgeMs() >= BACKUP_INTERVAL_MS) {
      const b = createBackup('startup');
      console.log(`Backup erstellt: ${b.name}`);
    }
  } catch (e) {
    console.warn('Startup-Backup fehlgeschlagen:', e.message);
  }
  const timer = setInterval(() => {
    try {
      const b = createBackup('scheduled');
      console.log(`Backup erstellt: ${b.name}`);
    } catch (e) {
      console.warn('Geplantes Backup fehlgeschlagen:', e.message);
    }
  }, BACKUP_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

ensureDb();
scheduleBackups();
app.listen(PORT, () => {
  console.log(`DLS ↔ Immo-Portal läuft auf http://localhost:${PORT}`);
});
