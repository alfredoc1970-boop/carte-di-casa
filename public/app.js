/* Carte di Casa — app del telefono.
   Scadenze, storico e impostazioni restano nel telefono (localStorage).
   Il server serve solo a far leggere foto, PDF e testi a Claude. */
(function () {
  'use strict';

  // ── Utilità ─────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const KEYS = {
    scadenze: 'cdc_scadenze_v1',
    storico: 'cdc_storico_v1',
    impostazioni: 'cdc_impostazioni_v1',
    invitato: 'cdc_invitato_v1',
  };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('Non riesco a salvare sul telefono: la memoria potrebbe essere piena.', true);
      return false;
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const parseIso = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  function daysUntil(iso) {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((parseIso(iso) - t) / 86400000);
  }
  const fmtDate = (iso, long) =>
    parseIso(iso).toLocaleDateString('it-IT', long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'long' });
  const fmtEuro = (n) => Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
  function daysLabel(days) {
    if (days < -1) return `Scaduta da ${-days} giorni`;
    if (days === -1) return 'Scaduta ieri';
    if (days === 0) return 'Oggi';
    if (days === 1) return 'Domani';
    return `Tra ${days} giorni`;
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  let toastTimer = null;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 7000);
    t.scrollIntoView({ block: 'nearest' });
  }

  async function api(path, body, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 120000);
    try {
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.name === 'AbortError' ? 'Ci ha messo troppo.' : 'Non riesco a collegarmi.' } };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Stato ───────────────────────────────────────────────────────
  let scadenze = (load(KEYS.scadenze, []) || []).filter((s) => s && s.id && s.data && s.cosa);
  let storico = (load(KEYS.storico, []) || []).filter((s) => s && s.id && s.r);
  const settings = Object.assign({ grande: false, preavviso: 7 }, load(KEYS.impostazioni, {}));
  let invitato = load(KEYS.invitato, null); // true / false / null = non so
  let server = { nome: '', letture: null };

  const saveScadenze = () => save(KEYS.scadenze, scadenze);
  const saveStorico = () => save(KEYS.storico, storico);

  // ── Navigazione ─────────────────────────────────────────────────
  const views = ['ricevuto', 'scadenze', 'aiuto'];
  function show(view) {
    views.forEach((v) => ($('view-' + v).hidden = v !== view));
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (view === 'scadenze') renderScadenze();
    if (view === 'aiuto') renderAiuto();
    if (view === 'ricevuto') renderHome();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // ── Testo grande ────────────────────────────────────────────────
  function applySize() {
    document.body.classList.toggle('big', !!settings.grande);
    $('sizeBtn').setAttribute('aria-pressed', settings.grande ? 'true' : 'false');
    $('sizeBtn').textContent = settings.grande ? 'Testo normale' : 'Testo più grande';
  }
  $('sizeBtn').addEventListener('click', () => {
    settings.grande = !settings.grande;
    save(KEYS.impostazioni, settings);
    applySize();
  });

  // ── Scelta del file ─────────────────────────────────────────────
  let chosen = null; // { file, url }
  const MAX_FILE = 6 * 1024 * 1024;

  function choose(file) {
    if (!file) return;
    dropFile();
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf && !file.type.startsWith('image/')) {
      toast('Questo file non lo so leggere: usa una foto o un PDF.', true);
      return;
    }
    if (isPdf && file.size > MAX_FILE) {
      toast('Il PDF è troppo grande (massimo 6 MB). Prova a fotografare solo la prima pagina.', true);
      return;
    }
    chosen = { file, isPdf, url: isPdf ? null : URL.createObjectURL(file) };
    $('chosen').hidden = false;
    $('thumb').hidden = isPdf;
    $('pdfIcon').hidden = !isPdf;
    if (!isPdf) $('thumb').src = chosen.url;
    $('fname').textContent = isPdf ? file.name : 'Foto pronta';
  }
  function dropFile() {
    if (chosen && chosen.url) URL.revokeObjectURL(chosen.url);
    chosen = null;
    $('chosen').hidden = true;
    $('camera').value = '';
    $('picker').value = '';
  }
  $('camera').addEventListener('change', (e) => choose(e.target.files[0]));
  $('picker').addEventListener('change', (e) => choose(e.target.files[0]));
  $('dropFile').addEventListener('click', dropFile);

  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  /** Le foto si rimpiccioliscono sul telefono: viaggiano più veloci e restano leggibili. */
  async function prepareFile() {
    const { file, isPdf, url } = chosen;
    if (isPdf) return { mimeType: 'application/pdf', data: await readAsBase64(file) };
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) throw new Error('canvas');
      return { mimeType: 'image/jpeg', data: await readAsBase64(blob) };
    } catch (e) {
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) && file.size <= MAX_FILE) {
        return { mimeType: file.type, data: await readAsBase64(file) };
      }
      throw new Error('Non riesco ad aprire questa foto. Prova a farne una nuova con la fotocamera.');
    }
  }

  // ── Spiegamelo ──────────────────────────────────────────────────
  const WORD = { truffa: 'FERMO! È una truffa', sospetto: 'ATTENZIONE: qualcosa non torna', sicuro: 'Sembra tranquillo' };
  const QUICK = {
    truffa: {
      in_breve: 'Questo messaggio ha i segnali tipici delle truffe. Non fare niente di quello che ti chiede.',
      cosa_fare: ['Non toccare il link', 'Non rispondere', 'Non dare codici né soldi', 'Cancella il messaggio'],
    },
    sospetto: {
      in_breve: 'Qualcosa non torna. Prima di fare qualsiasi cosa, verifica con calma o chiedi a qualcuno.',
      cosa_fare: ['Non fare niente di fretta', 'Chiedi a un familiare', 'Chiama tu il numero ufficiale'],
    },
    sicuro: {
      in_breve: 'Non vedo i segnali tipici delle truffe. Resta comunque prudente.',
      cosa_fare: ['Se chiede soldi o codici, fermati comunque'],
    },
  };

  function quickResult(q) {
    return {
      tipo: 'messaggio',
      categoria: 'Controllo veloce',
      mittente: null,
      titolo: WORD[q.livello],
      in_breve: QUICK[q.livello].in_breve,
      importo: null,
      scadenza: null,
      urgenza: q.livello === 'truffa' ? 'alta' : 'media',
      cosa_fare: QUICK[q.livello].cosa_fare,
      scadenze: [],
      truffa: { verdetto: q.livello, segnali: q.segnali },
      risposta: '',
    };
  }

  let busy = false;
  let lastText = '';

  async function explain() {
    if (busy) return;
    const text = $('msg').value.trim();
    if (!text && !chosen) {
      toast('Prima fai una foto, scegli un file oppure incolla il testo.', true);
      $('msg').focus();
      return;
    }
    lastText = text;
    const quick = text ? window.controlloVeloce(text) : null;
    const box = $('result');
    box.hidden = false;
    box.replaceChildren();

    const fallback = (why) => {
      if (quick) renderResult(quickResult(quick), { note: why + ' Questo è il controllo veloce fatto sul telefono: guarda i segnali, ma per bollette e lettere serve la lettura completa.' });
      else renderError(why);
    };

    if (!navigator.onLine) return fallback('Sei senza internet.');
    if (invitato === false) {
      $('noInvite').hidden = false;
      return fallback("Per la spiegazione completa serve il link d'invito.");
    }

    busy = true;
    $('go').disabled = true;
    const loadingText = h('span', null, chosen ? 'Sto leggendo il documento…' : 'Sto leggendo il messaggio…');
    const loading = h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), loadingText);
    if (quick && quick.livello === 'truffa') {
      box.append(
        h('div', { class: 'verdict truffa' },
          h('div', { class: 'light', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
          h('p', { class: 'word' }, 'Attenzione'),
          h('p', null, 'Il controllo veloce trova i segnali di una truffa. Intanto non cliccare e non pagare niente.'))
      );
    }
    box.append(loading);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const slow = setTimeout(() => {
      loadingText.textContent = 'Ci sto mettendo un po’: la prima volta della giornata può volerci fino a un minuto.';
    }, 8000);

    try {
      let file = null;
      if (chosen) file = await prepareFile();
      const res = await api('/api/leggi', { testo: text, file, oggi: todayIso() });
      if (res.ok && res.data && res.data.risultato) {
        setInvitato(true);
        if (res.data.letture) server.letture = res.data.letture;
        const r = res.data.risultato;
        addHistory(r);
        renderResult(r);
      } else if (res.status === 401 && res.data.code === 'invito') {
        setInvitato(false);
        fallback(res.data.error);
      } else {
        fallback(res.data.error || 'Qualcosa non ha funzionato.');
      }
    } catch (e) {
      fallback(e.message || 'Qualcosa non ha funzionato.');
    } finally {
      clearTimeout(slow);
      busy = false;
      $('go').disabled = false;
    }
  }
  $('go').addEventListener('click', explain);

  function renderError(text) {
    const box = $('result');
    box.replaceChildren(
      h('p', { class: 'toast bad' }, text),
      h('button', { class: 'btn', type: 'button', onclick: explain }, 'Riprova')
    );
  }

  function resetInput() {
    $('msg').value = '';
    dropFile();
    $('result').hidden = true;
    $('result').replaceChildren();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function speakText(r, showVerdict) {
    const parts = [];
    if (showVerdict) parts.push(WORD[r.truffa.verdetto].replace('!', '.'));
    parts.push(r.titolo + '.', r.in_breve);
    if (r.importo && r.truffa.verdetto !== 'truffa') parts.push('Da pagare: ' + fmtEuro(r.importo) + '.');
    if (r.scadenza && r.truffa.verdetto !== 'truffa') parts.push('Entro ' + fmtDate(r.scadenza, true) + '.');
    if (r.cosa_fare.length) parts.push('Cosa fare: ' + r.cosa_fare.join('. ') + '.');
    return parts.join(' ');
  }

  const canSpeak = (() => {
    try {
      return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
    } catch (e) {
      return false;
    }
  })();
  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'it-IT';
      u.rate = 0.9;
      const it = speechSynthesis.getVoices().find((v) => /^it/i.test(v.lang));
      if (it) u.voice = it;
      speechSynthesis.speak(u);
    } catch (e) {
      toast('La lettura ad alta voce non funziona su questo telefono.', true);
    }
  }

  async function shareResult(r, showVerdict) {
    const lines = [`Ho ricevuto questo: ${r.titolo}.`, r.in_breve];
    if (r.importo && r.truffa.verdetto !== 'truffa') lines.push(`Da pagare: ${fmtEuro(r.importo)}`);
    if (r.scadenza && r.truffa.verdetto !== 'truffa') lines.push(`Entro: ${fmtDate(r.scadenza, true)}`);
    if (showVerdict) lines.push(`Secondo Carte di Casa: ${WORD[r.truffa.verdetto]}.`);
    if (lastText && r.tipo === 'messaggio') lines.push('', 'Il messaggio:', lastText.slice(0, 1500));
    lines.push('', 'Mi aiuti a capire?');
    const text = lines.join('\n');
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Mi aiuti a capire?', text });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiato! Ora apri WhatsApp, scegli un familiare e incolla.');
    } catch (e) {
      $('msg').value = text;
      $('msg').select();
      toast('Il testo è pronto nel riquadro in alto: copialo e mandalo a un familiare.');
    }
  }

  function renderResult(r, opts) {
    opts = opts || {};
    const box = $('result');
    box.hidden = false;
    const v = r.truffa.verdetto;
    const showVerdict = r.tipo === 'messaggio' || v !== 'sicuro';
    const isScam = v === 'truffa';
    const kids = [];

    if (opts.note) kids.push(h('p', { class: 'fallback' }, opts.note));

    if (showVerdict) {
      kids.push(
        h('div', { class: 'verdict ' + v },
          h('div', { class: 'light', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
          h('p', { class: 'word' }, WORD[v]),
          r.tipo === 'documento' && v !== 'sicuro'
            ? h('p', null, 'Questo documento ha dei segnali che non tornano. Leggi bene prima di pagare.')
            : null)
      );
    }

    const kind = [r.categoria, r.mittente].filter(Boolean).join(' · ');
    if (kind && r.categoria !== 'Controllo veloce') kids.push(h('p', { class: 'kind' }, kind));
    if (!(opts.note && r.categoria === 'Controllo veloce')) kids.push(h('h2', { id: 'rTitle' }, r.titolo));
    if (r.in_breve) kids.push(h('p', null, r.in_breve));

    const facts = [];
    if (r.importo && !isScam) facts.push(h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Quanto'), h('div', { class: 'v' }, fmtEuro(r.importo))));
    if (r.scadenza && !isScam) {
      const d = daysUntil(r.scadenza);
      facts.push(
        h('div', { class: 'fact' + (d <= 3 ? ' alta' : '') },
          h('div', { class: 'k' }, 'Entro quando'),
          h('div', { class: 'v' }, fmtDate(r.scadenza)),
          h('div', { class: 's' }, daysLabel(d)))
      );
    }
    if (r.urgenza === 'alta' && !isScam) {
      facts.push(h('div', { class: 'fact alta' }, h('div', { class: 'k' }, 'Urgenza'), h('div', { class: 'v' }, 'Alta'), h('div', { class: 's' }, 'Non aspettare')));
    }
    if (facts.length) kids.push(h('div', { class: 'facts' }, facts));

    if (r.cosa_fare.length) {
      kids.push(h('p', { class: 'label' }, 'Cosa fare'));
      kids.push(h('ol', { class: 'todo' + (isScam ? ' danger' : '') }, r.cosa_fare.map((t) => h('li', null, t))));
    }

    if (r.scadenze.length && !isScam) {
      const already = r.scadenze.every((s) => scadenze.some((x) => x.data === s.data && x.cosa === s.cosa));
      const status = h('p', { class: 'added', role: 'status' }, already ? 'È già fra le tue scadenze ✓' : '');
      const label = r.scadenze.length === 1 ? `Aggiungi la scadenza del ${fmtDate(r.scadenze[0].data)}` : `Aggiungi le ${r.scadenze.length} scadenze`;
      const btn = h('button', {
        class: 'btn primary', type: 'button', hidden: already,
        onclick: () => {
          let n = 0;
          r.scadenze.forEach((s) => {
            if (scadenze.some((x) => x.data === s.data && x.cosa === s.cosa)) return;
            scadenze.push({ id: uid(), cosa: s.cosa, data: s.data, importo: s.importo, fatta: false, creata: Date.now(), fonte: r.categoria || 'Documento' });
            n++;
          });
          saveScadenze();
          updateDue();
          btn.hidden = true;
          status.textContent = n ? 'Aggiunta alle tue scadenze ✓' : 'È già fra le tue scadenze ✓';
        },
      }, label);
      kids.push(btn, status);
    }

    const acts = [];
    if (canSpeak) acts.push(h('button', { class: 'btn', type: 'button', onclick: () => speak(speakText(r, showVerdict)) }, 'Leggimi ad alta voce'));
    acts.push(h('button', { class: 'btn', type: 'button', onclick: () => shareResult(r, showVerdict) }, 'Manda a un familiare'));
    kids.push(h('div', { class: 'row' }, acts));

    if (r.risposta) {
      kids.push(h('p', { class: 'label' }, 'Se vuoi verificare, puoi rispondere così:'), h('div', { class: 'reply' }, r.risposta));
    }

    if (r.truffa.segnali.length && v !== 'sicuro') {
      kids.push(
        h('details', null,
          h('summary', null, 'Perché? Guarda i segnali'),
          h('ol', { class: 'why' }, r.truffa.segnali.map((s) => h('li', null, h('b', null, s.titolo), s.spiegazione))))
      );
    }

    if (isScam) {
      kids.push(h('button', { class: 'link', type: 'button', onclick: () => show('aiuto') }, 'Hai già cliccato, dato dati o pagato? Guarda cosa fare'));
    } else if (!showVerdict) {
      kids.push(h('p', { class: 'safe-line' }, '✓ Non vedo segnali di truffa in questo documento.'));
    }

    kids.push(h('button', { class: 'btn', type: 'button', onclick: resetInput }, opts.fromHistory ? 'Chiudi' : "Leggi un'altra cosa"));
    box.replaceChildren(...kids);
  }

  // ── Storico ─────────────────────────────────────────────────────
  function addHistory(r) {
    storico.unshift({ id: uid(), at: Date.now(), r });
    storico = storico.slice(0, 30);
    saveStorico();
    renderHistory();
  }
  function renderHistory() {
    $('historyBox').hidden = !storico.length;
    $('history').replaceChildren(
      ...storico.map((s) =>
        h('li', null,
          h('button', {
            type: 'button',
            onclick: () => {
              lastText = '';
              renderResult(s.r, { fromHistory: true });
              $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
          },
          s.r.titolo,
          h('span', { class: 'd' }, new Date(s.at).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) + (s.r.truffa.verdetto === 'truffa' ? ' · truffa' : ''))))
      )
    );
  }

  // ── Scadenze ────────────────────────────────────────────────────
  function cls(days) {
    if (days <= 2) return 'bad';
    if (days <= settings.preavviso) return 'warn';
    return 'ok';
  }
  const pending = () => scadenze.filter((s) => !s.fatta).sort((a, b) => a.data.localeCompare(b.data));

  function updateDue() {
    const p = pending();
    const overdue = p.filter((s) => daysUntil(s.data) < 0).length;
    const soon = p.filter((s) => daysUntil(s.data) <= settings.preavviso).length;
    const badge = $('badge');
    badge.hidden = !soon;
    badge.textContent = soon;
    const banner = $('dueBanner');
    if (overdue) {
      banner.className = 'banner bad';
      banner.textContent = overdue === 1 ? 'Hai una scadenza già passata. Tocca per vederla →' : `Hai ${overdue} scadenze già passate. Tocca per vederle →`;
      banner.hidden = false;
    } else if (soon) {
      banner.className = 'banner';
      banner.textContent = soon === 1 ? `Hai una scadenza nei prossimi ${settings.preavviso} giorni →` : `Hai ${soon} scadenze nei prossimi ${settings.preavviso} giorni →`;
      banner.hidden = false;
    } else banner.hidden = true;
  }
  $('dueBanner').addEventListener('click', () => show('scadenze'));

  function itemView(s) {
    const days = daysUntil(s.data);
    const c = s.fatta ? 'done' : cls(days);
    const acts = s.fatta
      ? [
          h('button', { class: 'btn small', type: 'button', onclick: () => setDone(s.id, false) }, 'Non è fatta'),
          h('button', { class: 'btn small', type: 'button', onclick: () => removeItem(s.id) }, 'Togli'),
        ]
      : [
          h('button', { class: 'btn small okbtn', type: 'button', onclick: () => setDone(s.id, true) }, 'Fatto ✓'),
          h('button', { class: 'btn small', type: 'button', onclick: () => downloadIcs([s]) }, 'Nel calendario'),
          h('button', { class: 'link remove', type: 'button', onclick: () => removeItem(s.id) }, 'Togli dalla lista'),
        ];
    return h('li', { class: 'item ' + c },
      h('div', { class: 'head' },
        h('div', null,
          h('div', { class: 'what' }, s.cosa),
          h('div', { class: 'when' }, fmtDate(s.data) + (s.fatta && s.fattaIl ? ' · fatta il ' + new Date(s.fattaIl).toLocaleDateString('it-IT') : ''))),
        s.importo ? h('div', { class: 'amount' }, fmtEuro(s.importo)) : null),
      s.fatta ? null : h('div', null, h('span', { class: 'days' }, daysLabel(days))),
      h('div', { class: 'acts' }, acts));
  }

  function renderScadenze() {
    const p = pending();
    const groups = { bad: [], warn: [], ok: [] };
    p.forEach((s) => groups[cls(daysUntil(s.data))].push(s));
    $('dueCounts').replaceChildren(
      h('div', { class: 'chip bad' }, h('b', null, groups.bad.length), 'da fare subito'),
      h('div', { class: 'chip warn' }, h('b', null, groups.warn.length), 'nei prossimi giorni'),
      h('div', { class: 'chip ok' }, h('b', null, groups.ok.length), 'più avanti')
    );
    const titles = { bad: 'Da fare subito', warn: 'Nei prossimi giorni', ok: 'Più avanti' };
    const out = [];
    for (const k of ['bad', 'warn', 'ok']) {
      if (!groups[k].length) continue;
      out.push(h('section', { class: 'group ' + k }, h('h2', null, h('i', { 'aria-hidden': 'true' }), titles[k]), h('ul', { class: 'items' }, groups[k].map(itemView))));
    }
    if (!p.length) out.push(h('p', { class: 'empty' }, 'Nessuna scadenza da fare. Quando leggo una bolletta o una lettera con una data, la puoi aggiungere qui con un tocco.'));
    $('dueGroups').replaceChildren(...out);
    $('allIcs').hidden = p.length < 2;

    const done = scadenze.filter((s) => s.fatta).sort((a, b) => (b.fattaIl || 0) - (a.fattaIl || 0)).slice(0, 30);
    $('doneBox').hidden = !done.length;
    $('doneTitle').textContent = `Già fatte (${done.length})`;
    $('doneList').replaceChildren(...done.map(itemView));
    updateDue();
  }

  function setDone(id, value) {
    const s = scadenze.find((x) => x.id === id);
    if (!s) return;
    s.fatta = value;
    s.fattaIl = value ? Date.now() : null;
    saveScadenze();
    renderScadenze();
    if (value) toast('Fatto! Ben fatto.');
  }
  function removeItem(id) {
    const s = scadenze.find((x) => x.id === id);
    if (!s || !window.confirm(`Togliere "${s.cosa}" dalle scadenze?`)) return;
    scadenze = scadenze.filter((x) => x.id !== id);
    saveScadenze();
    renderScadenze();
  }

  $('addDate').value = todayIso();
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const cosa = $('addWhat').value.trim();
    const data = $('addDate').value;
    const raw = $('addAmount').value.trim().replace(/\s|€/g, '');
    const importo = raw ? Number(raw.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) : null;
    if (!cosa || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return;
    if (raw && !(importo > 0)) {
      toast("Scrivi l'importo solo con numeri, per esempio 84,30.", true);
      return;
    }
    scadenze.push({ id: uid(), cosa, data, importo: importo ? Math.round(importo * 100) / 100 : null, fatta: false, creata: Date.now(), fonte: 'A mano' });
    saveScadenze();
    $('addForm').reset();
    $('addDate').value = todayIso();
    $('addBox').open = false;
    renderScadenze();
    toast('Scadenza aggiunta ✓');
  });

  // ── Calendario (.ics con promemoria) ─────────────────────────────
  const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  function fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) {
      out.push(rest.slice(0, 74));
      rest = ' ' + rest.slice(74);
    }
    out.push(rest);
    return out.join('\r\n');
  }
  function downloadIcs(list) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Carte di Casa//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    list.forEach((s) => {
      const start = s.data.replace(/-/g, '');
      const next = parseIso(s.data);
      next.setDate(next.getDate() + 1);
      const end = `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
      const title = `Scadenza: ${s.cosa}${s.importo ? ` (${fmtEuro(s.importo)})` : ''}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.id}@carte-di-casa`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        fold(`SUMMARY:${icsEscape(title)}`),
        'DESCRIPTION:Promemoria messo da Carte di Casa',
        'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${icsEscape(title)}`), 'TRIGGER:-P2DT15H', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${icsEscape(title)}`), 'TRIGGER:-PT15H', 'END:VALARM',
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: list.length === 1 ? 'scadenza.ics' : 'scadenze.ics' });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    toast('Apri il file scaricato e scegli il calendario: ti avviserà tre giorni prima e il giorno prima.');
  }
  $('allIcs').addEventListener('click', () => downloadIcs(pending()));

  // ── Aiuto: installazione, invito, dati ───────────────────────────
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    if (!$('view-aiuto').hidden) renderAiuto();
  });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    try {
      await installEvent.userChoice;
    } catch (e) {}
    installEvent = null;
    renderAiuto();
  });

  function renderAiuto() {
    const t = $('installText');
    $('installBtn').hidden = true;
    if (isStandalone()) t.textContent = "L'app è già installata su questo telefono ✓";
    else if (installEvent) {
      t.textContent = 'Così la trovi fra le app, con la sua icona, senza aprire il browser.';
      $('installBtn').hidden = false;
    } else if (isIos()) t.textContent = 'Su iPhone: in Safari tocca Condividi (il quadrato con la freccia in su), poi "Aggiungi alla schermata Home".';
    else t.textContent = 'Apri il menu del browser (i tre puntini in alto a destra) e scegli "Installa app" oppure "Aggiungi a schermata Home".';

    const inv = $('inviteText');
    if (invitato === true) {
      const l = server.letture;
      inv.textContent = (server.nome ? `Sei dentro come ${server.nome}. ` : 'Il tuo invito è attivo. ') + (l ? `Oggi puoi farmi leggere ancora ${l.rimaste} cose su ${l.giorno}.` : '');
      $('codeForm').hidden = true;
    } else {
      inv.textContent = invitato === false
        ? "Non hai ancora l'invito: chiedi il link a chi ti ha consigliato l'app e aprilo da questo telefono."
        : 'Sto controllando il tuo invito…';
      $('codeForm').hidden = invitato !== false;
    }
  }

  $('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const codice = $('codeInput').value.trim();
    if (!codice) return;
    const res = await api('/api/entra', { codice }, 70000);
    if (res.ok) {
      $('codeInput').value = '';
      server.nome = res.data.nome || '';
      setInvitato(true);
      refreshStatus();
      toast('Fatto! Ora puoi farmi leggere bollette, lettere e messaggi.');
      renderAiuto();
    } else toast(res.data.error || 'Codice non valido.', true);
  });

  function setInvitato(v) {
    invitato = v;
    save(KEYS.invitato, v);
    $('noInvite').hidden = v !== false;
  }

  async function refreshStatus() {
    const res = await api('/api/stato', null, 70000);
    if (!res.ok) return;
    server.nome = res.data.nome || '';
    server.letture = res.data.letture || null;
    setInvitato(!!res.data.invitato);
    if (!$('view-aiuto').hidden) renderAiuto();
  }

  $('exportBtn').addEventListener('click', () => {
    const data = { app: 'carte-di-casa', versione: 1, salvatoIl: new Date().toISOString(), scadenze, storico, impostazioni: settings };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `carte-di-casa-copia-${todayIso()}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    toast('Copia salvata nei download del telefono ✓');
  });

  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== 'carte-di-casa' || !Array.isArray(data.scadenze)) throw new Error();
      const byId = new Map(scadenze.map((s) => [s.id, s]));
      data.scadenze.filter((s) => s && s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.data) && s.cosa).forEach((s) => byId.set(s.id, s));
      scadenze = Array.from(byId.values());
      if (Array.isArray(data.storico)) {
        const known = new Set(storico.map((s) => s.id));
        storico = storico.concat(data.storico.filter((s) => s && s.id && s.r && !known.has(s.id))).sort((a, b) => b.at - a.at).slice(0, 30);
      }
      saveScadenze();
      saveStorico();
      renderHistory();
      updateDue();
      toast('Copia ripresa ✓ Ritrovi le tue scadenze.');
    } catch (err) {
      toast('Questo file non è una copia di Carte di Casa.', true);
    }
  });

  $('wipeBtn').addEventListener('click', () => {
    if (!window.confirm('Cancellare da questo telefono tutte le scadenze e le cose lette? Non si può tornare indietro.')) return;
    scadenze = [];
    storico = [];
    saveScadenze();
    saveStorico();
    renderHistory();
    updateDue();
    toast('Fatto: questo telefono è pulito.');
  });

  // ── Avvio ───────────────────────────────────────────────────────
  function renderHome() {
    updateDue();
    renderHistory();
    $('noInvite').hidden = invitato !== false;
  }

  function readUrl() {
    const p = new URLSearchParams(location.search);
    if (p.has('benvenuto')) {
      setInvitato(true);
      toast(isStandalone() ? 'Benvenuto! Ora puoi farmi leggere bollette, lettere e messaggi.' : "Benvenuto! È tutto pronto. Per averla sempre a portata di mano, mettila sul telefono: guarda in Aiuto.");
    } else if (p.get('invito') === 'non-valido') {
      toast("Questo link d'invito non funziona. Chiedine uno nuovo a chi te l'ha mandato.", true);
    } else if (p.get('invito') === 'attendi') {
      toast('Troppi tentativi. Riprova fra 10 minuti.', true);
    }
    if (p.toString()) history.replaceState(null, '', location.pathname);
  }

  applySize();
  readUrl();
  renderHome();
  refreshStatus();
  window.addEventListener('online', refreshStatus);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
