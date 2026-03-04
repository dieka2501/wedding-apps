require('dotenv').config();
// Tulis credential.json dari environment variable jika ada
if (process.env.GOOGLE_CREDENTIALS && !require('fs').existsSync('./credential.json')) {
  require('fs').writeFileSync('./credential.json', process.env.GOOGLE_CREDENTIALS);
  console.log('[Startup] credential.json ditulis dari environment variable');
}
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const CREDENTIAL_PATH = path.join(__dirname, 'credential.json');
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID || '';
const SHEET_RSVP      = process.env.SHEET_NAME  || 'RSVP';
const SHEET_TAMU      = process.env.SHEET_TAMU  || 'tamu';
const BASE_URL        = process.env.BASE_URL    || `http://localhost:${PORT}`;

// ─── Google Sheets Client ─────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIAL_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// ─── Local File Store ─────────────────────────────────────────────────────────
const guestsFile = path.join(__dirname, 'guests.json');
const rsvpFile   = path.join(__dirname, 'rsvp.json');
const load = f      => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtResp(v) {
  return ({
    'hadir':           'Hadir',
    'hadir-kampoeng':  'Hadir di Kampoeng Percik (Prosesi)',
    'hadir-hotel':     'Hadir di Hotel Wahid Prime (Resepsi)',
    'hadir-keduanya':  'Hadir di Kedua Acara',
    'tidak-hadir':     'Tidak Dapat Hadir',
  })[v] || v;
}
function makeUrl(token, akad) {
  return `${BASE_URL}/?token=${token}&akad=${akad}`;
}
function canSync() {
  if (!SPREADSHEET_ID) { console.warn('[Sheets] Skip: SPREADSHEET_ID kosong'); return false; }
  if (!fs.existsSync(CREDENTIAL_PATH)) { console.warn('[Sheets] Skip: credential.json tidak ditemukan'); return false; }
  return true;
}

// ─── FIX 1: Sync RSVP → sheet RSVP (dengan error logging lengkap) ────────────
async function syncRsvpToSheets(data) {
  if (!canSync()) return;
  try {
    const sheets = await getSheetsClient();

    // Pastikan header ada — cek baris 1
    const hdr = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_RSVP}!A1:G1`,
    });
    const hasHeader = hdr.data.values && hdr.data.values.length > 0 && hdr.data.values[0][0] === 'Token';
    if (!hasHeader) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_RSVP}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Token','Nama','Akad','Respons','WhatsApp','Pesan','Waktu Submit']] },
      });
      console.log('[Sheets] Header RSVP dibuat');
    }

    // Cari apakah token sudah ada → update baris tersebut, belum ada → append
    const col    = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A:A` });
    const tokens = col.data.values || [];
    let rowIdx   = -1;
    for (let i = 1; i < tokens.length; i++) { // mulai i=1, skip header
      if (tokens[i] && tokens[i][0] === data.token) { rowIdx = i + 1; break; }
    }

    const row = [
      data.token,
      data.name,
      data.akad ? 'Ya' : 'Tidak',
      fmtResp(data.response),
      data.whatsapp || '',
      data.message  || '',
      new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    ];

    if (rowIdx > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_RSVP}!A${rowIdx}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
      console.log(`[Sheets] RSVP updated (baris ${rowIdx}): ${data.name}`);
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_RSVP}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
      console.log(`[Sheets] RSVP appended: ${data.name}`);
    }
  } catch (e) {
    // FIX: log error lengkap agar tidak silent
    console.error(`[Sheets] RSVP sync GAGAL untuk ${data.name}:`, e.message);
    if (e.errors) console.error('[Sheets] Detail:', JSON.stringify(e.errors));
  }
}

// ─── FIX 2: Sync tamu baru → sheet tamu ──────────────────────────────────────

