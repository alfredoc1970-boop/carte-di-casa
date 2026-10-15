import Anthropic from '@anthropic-ai/sdk';

/**
 * Lettura di bollette, lettere e messaggi con Claude.
 * Il server non salva niente: riceve il testo o il file, lo passa a Claude,
 * restituisce la spiegazione e dimentica tutto.
 */

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const env = (k) => (process.env[k] || '').trim();

export function isClaudeConfigured() {
  return Boolean(env('ANTHROPIC_API_KEY'));
}

export class ReadError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 100_000 });
  return client;
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const SYSTEM = (oggi) => `Sei "Carte di Casa": aiuti persone comuni, spesso anziane, a capire la posta, le bollette e i messaggi che ricevono in Italia: bollette di luce, gas, acqua, telefono e rifiuti; PEC e raccomandate; cartelle e avvisi dell'Agenzia delle Entrate-Riscossione; multe; avvisi di INPS, Comune, banca, Poste, assicurazioni; contratti; SMS, email e messaggi WhatsApp.
Sei anche un esperto di truffe: phishing via SMS, email e WhatsApp, finto parente ("ciao mamma"), finto corriere, finta banca, falsi enti (INPS, Agenzia delle Entrate, Poste), false bollette e false PEC, finti rimborsi, finti investimenti, finta assistenza tecnica.

Scrivi per chi legge con fatica: frasi brevissime, parole semplici, tono calmo e rassicurante. Dai del tu.
Regole:
- Usa solo ciò che c'è nel documento. Se un dato non si legge o non c'è, metti null: non inventare mai importi, date o mittenti.
- Non riscrivere mai per intero codice fiscale, IBAN, numeri di carta, codici cliente, POD o PDR: se servono, di' dove si trovano sul foglio.
- Date nel formato AAAA-MM-GG. Oggi è ${oggi}: usalo per capire "entro 10 giorni", "domani" e simili.
- Anche un documento che sembra vero può essere una truffa (finta bolletta, finta PEC, finto avviso): valuta sempre.
- Non dire mai di pagare o cliccare un link contenuto in un messaggio sospetto: suggerisci di verificare dal sito o dall'app ufficiale, o chiamando il numero scritto sulla carta o sul contratto.`;

const SCHEMA = `Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:
{
  "tipo": "documento" oppure "messaggio",
  "categoria": "es. Bolletta della luce, Bolletta del gas, PEC, Raccomandata, Cartella esattoriale, Multa, Avviso INPS, Contratto, SMS, Email, WhatsApp",
  "mittente": "chi lo manda, o chi dice di essere; null se non si capisce",
  "titolo": "massimo 8 parole",
  "in_breve": "2 o 3 frasi semplicissime: cos'è e cosa vuole da te",
  "importo": numero in euro da pagare (es. 84.30) oppure null,
  "scadenza": "AAAA-MM-GG, la data entro cui fare qualcosa" oppure null,
  "urgenza": "alta" oppure "media" oppure "bassa",
  "cosa_fare": ["da 2 a 4 azioni brevi all'imperativo, massimo 10 parole ciascuna"],
  "scadenze": [{"data": "AAAA-MM-GG", "cosa": "massimo 8 parole", "importo": numero oppure null}],
  "truffa": {
    "verdetto": "truffa" oppure "sospetto" oppure "sicuro",
    "segnali": [{"titolo": "massimo 6 parole", "spiegazione": "una frase semplice"}]
  },
  "risposta": "solo per un messaggio sospetto di un presunto parente o conoscente: una breve risposta sicura per verificare; altrimenti stringa vuota"
}
In "scadenze" metti ogni data utile (per esempio le rate); se è una truffa lasciala vuota.
In "segnali" metti i segnali di truffa trovati; se è "sicuro", al massimo un segnale rassicurante o nessuno.`;

/** Estrae il primo oggetto JSON da una risposta (tollera ```json … ``` e testo attorno). */
export function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('risposta non in formato JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── Pulizia della risposta ─────────────────────────────────────────

const CF = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const IBAN = /\bIT\s?\d{2}\s?[A-Z]\s?(?:[0-9A-Z]\s?){22}\b/gi;

/** Oscura codice fiscale e IBAN se il modello li avesse riscritti. */
export function mask(s) {
  return String(s)
    .replace(CF, (m) => `${m.slice(0, 3)}…${m.slice(-2)}`)
    .replace(IBAN, (m) => {
      const t = m.replace(/\s/g, '');
      return `${t.slice(0, 4)}…${t.slice(-4)}`;
    });
}

const str = (v, max) => (typeof v === 'string' ? mask(v.trim()).slice(0, max) : '');

function isoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return v;
}

