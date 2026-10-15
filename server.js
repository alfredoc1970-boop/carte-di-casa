import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  inviteByCode,
  inviteFromRequest,
  invitesConfigured,
  setInviteCookie,
  clearInviteCookie,
} from './server/inviti.js';
import { readDocument, isClaudeConfigured, ReadError, IMAGE_TYPES } from './server/claude.js';
import { takeQuota, giveBackQuota, quotaLeft, dailyLimit, tooManyFailures, recordFailure } from './server/limiti.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_BYTES = 6 * 1024 * 1024; // file originale: 6 MB
const MAX_TEXT = 12000;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sta davanti al server

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

// ── Link d'invito: un tocco e il telefono è abilitato ──────────────
app.get('/entra', (req, res) => {
  const ip = req.ip || '';
  if (tooManyFailures(ip)) return res.redirect(303, '/?invito=attendi');
  const inv = inviteByCode(req.query.invito || req.query.codice || '');
  if (!inv) {
    recordFailure(ip);
    return res.redirect(303, '/?invito=non-valido');
  }
  setInviteCookie(req, res, inv);
  res.redirect(303, '/?benvenuto=1');
});

app.use('/api', express.json({ limit: '9mb' }));

app.get('/api/stato', (req, res) => {
  const inv = inviteFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    invitato: Boolean(inv),
    nome: inv?.name || '',
    letture: inv ? { rimaste: quotaLeft(inv.name), giorno: dailyLimit() } : null,
    servizio: isClaudeConfigured() && invitesConfigured(),
    // solo i nomi delle impostazioni mancanti, mai i valori: aiuta a capire cosa sistemare su Render
    manca: [!isClaudeConfigured() && 'ANTHROPIC_API_KEY', !invitesConfigured() && 'INVITI'].filter(Boolean),
  });
});

app.post('/api/entra', (req, res) => {
  const ip = req.ip || '';
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Troppi tentativi. Riprova fra 10 minuti.' });
  const inv = inviteByCode(req.body?.codice || '');
  if (!inv) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Codice non valido. Controlla di averlo scritto bene.' });
  }
  setInviteCookie(req, res, inv);
  res.json({ ok: true, nome: inv.name });
});

app.post('/api/esci', (req, res) => {
  clearInviteCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/leggi', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const inv = inviteFromRequest(req);
  if (!inv) {
    return res.status(401).json({
      error: "Per leggere i documenti serve il link d'invito. Chiedilo a chi ti ha consigliato l'app.",
      code: 'invito',
    });
  }

  const body = req.body || {};
  const testo = typeof body.testo === 'string' ? body.testo.trim().slice(0, MAX_TEXT) : '';
  let file = null;
  if (body.file && typeof body.file === 'object') {
    const mimeType = String(body.file.mimeType || '');
    const data = typeof body.file.data === 'string' ? body.file.data.replace(/^data:[^,]+,/, '') : '';
    if (mimeType !== 'application/pdf' && !IMAGE_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: 'Questo tipo di file non lo so leggere: usa una foto o un PDF.' });
    }
    if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) {
      return res.status(400).json({ error: 'Il file è arrivato rovinato: riprova.' });
    }
    if (data.length * 0.75 > MAX_FILE_BYTES) {
      return res.status(413).json({ error: 'Il file è troppo grande: prova con una foto sola o un PDF più piccolo.' });
    }
    file = { mimeType, data };
  }
  if (!file && testo.length < 10) {
    return res.status(400).json({ error: 'Fai una foto, scegli un file oppure incolla il testo.' });
  }
  const oggi = /^\d{4}-\d{2}-\d{2}$/.test(String(body.oggi || ''))
    ? body.oggi
    : new Date().toISOString().slice(0, 10);

  const quota = takeQuota(inv.name);
  if (!quota.ok) {
    return res
      .status(429)
      .json({ error: `Per oggi hai usato tutte le ${quota.limit} letture. Domani si ricomincia.`, code: 'limite' });
  }

  try {
    const risultato = await readDocument({ testo, file, oggi });
    res.json({ risultato, letture: { rimaste: quota.left, giorno: quota.limit } });
  } catch (err) {
    giveBackQuota(inv.name);
    const status = err instanceof ReadError ? err.status : 500;
    res.status(status).json({ error: err instanceof ReadError ? err.message : 'Qualcosa non ha funzionato: riprova.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Non trovato' }));

// Errori del corpo della richiesta (JSON rotto o troppo grande)
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Il file è troppo grande: prova con una foto sola o un PDF più piccolo.' });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Richiesta non valida.' });
  next(err);
});

// ── L'app (file statici) ──────────────────────────────────────────
const pub = path.join(__dirname, 'public');
app.use(
  express.static(pub, {
    setHeaders(res, file) {
      // questi due devono aggiornarsi subito
      if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Carte di Casa in ascolto sulla porta ${PORT}`);
  if (!isClaudeConfigured()) console.log('Attenzione: manca ANTHROPIC_API_KEY');
  if (!invitesConfigured()) console.log('Attenzione: nessun invito in INVITI');
});