async function syncTamuToSheets(token, name, akad, url) {
  console.log('[DEBUG] Akan sync tamu:', name, '| SPREADSHEET_ID:', process.env.SPREADSHEET_ID ? 'ada' : 'KOSONG');
  if (!canSync()) return;
  try {
    const sheets = await getSheetsClient();

    // Cek apakah token sudah ada di kolom C (skip duplikat)
    const col    = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAMU}!C:C`,
    });
    const tknCol = col.data.values || [];
    for (let i = 0; i < tknCol.length; i++) {
      if (tknCol[i] && tknCol[i][0] === token) {
        console.log(`[Sheets] Tamu sudah ada di sheet, skip: ${name}`);
        return;
      }
    }

    // Append baris baru langsung
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAMU}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, akad ? 'TRUE' : 'FALSE', token, url]] },
    });
    console.log(`[Sheets] Tamu baru ditambahkan: ${name}`);
  } catch (e) {
    console.error(`[Sheets] Sync tamu GAGAL untuk ${name}:`, e.message);
  }
}

// ─── Import bulk dari sheet "tamu" ────────────────────────────────────────────
// Fase 1: baca sheet → generate token → simpan guests.json → respons ke browser
// Fase 2: tulis balik token & link ke Sheets (background, tidak block response)
async function importFromTamuSheet() {
  const sheets = await getSheetsClient();
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAMU}!A2:D`,
  });

  const rows    = res.data.values || [];
  const guests  = load(guestsFile);
  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const name     = (rows[i][0] || '').trim();
    const akadRaw  = (rows[i][1] || '').trim().toUpperCase();
    const akad     = akadRaw === 'TRUE' || akadRaw === 'YA' || akadRaw === '1';
    const existing = (rows[i][2] || '').trim();

    if (!name) continue;

    const isNew = !existing;
    const token = isNew ? crypto.randomBytes(16).toString('hex') : existing;

    guests[token] = { name, akad, email: '' };
    updates.push({ rowNum: i + 2, token, url: makeUrl(token, akad), isNew });
  }

  // Simpan ke lokal — selesai cepat
  save(guestsFile, guests);

  // Tulis balik ke Sheets di background (tidak ditunggu)
  const newUpdates = updates.filter(u => u.isNew);
  if (newUpdates.length > 0) {
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: newUpdates.map(u => ({
          range: `${SHEET_TAMU}!C${u.rowNum}:D${u.rowNum}`,
          values: [[u.token, u.url]],
        })),
      },
    })
    .then(() => console.log(`[Sheets] Tulis balik ${newUpdates.length} token ke sheet tamu selesai`))
    .catch(e => console.error('[Sheets] Tulis balik token GAGAL:', e.message));
  }

  const created = updates.filter(u => u.isNew).length;
  const skipped = updates.filter(u => !u.isNew).length;
  return {
    total: updates.length,
    created,
    skipped,
    guests: updates.map(u => ({
      token: u.token,
      name:  guests[u.token].name,
      akad:  guests[u.token].akad,
      url:   u.url,
      isNew: u.isNew,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Validasi token
app.get('/api/validate', (req, res) => {
  const guest = load(guestsFile)[req.query.token];
  if (!guest) return res.status(403).json({ valid: false });
  res.json({ valid: true, name: guest.name, akad: guest.akad === true || guest.akad === 'true' });
});

// Submit RSVP — sync ke Sheets secara async
app.post('/api/rsvp', async (req, res) => {
  const { token, response, message, whatsapp } = req.body;
  if (!token || !response) return res.status(400).json({ success: false, message: 'Missing fields' });
  const guests = load(guestsFile);
  const guest  = guests[token];
  if (!guest) return res.status(403).json({ success: false, message: 'Invalid token' });

  // Simpan ke lokal
  const rsvp  = load(rsvpFile);
  rsvp[token] = { name: guest.name, akad: guest.akad, response, message: message || '', whatsapp: whatsapp || '', submittedAt: new Date().toISOString() };
  save(rsvpFile, rsvp);

  // Sync ke Sheets — tidak block response, tapi error akan terlog
  syncRsvpToSheets({ token, name: guest.name, akad: guest.akad, response, message, whatsapp })
    .catch(e => console.error('[RSVP] Unhandled sync error:', e.message));

  res.json({ success: true });
});

// Admin auth middleware
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// FIX 3: Generate token manual — sekarang juga sync tamu ke sheet tamu
app.post('/api/admin/generate-token', adminAuth, async (req, res) => {
  const { name, akad, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const token   = crypto.randomBytes(16).toString('hex');
  const isAkad  = akad === true || akad === 'true';
  const guests  = load(guestsFile);
  guests[token] = { name, akad: isAkad, email: email || '' };
  save(guestsFile, guests);
  const url = makeUrl(token, isAkad);

  // Sync ke sheet tamu secara async
  syncTamuToSheets(token, name, isAkad, url)
    .catch(e => console.error('[Generate] Sync error:', e.message));

  res.json({ token, url, name, akad: isAkad });
});

// Import bulk dari sheet tamu
app.post('/api/admin/import-tamu', adminAuth, async (req, res) => {
  if (!SPREADSHEET_ID) return res.status(400).json({ error: 'SPREADSHEET_ID not set' });
  try {
    const result = await importFromTamuSheet();
    console.log(`[Import] Selesai: ${result.created} baru, ${result.skipped} di-skip`);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[Import] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Daftar tamu
app.get('/api/admin/guests', adminAuth, (req, res) => {
  const guests = load(guestsFile);
  const rsvp   = load(rsvpFile);
  res.json(Object.entries(guests).map(([t, g]) => ({ token: t, ...g, rsvp: rsvp[t] || null })));
});

// Sync semua RSVP lokal ke Sheets
app.post('/api/admin/sync-sheets', adminAuth, async (req, res) => {
  const rsvp = load(rsvpFile);
  let synced = 0;
  for (const [token, data] of Object.entries(rsvp)) {
    await syncRsvpToSheets({ token, ...data });
    synced++;
  }
  res.json({ success: true, synced });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/admin/reset-guests', adminAuth, (req, res) => {
  save(guestsFile, {});
  save(rsvpFile, {});
  res.json({ success: true, message: 'Data direset' });
});
//curl -X POST https://domain-railway.up.railway.app/api/admin/reset-guests -H "x-admin-key: ADMIN_KEY_ANDA"
  //

app.listen(PORT, () => {
  console.log(`\n🌸  http://localhost:${PORT}`);
  console.log(`    Admin → http://localhost:${PORT}/admin.html\n`);
  if (!SPREADSHEET_ID)                 console.warn('⚠   SPREADSHEET_ID belum diset');
  if (!fs.existsSync(CREDENTIAL_PATH)) console.warn('⚠   credential.json tidak ditemukan');
});
