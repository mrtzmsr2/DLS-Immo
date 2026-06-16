/**
 * Import: Klimatisierungs-Erhebung (Excel) → db.json
 * Erzeugt Studios (je Studio-Raum) + Infrastruktur-Einträge (Kategorie "Klima").
 *
 * Aufruf:  node scripts/import-klima.js "Pfad\\zur\\Datei.xlsx"
 * Standardpfad siehe unten.
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const XLSX_PATH =
  process.argv[2] ||
  'D:/Users/moritz.moser/Desktop/Klimatisierung_Lehrstudios_Erhebung Mai26_V2.xlsx';
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
function lc(s) {
  return clean(s).toLowerCase();
}
function uid(prefix, i) {
  return `${prefix}_${String(i).padStart(3, '0')}`;
}

// Kürzel der Stadt aus dem Studio-Code (z.B. "AC/PUS1" -> "AC").
function codeOf(name) {
  const m = String(name).split('/')[0];
  return m ? m.trim() : '';
}

function normBedarf(raw) {
  const t = clean(raw);
  if (!t) return '';
  if (/^nein$/i.test(t)) return '';
  return t;
}

function deriveStatus({ hitze, vorhanden, anmerk, bedarfRaw }) {
  const text = `${lc(vorhanden)} ${lc(anmerk)} ${lc(bedarfRaw)}`;
  const kritisch = ['nicht ausreichend', 'nicht nutzbar', 'zu kurz', 'dringend'];
  const provis = ['abdichtung', 'schlauch', 'klettband', 'ductape', 'klebeband', 'greenscreen', 'geöffnetem fenster', 'nicht kompatibel', 'aufsatz'];
  const bedarf = normBedarf(bedarfRaw);
  if (kritisch.some((k) => text.includes(k))) return 'kritisch';
  const hasDevice = /klimagerät|ventilator|klimaanlage/.test(lc(vorhanden));
  if (hitze && hasDevice && provis.some((p) => text.includes(p))) return 'provisorisch';
  if (hitze && (bedarf || /bitte kontakt/i.test(bedarfRaw))) return 'handlungsbedarf';
  if (hitze) return 'handlungsbedarf';
  return 'ok';
}

function deriveAusreichend(status, bedarfRaw) {
  const bedarf = normBedarf(bedarfRaw);
  if (status === 'kritisch') return 'nein';
  if (status === 'provisorisch') return 'ja_vorerst';
  if (bedarf) return 'nein';
  return 'ja';
}

function run() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error('Datei nicht gefunden:', XLSX_PATH);
    process.exit(1);
  }
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const studios = [];
  const infrastruktur = [];
  let lastStadt = '';
  let sIdx = 0;
  let iIdx = 0;
  const nowIso = '2026-06-16T12:00:00.000Z';

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const stadtRaw = clean(row[0]);
    const name = clean(row[1]);
    if (!name) continue; // keine Studio-Zeile
    const stadt = stadtRaw || lastStadt;
    if (stadtRaw) lastStadt = stadtRaw;

    const festeKlima = clean(row[2]); // Ja/Nein
    const hitzeRaw = clean(row[3]);
    const hitze = /^ja/i.test(hitzeRaw);
    const grund = clean(row[4]);
    const person = clean(row[5]);
    const anmerk = clean(row[6]);
    const vorhanden = clean(row[7]);
    const bedarfRaw = clean(row[8]);
    const bearbeitung = clean(row[9]);

    const studioId = uid('std', ++sIdx);
    studios.push({
      id: studioId,
      name,
      standort: stadt,
      adresse: '',
      status: 'aktiv',
      eroeffnung: '',
      verantwortlichImmo: '',
      verantwortlichDls: person,
      festeKlima,
      notizen: '',
      erstelltAm: nowIso,
      geaendertAm: nowIso,
    });

    // Infrastruktur-Eintrag (Klima) nur, wenn es etwas zu kommunizieren gibt.
    const bedarf = normBedarf(bedarfRaw);
    const relevant = hitze || bedarf || vorhanden || anmerk;
    if (!relevant) continue;

    const status = deriveStatus({ hitze, vorhanden, anmerk, bedarfRaw });
    const ausreichend = deriveAusreichend(status, bedarfRaw);
    const beschreibungParts = [];
    if (grund) beschreibungParts.push(grund);
    if (anmerk) beschreibungParts.push(anmerk);

    infrastruktur.push({
      id: uid('inf', ++iIdx),
      studioId,
      kategorie: 'Klima',
      titel: 'Klimatisierung / Hitzeschutz',
      beschreibung: beschreibungParts.join('\n'),
      status,
      ausreichend,
      hitzekritisch: hitze ? 'ja' : 'nein',
      festeKlima,
      vorhandeneGeraete: vorhanden,
      benoetigt: bedarf,
      bearbeitungsstand: bearbeitung,
      erstelltVon: person ? `DLS – ${person}` : 'Import Erhebung Mai 26',
      erstelltAm: nowIso,
      geaendertAm: nowIso,
    });
  }

  // Tools-Registry erhalten, falls db schon existiert.
  let tools = [];
  let nachrichten = [];
  if (fs.existsSync(DB_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      tools = old.tools || [];
      nachrichten = old.nachrichten || [];
    } catch (_) {}
  }

  const db = { studios, infrastruktur, nachrichten, tools };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

  // Kurze Zusammenfassung.
  const byStatus = infrastruktur.reduce((a, i) => ((a[i.status] = (a[i.status] || 0) + 1), a), {});
  const staedte = [...new Set(studios.map((s) => s.standort))];
  console.log('Import abgeschlossen:');
  console.log('  Studios:        ', studios.length);
  console.log('  Städte:         ', staedte.length, '→', staedte.join(', '));
  console.log('  Infrastruktur:  ', infrastruktur.length);
  console.log('  Status-Verteilung:', JSON.stringify(byStatus));
  console.log('  Benötigt-Einträge:', infrastruktur.filter((i) => i.benoetigt).length);
}

run();
