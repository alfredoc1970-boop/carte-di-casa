/* Controllo veloce dello Scudo Anti-Truffa: funziona anche senza internet.
   Riconosce i segnali tipici delle truffe in un messaggio incollato. */
(function () {
  const RULES = [
    { w: 25, re: /\b(otp|codice (di verifica|ricevuto|sms|segreto)|pin|password|credenziali)\b/gi, t: 'Ti chiede codici o password', d: 'Nessuna banca, Poste o ente pubblico te li chiede mai per messaggio.' },
    { w: 22, re: /(bit\.ly|tinyurl|t\.ly|cutt\.ly|is\.gd|shorturl|rb\.gy|ow\.ly)\S*/gi, t: "C'è un link accorciato", d: 'Nasconde dove ti porta davvero. Gli enti ufficiali non li usano.' },
    { w: 18, re: /https?:\/\/[^\s]*(-verifica|-sicurezza|-cliente|-servizi|-rimborso|-consegna|verifica-|sicurezza-|login-|secure-)[^\s]*/gi, t: 'Il link imita un sito ufficiale', d: "L'indirizzo sembra della banca o delle Poste ma non lo è." },
    { w: 12, re: /https?:\/\/\S+|www\.\S+/gi, t: "C'è un link da aprire", d: 'Non aprirlo. Se serve, vai sul sito ufficiale da solo.' },
    { w: 16, re: /\b(entro (24|48|72) ?ore|urgente|subito|immediatamente|oggi stesso|ultimo avviso|sarà (annullato|bloccato|restituito|sospeso)|altrimenti)\b/gi, t: 'Ti mette fretta', d: 'La fretta serve a non farti ragionare.' },
    { w: 16, re: /\b(conto|carta|account|utenza)[^.]{0,40}(sospes|bloccat|limitat|disattivat)\w*|accesso (anomalo|sospetto|non autorizzato)/gi, t: 'Dice che il conto o la carta sono bloccati', d: 'È il trucco più usato per rubare i soldi dal conto.' },
    { w: 14, re: /\b(giacenza|pacco|spedizione|riconsegna|indirizzo incompleto|spese di (consegna|riconsegna|sdoganamento))\b/gi, t: 'Parla di un pacco da sbloccare', d: 'Chiedono pochi euro per rubare i dati della carta.' },
    { w: 22, re: /\b(nuovo numero|cambiato numero|telefono (mi è )?(caduto|rotto)|salva (questo|il) numero)\b/gi, t: 'Un parente con un numero nuovo', d: 'Il truffatore finge di essere un figlio o un nipote. Chiama il numero vecchio.' },
    { w: 16, re: /\b(bonifico|ricarica|postepay|iban|dati (della )?carta|numero (della )?carta|pagare|pagamento|versamento|buono regalo|gift card|criptovalut\w*|bitcoin)\b/gi, t: 'Ti chiede soldi o i dati della carta', d: 'Mai pagare dopo un messaggio senza aver verificato di persona o al telefono.' },
    { w: 12, re: /\b(rimborso|vincit\w+|premio|hai vinto|omaggio|bonus|accredito a (suo|tuo) favore)\b/gi, t: 'Promette soldi o un rimborso', d: "I soldi inaspettati sono l'esca più comune." },
    { w: 10, re: /\b(gentile cliente|caro cliente|gentile utente)\b/gi, t: 'Non ti chiama per nome', d: 'Le comunicazioni vere di solito usano il tuo nome.' },
    { w: 14, re: /\b(anydesk|teamviewer|quicksupport|assistenza remota|scarica (l'|questa )?app)\b/gi, t: "Ti fa installare un'app", d: 'Con quelle app il truffatore comanda il tuo telefono.' },
    { w: 12, re: /\b(investiment\w+|rendiment\w+ garantit\w+|guadagn\w+ (facil\w+|sicur\w+)|trading)\b/gi, t: 'Promette guadagni facili', d: 'Nessun investimento serio garantisce guadagni sicuri.' },
    { w: 6, re: /\b(inps|agenzia delle entrate|poste italiane|polizia|carabinieri|amazon|dhl|brt|gls|sda|enel)\b/gi, t: "Usa il nome di un ente o una ditta famosa", d: "I truffatori si travestono proprio così. Verifica dall'app o dal sito ufficiale." },
  ];

  /** Restituisce { livello: 'truffa'|'sospetto'|'sicuro', punti, segnali: [{titolo, spiegazione}] } */
  function controlloVeloce(text) {
    const flags = [];
    RULES.forEach((r) => {
      r.re.lastIndex = 0;
      if (r.re.test(text)) flags.push(r);
      r.re.lastIndex = 0;
    });
    if (flags.some((f) => f.w >= 18 && /link/i.test(f.t))) {
      const i = flags.findIndex((f) => f.t === "C'è un link da aprire");
      if (i >= 0) flags.splice(i, 1);
    }
    const punti = Math.min(100, flags.reduce((a, f) => a + f.w, 0));
    return {
      livello: punti >= 45 ? 'truffa' : punti >= 20 ? 'sospetto' : 'sicuro',
      punti,
      segnali: flags.map((f) => ({ titolo: f.t, spiegazione: f.d })),
    };
  }

  window.controlloVeloce = controlloVeloce;
})();
