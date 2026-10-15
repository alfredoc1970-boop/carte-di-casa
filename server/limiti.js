/**
 * Limiti per proteggere il credito di Claude.
 * - letture al giorno per invito (LIMITE_GIORNALIERO, predefinito 20)
 * - tentativi di codice sbagliati per indirizzo (10 ogni 10 minuti)
 * Tutto in memoria: si azzera quando il server riparte, ed è giusto così.
 */

const daily = new Map(); // nome -> { day, n }
const failures = new Map(); // ip -> [timestamp]

const today = () => new Date().toISOString().slice(0, 10);

export function dailyLimit() {
  const n = Number(process.env.LIMITE_GIORNALIERO);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** Prenota una lettura per questo invito. */
export function takeQuota(name) {
  const limit = dailyLimit();
  const d = today();
  const row = daily.get(name);
  const used = row && row.day === d ? row.n : 0;
  if (used >= limit) return { ok: false, limit, left: 0 };
  daily.set(name, { day: d, n: used + 1 });
  return { ok: true, limit, left: limit - used - 1 };
}

/** Restituisce la lettura se la chiamata a Claude non è andata a buon fine. */
export function giveBackQuota(name) {
  const row = daily.get(name);
  if (row && row.day === today() && row.n > 0) row.n -= 1;
}

export function quotaLeft(name) {
  const row = daily.get(name);
  const used = row && row.day === today() ? row.n : 0;
  return Math.max(0, dailyLimit() - used);
}

const WINDOW = 10 * 60 * 1000;
const MAX_FAILURES = 10;

export function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW);
  failures.set(ip, list);
  return list.length >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const list = failures.get(ip) || [];
  list.push(Date.now());
  failures.set(ip, list.slice(-MAX_FAILURES));
}
