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

export const TIPI_CONTRATTO = [
  'Luce',
  'Gas',
  'Acqua',
  'Internet e telefono di casa',
  'Cellulare',
  'Assicurazione auto',
  'Assicurazione casa',
  'Altra assicurazione',
  'Abbonamento TV',
  'Rifiuti',
  'Altro',
];
export const PERIODI = ['mese', 'bimestre', 'trimestre', 'semestre', 'anno'];

const SCHEMA_TEMPLATE = `Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:
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
  "risposta": "solo per un messaggio sospetto di un presunto parente o conoscente: una breve risposta sicura per verificare; altrimenti stringa vuota",
  "contratto": null oppure {
    "tipo": uno fra "TIPI_CONTRATTO",
    "fornitore": "nome della ditta",
    "costo": numero in euro per il periodo della bolletta o della rata, oppure null,
    "periodicita": "mese" oppure "bimestre" oppure "trimestre" oppure "semestre" oppure "anno",
    "rinnovo": "AAAA-MM-GG se c'è scritta la data di scadenza o rinnovo del contratto o della polizza" oppure null
  }
}
In "scadenze" metti ogni data utile (per esempio le rate); se è una truffa lasciala vuota.
In "segnali" metti i segnali di truffa trovati; se è "sicuro", al massimo un segnale rassicurante o nessuno.
Compila "contratto" solo per bollette, contratti, polizze o abbonamenti veri di un servizio che si paga in modo ricorrente; altrimenti null.`;

const SCHEMA = SCHEMA_TEMPLATE.replace('"TIPI_CONTRATTO"', TIPI_CONTRATTO.map((t) => `"${t}"`).join(', '));

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
    contratto: verdetto === 'truffa' ? null : cleanContract(raw?.contratto),
  };
}

function cleanContract(c) {
  if (!c || typeof c !== 'object') return null;
  const fornitore = str(c.fornitore, 60);
  if (!fornitore) return null;
  return {
    tipo: oneOf(c.tipo, TIPI_CONTRATTO, 'Altro'),
    fornitore,
    costo: euro(c.costo),
    periodicita: oneOf(c.periodicita, PERIODI, 'mese'),
    rinnovo: isoDate(c.rinnovo),
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

  const text = await ask(SYSTEM(oggi), content, 1700);

  try {
    return cleanResult(extractJson(text));
  } catch {
    console.error('Risposta di Claude non leggibile');
    throw new ReadError('Non sono riuscito a capire bene il documento: riprova, magari con una foto più nitida.', 502);
  }
}

/** Una chiamata a Claude: restituisce il testo della risposta. */
async function ask(system, content, maxTokens) {
  try {
    const response = await getClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    });
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (error) {
    console.error('Errore Claude:', error?.status || '', error?.message || error);
    throw friendly(error);
  }
}

// ── Lettere per i contratti ────────────────────────────────────────

export const LETTERE = {
  disdetta: 'Disdetta del contratto (non voglio più il servizio)',
  reclamo: 'Reclamo (qualcosa non va: bolletta troppo alta, servizio che non funziona, addebito sbagliato)',
  rimborso: 'Richiesta di rimborso di una somma pagata e non dovuta',
  ripensamento: 'Ripensamento: recesso da un contratto appena firmato, entro 14 giorni',
};

const LETTER_SYSTEM = (oggi) => `Scrivi lettere formali in italiano per consumatori comuni che devono scrivere a un fornitore di servizi (luce, gas, acqua, telefono, internet, assicurazioni, abbonamenti).
Tono cortese ma fermo, frasi chiare, niente giri di parole. Oggi è ${oggi}.
Regole:
- Per i dati personali usa SOLO questi segnaposto, scritti esattamente così: [Nome e Cognome], [Indirizzo], [Codice cliente], [Luogo e data]. Non inventarli mai.
- Non inventare indirizzi, PEC, numeri di telefono, numeri di pratica o importi che non ti ho dato. Non citare articoli di legge precisi se non sei sicuro: puoi richiamare in modo generico "il Codice del Consumo".
- Non promettere un risultato: la lettera chiede, non minaccia.
- La lettera è completa: luogo e data, mittente, destinatario (il fornitore, senza indirizzo inventato: scrivi "Spett.le" e il nome), oggetto, testo, saluti, firma.`;

export async function writeLetter({ tipoLettera, contratto, dettagli, oggi }) {
  if (!isClaudeConfigured()) throw new ReadError('Il servizio non è ancora configurato.', 503);
  const prompt = `Tipo di lettera: ${LETTERE[tipoLettera]}
Contratto: ${contratto.tipo} con ${contratto.fornitore}
Cosa mi è successo o cosa voglio (scritto da me, può essere vuoto):
"""
${dettagli || '(niente da aggiungere)'}
"""

Rispondi SOLO con un oggetto JSON:
{
  "oggetto": "l'oggetto della lettera, una riga",
  "testo": "la lettera completa, con a capo veri (\\n)",
  "come_mandarla": ["da 2 a 4 passi semplici: come e a chi mandarla (PEC, raccomandata con ricevuta di ritorno, area clienti), dicendo dove trovare l'indirizzo giusto (bolletta, contratto, sito del fornitore)"],
  "attenzione": "una frase su cosa controllare prima di mandarla (per esempio un termine di preavviso scritto nel contratto), oppure stringa vuota"
}`;
  const text = await ask(LETTER_SYSTEM(oggi), [{ type: 'text', text: prompt }], 1800);
  try {
    const out = extractJson(text);
    const testo = typeof out?.testo === 'string' ? mask(out.testo.trim()).slice(0, 6000) : '';
    if (testo.length < 80) throw new Error('lettera vuota');
    return {
      oggetto: str(out?.oggetto, 200),
      testo,
      come_mandarla: (Array.isArray(out?.come_mandarla) ? out.come_mandarla : [])
        .map((x) => str(x, 240))
        .filter(Boolean)
        .slice(0, 5),
      attenzione: str(out?.attenzione, 300),
    };
  } catch {
    console.error('Lettera di Claude non leggibile');
    throw new ReadError('Non sono riuscito a scrivere la lettera: riprova fra poco.', 502);
  }
}

