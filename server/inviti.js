import crypto from 'crypto';

/**
 * Inviti: chi usa l'app entra con un link personale (…/entra?invito=CODICE).
 * Gli inviti stanno nella variabile INVITI, separati da virgola:
 *   INVITI="Alfredo:codice-lungo-1, Rosa:codice-lungo-2"
 * Per togliere l'accesso a qualcuno basta cancellare (o cambiare) il suo codice:
 * quel telefono non può più far leggere documenti (le sue scadenze restano sue).
 */

const COOKIE = 'cdc_invito';
const MAX_AGE_DAYS = 400; // il massimo che i browser accettano
const MIN_CODE = 8;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function secret() {
  const own = (process.env.SESSION_SECRET || '').trim();
  if (own) return own;
  // senza SESSION_SECRET: segreto stabile ricavato dalla chiave di Claude
  return sha(`carte-di-casa|${process.env.ANTHROPIC_API_KEY || 'sviluppo'}`);
}

/** Elenco degli inviti validi: [{ name, code }]. I codici troppo corti vengono ignorati. */
export function inviteList() {
  return String(process.env.INVITI || '')
    .split(/[,;\n]+/)
    .map((pair) => {
      const i = pair.lastIndexOf(':');
      if (i <= 0) return null;
      const name = pair.slice(0, i).trim().slice(0, 40);
      const code = pair.slice(i + 1).trim();
      return name && code.length >= MIN_CODE ? { name, code } : null;
    })
    .filter(Boolean);
}

export function invitesConfigured() {
  return inviteList().length > 0;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function inviteByCode(code) {
  const c = String(code || '').trim();
  if (c.length < MIN_CODE) return null;
  return inviteList().find((inv) => sameText(inv.code, c)) || null;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** L'invito di chi fa la richiesta, oppure null. Vale solo se il codice è ancora fra quelli attivi. */
export function inviteFromRequest(req) {
  const value = readCookie(req, COOKIE);
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  if (!sameText(sign(payload), value.slice(dot + 1))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const inv = inviteList().find((x) => x.name === data?.n);
  if (!inv || sha(inv.code).slice(0, 16) !== data?.c) return null;
  return inv;
}

function isSecure(req) {
  return req.secure || process.env.NODE_ENV === 'production';
}

export function setInviteCookie(req, res, inv) {
  const payload = Buffer.from(JSON.stringify({ n: inv.name, c: sha(inv.code).slice(0, 16), t: Date.now() })).toString(
    'base64url'
  );
  const parts = [
    `${COOKIE}=${encodeURIComponent(`${payload}.${sign(payload)}`)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearInviteCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