function euro(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/\./g, '').replace(',', '.')) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100) / 100;
}

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function cleanResult(raw) {
  const truffa = raw?.truffa && typeof raw.truffa === 'object' ? raw.truffa : {};
  const verdetto = oneOf(truffa.verdetto, ['truffa', 'sospetto', 'sicuro'], 'sospetto');
  const segnali = (Array.isArray(truffa.segnali) ? truffa.segnali : [])
    .map((s) => ({ titolo: str(s?.titolo, 80), spiegazione: str(s?.spiegazione, 300) }))
    .filter((s) => s.titolo)
    .slice(0, 6);

  let scadenze = (Array.isArray(raw?.scadenze) ? raw.scadenze : [])
    .map((s) => ({ data: isoDate(s?.data), cosa: str(s?.cosa, 80), importo: euro(s?.importo) }))
    .filter((s) => s.data && s.cosa)
    .slice(0, 12);

  const scadenza = isoDate(raw?.scadenza);
  const importo = euro(raw?.importo);
  const titolo = str(raw?.titolo, 90) || str(raw?.categoria, 90) || 'Documento';
  if (verdetto === 'truffa') scadenze = [];
  else if (!scadenze.length && scadenza) scadenze = [{ data: scadenza, cosa: titolo.slice(0, 80), importo }];

  return {
    tipo: oneOf(raw?.tipo, ['documento', 'messaggio'], 'documento'),
    categoria: str(raw?.categoria, 60),
    mittente: str(raw?.mittente, 100) || null,
    titolo,
    in_breve: str(raw?.in_breve, 700),
    importo,
    scadenza,
    urgenza: oneOf(raw?.urgenza, ['alta', 'media', 'bassa'], 'media'),
    cosa_fare: (Array.isArray(raw?.cosa_fare) ? raw.cosa_fare : [])
      .map((x) => str(x, 140))
      .filter(Boolean)
      .slice(0, 5),
    scadenze,
    truffa: { verdetto, segnali },
    risposta: str(raw?.risposta, 400),
  };
}

function friendly(error) {
  const status = error?.status;
  if (status === 401) return new ReadError('Il servizio non è configurato bene (chiave di Claude non valida).', 503);
  if (status === 402 || status === 403) return new ReadError('Il servizio non è disponibile in questo momento.', 503);
  if (status === 429) return new ReadError('Troppe richieste insieme: riprova fra un minuto.', 429);
  if (status === 529 || status === 503 || status === 500) return new ReadError('Il servizio è molto occupato: riprova fra poco.', 503);
  if (status === 400) return new ReadError('Non riesco a leggere questo file. Prova con una foto più nitida o incolla il testo.', 400);
  if (error?.name === 'APIConnectionTimeoutError') return new ReadError('Ci ha messo troppo: riprova fra poco.', 504);
  return new ReadError('Non sono riuscito a leggere il documento. Riprova fra poco.', 502);
}

/**
 * @param {{ testo?: string, file?: { mimeType: string, data: string }, oggi: string }} input
 */
export async function readDocument({ testo = '', file = null, oggi }) {
  if (!isClaudeConfigured()) throw new ReadError('Il servizio non è ancora configurato.', 503);
  const content = [];
  if (file) {
    content.push(
      file.mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
        : { type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } }
    );
  }
  const what = file ? (file.mimeType === 'application/pdf' ? 'questo documento' : 'quello che vedi nella foto') : 'questo testo';
  const note = testo && file ? `\nCi ha scritto anche:\n"""\n${testo}\n"""` : testo ? `\n"""\n${testo}\n"""` : '';
  content.push({ type: 'text', text: `Spiegami ${what}.${note}\n\n${SCHEMA}` });

  let text;
  try {
    const response = await getClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: SYSTEM(oggi),
      messages: [{ role: 'user', content }],
    });
    text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (error) {
    console.error('Errore Claude:', error?.status || '', error?.message || error);
    throw friendly(error);
  }

  try {
    return cleanResult(extractJson(text));
  } catch {
    console.error('Risposta di Claude non leggibile');
    throw new ReadError('Non sono riuscito a capire bene il documento: riprova, magari con una foto più nitida.', 502);
  }
}
