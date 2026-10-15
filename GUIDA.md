# Carte di Casa: guida per metterla online

Bollette, lettere, PEC, cartelle e messaggi spiegati in parole semplici, con le scadenze e il controllo delle truffe. L'app si installa sul telefono e funziona così:

- **Ho ricevuto qualcosa**: si fa una foto, si sceglie un PDF o si incolla un messaggio. L'app dice cos'è, quanto c'è da pagare, entro quando e cosa fare, e se è una truffa.
- **Scadenze**: le date trovate finiscono in una lista con un tocco, con i colori e il promemoria nel calendario del telefono (tre giorni prima e il giorno prima).
- **Contratti**: luce, gas, telefono, assicurazioni e abbonamenti, con quanto si spende al mese e all'anno, il promemoria prima del rinnovo e la lettera pronta (disdetta, reclamo, rimborso, ripensamento). Quando si legge una bolletta, l'app propone di aggiungerla ai contratti.
- **Aiuto**: testo grande, installazione, copia dei dati, cosa fare se si è già cliccato.

**Dove stanno i dati.** Scadenze, contratti e storico restano solo sul telefono di chi usa l'app. Il server non ha un database: riceve la foto o il testo, li passa a Claude, restituisce la spiegazione e non salva niente. Il controllo veloce dei messaggi funziona anche senza internet e senza invito.

## 1. Metterla online su Render (5 minuti)
1. Su GitHub il codice sta nel repository privato `carte-di-casa`.
2. Su **render.com** → **New → Blueprint** → scegli il repository `carte-di-casa`. Render legge `render.yaml` e prepara tutto.
3. Quando te lo chiede, inserisci:
   - `ANTHROPIC_API_KEY` → la chiave di Claude. Puoi usare la stessa del Cervello, oppure crearne una nuova su console.anthropic.com per vedere i costi separati.
   - `INVITI` → l'elenco delle persone che possono usarla (vedi sotto).
   `SESSION_SECRET` lo genera Render da solo.
4. Premi **Apply**. Dopo qualche minuto hai un indirizzo tipo `https://carte-di-casa.onrender.com`.

**Piano gratuito**: dopo un po' che nessuno la usa, il server si addormenta. L'app si apre comunque subito, perché è salvata sul telefono, ma la prima lettura della giornata può metterci fino a un minuto: l'app lo dice. Se la dai a persone anziane, il piano *Starter* (pochi euro al mese) la tiene sempre sveglia.

## 2. Gli inviti
Ogni persona ha un suo codice. Nella variabile `INVITI` su Render scrivi nome e codice separati da due punti, e le persone separate da virgole:

```
INVITI=Alfredo:mela-verde-2731, Rosa:sole-alto-9048
```

- Il codice deve avere almeno 8 caratteri: va bene qualsiasi parola inventata con un numero.
- Il link da mandare (per WhatsApp o SMS) è: `https://INDIRIZZO/entra?invito=CODICE`
  Per esempio: `https://carte-di-casa.onrender.com/entra?invito=sole-alto-9048`
- Chi lo apre dal telefono è dentro con un tocco, senza password, e ci resta per oltre un anno.
- **Togliere l'accesso**: cancella (o cambia) il suo codice in `INVITI`. Quel telefono non potrà più far leggere documenti; le sue scadenze restano sue.
- Chi ha perso il link può anche scrivere il codice a mano in **Aiuto**.

**Limite di letture**: ogni invito può far leggere 20 cose al giorno; poi si ricomincia il giorno dopo. Per cambiarlo aggiungi su Render la variabile `LIMITE_GIORNALIERO` (per esempio `10`). È la protezione del tuo credito di Claude, insieme al tetto di spesa mensile da impostare su console.anthropic.com.

## 3. Installarla sul telefono
- **Android (Chrome)**: apri il link d'invito, poi **Aiuto → Installa l'app**, oppure menu ⋮ → **Installa app**.
- **iPhone (Safari)**: apri il link d'invito in Safari → Condividi → **Aggiungi alla schermata Home**.

## Cose da sapere
- **Modello**: quello predefinito è `claude-sonnet-5-5`, il più capace nel leggere le foto. Per spendere meno aggiungi su Render `CLAUDE_MODEL` con un modello più leggero.
- **Foto**: vengono rimpicciolite sul telefono prima di partire, così viaggiano veloci. PDF fino a 6 MB.
- **Dati sensibili**: Claude riceve la foto o il testo per spiegarli. Nella risposta codice fiscale e IBAN vengono oscurati.
- **Lettere**: a Claude arrivano solo il tipo di contratto, il nome del fornitore e quello che si scrive nel riquadro. Nome, indirizzo e codice cliente stanno solo sul telefono (in **Aiuto → I tuoi dati per le lettere** e nel contratto) e l'app li inserisce nella lettera dopo che è arrivata. Ogni lettera conta come una lettura nel limite giornaliero.
- **Aggiornamenti**: quando pubblichi una versione nuova, l'app installata si aggiorna da sola alla prima apertura (si ricarica una volta).
- **Cambio telefono**: in **Aiuto → Salva una copia** si scarica un file con scadenze e storico; sul telefono nuovo **Riprendi da una copia**.
- **Se qualcosa non va**: su Render, scheda **Logs**. Il server non scrive mai il contenuto dei documenti nei log.

## Provarla sul PC
Crea un file `.env` copiando `.env.example` con i tuoi valori, poi:
```
npm install
npm start
```
e apri http://localhost:3000/entra?invito=IL-TUO-CODICE
