# Come si accende il ponte

Il ponte è il pezzo che parla con Capital.com al posto dell'app. Vive su
Cloudflare, gratis, e tiene le tue chiavi come segreti: nel repository, che è
pubblico, non finisce niente.

Serve un quarto d'ora. Due strade per la stessa cosa: la **A** si fa tutta dal
browser, la **B** è per chi ha già un terminale aperto.

> **Sola lettura.** Il ponte sa leggere prezzi, mercati, posizioni e conto. Non
> sa aprire, chiudere o modificare niente: nel codice non c'è una riga che lo
> faccia. Mirino ti dice cosa fare, il dito sul tasto resta il tuo.

---

## 0. La chiave API di Capital.com

1. Su Capital.com attiva l'**autenticazione a due fattori** (senza, la chiave API non si può creare).
2. **Impostazioni › Integrazioni API › Genera chiave**. Ti chiede un nome e una
   **password personalizzata**: è la password *della chiave*, non quella del conto.
   Scrivila da qualche parte, non la rivedi più.
3. Ti servono tre cose:

| cosa | dove la metti |
|---|---|
| la chiave API | `CAPITAL_API_KEY` |
| l'email con cui entri su Capital.com | `CAPITAL_LOGIN` |
| la password della chiave | `CAPITAL_PASSWORD` |

**Parti dal conto demo.** Il ponte usa il server demo finché `CAPITAL_DEMO` non
vale `0`. Quando hai visto per un paio di settimane cosa dice, passi al reale.

---

# Strada A — dal browser

## A1. L'account Cloudflare

dash.cloudflare.com → registrati. Email e password, niente carta.

## A2. Il deposito

**Storage & Databases › KV › Create** con il nome `MEMORIA`.

Qui il ponte ricorda due cose per posizione: come leggerla (il rischio iniziale,
se hai già preso metà) e l'ultimo avviso mandato, per non ripetertelo ogni
minuto. Senza deposito l'app funziona lo stesso, ma gli avvisi su Telegram restano spenti.

## A3. Il Worker

**Compute › Workers & Pages › Create › Start with Hello World › Deploy**.
Chiamalo `mirino`.

Poi **Edit code**: cancella tutto quello che c'è nell'editor e incolla il
contenuto di [`server/worker.js`](worker.js). Lo apri su GitHub, premi **Raw**,
selezioni tutto e copi. Poi **Deploy**.

> Incolla `worker.js`, non `ponte.js`. Il primo è il secondo con il motore
> dell'app cucito sopra: senza, gli avvisi non saprebbero cosa consigliare.

## A4. Il deposito attaccato al Worker

**Settings › Bindings › Add › KV namespace**:

| Variable name | KV namespace |
|---|---|
| `MEMORIA` | il deposito MEMORIA |

## A5. I segreti

**Settings › Variables and Secrets › Add**, tipo **Secret**, uno per riga:

| nome | cos'è |
|---|---|
| `CAPITAL_API_KEY` | la chiave API |
| `CAPITAL_LOGIN` | l'email di Capital.com |
| `CAPITAL_PASSWORD` | la password della chiave API |
| `CHIAVE` | il codice d'accesso che metterai nell'app. Una riga lunga e a caso |
| `TELEGRAM_TOKEN` | facoltativo, vedi sotto |
| `TELEGRAM_CHAT` | facoltativo, vedi sotto |

Per la `CHIAVE`, se non sai da dove prenderla: apri una scheda nuova, F12 › Console, e incolla

```js
crypto.randomUUID() + crypto.randomUUID()
```

E due variabili normali (tipo **Text**, non Secret):

| nome | valore |
|---|---|
| `CAPITAL_DEMO` | `1` per il demo, `0` per il conto reale |
| `ORIGINI` | non serve: senza, vale `https://w8997wnwy5-collab.github.io`. Serve solo se l'app cambia indirizzo |

## A6. L'orologio degli avvisi

**Settings › Triggers › Cron Triggers › Add**: `* * * * *` (ogni minuto).

## A7. Prova

Apri l'indirizzo del Worker (`https://mirino.<tuonome>.workers.dev`). Deve dire:

```
Mirino · il ponte verso Capital.com e' acceso (conto demo).
```

Poi nell'app: scheda **Ponte**, incolli indirizzo e `CHIAVE`, **Collega**. In
alto compare `DEMO` (o `REALE`) al posto di `ESEMPIO`.

---

# Strada B — dal terminale

```bash
cd server
npx wrangler login
npx wrangler kv namespace create MEMORIA     # copia l'id in wrangler.toml
npx wrangler secret put CAPITAL_API_KEY
npx wrangler secret put CAPITAL_LOGIN
npx wrangler secret put CAPITAL_PASSWORD
npx wrangler secret put CHIAVE
npx wrangler secret put TELEGRAM_TOKEN       # facoltativo
npx wrangler secret put TELEGRAM_CHAT        # facoltativo
npx wrangler deploy
```

Ogni volta che cambi `motore.js` o `server/ponte.js`:

```bash
node tools/cuci_worker.js && cd server && npx wrangler deploy
```

---

# Gli avvisi su Telegram

Con l'app aperta, i consigli li vedi sullo schermo. Con l'app in tasca il
telefono addormenta tutto: per questo gli avvisi veri li manda il ponte.

1. Su Telegram scrivi a **@BotFather** › `/newbot` › un nome qualunque. Ti dà un
   token tipo `123456:ABC-…`: è `TELEGRAM_TOKEN`.
2. Scrivi un messaggio qualsiasi al tuo bot (*Avvia*).
3. Apri `https://api.telegram.org/bot<TOKEN>/getUpdates` nel browser: dentro
   c'è `"chat":{"id":123456789,…}`. Quel numero è `TELEGRAM_CHAT`.
4. Mettili fra i segreti del Worker, poi nell'app: **Ponte › Manda un messaggio di prova**.

Da lì, ogni minuto, il ponte guarda le posizioni aperte (quelle su Capital.com e
quelle che hai segnato a mano nell'app) e ti scrive quando il consiglio cambia:

```
ESCI · NVIDIA lungo
Il segnale si e' girato contro di te: punteggio -35.

Prezzo 186.20 · -0.40R · -48.00 USD
Stop 181.50 · obiettivi 195.20 / 207.80
```

Un avviso per cambio, non uno al minuto: il ponte si ricorda l'ultimo che ti ha
mandato. A mercato chiuso tace.

**E gli ingressi.** Nello stesso giro il ponte guarda **un mercato della lista**,
a rotazione: con 18 mercati ognuno viene controllato circa ogni 18 minuti. Tutti
insieme ogni minuto non ci starebbero nei 10 ms di calcolo del piano gratuito, e
per chi gioca sulle giornaliere un quarto d'ora non cambia niente. Quando uno
diventa pronto per il tuo profilo ti scrive l'ordine, calcolato come nell'app:

```
ENTRA · Tesla lungo · grado A (+55)
Compra 6 a mercato, circa 436.97.
Stop 399.06 · obiettivi 493.85 / 569.68
Rischio 182 CHF · margine 419 CHF (leva 5:1)
Spinge e non e' ancora tirato: il momento e' adesso.
```

Il link in fondo apre il piano di quel mercato nell'app. Non ti scrive se il
mercato è chiuso, se sei già dentro, se hai già tutti i colpi del profilo aperti,
se te l'ha già detto nelle ultime 12 ore (3 in intraday) o se il budget non
arriva alla taglia minima. Budget, profilo e lista li prende dall'app: aprila
collegata almeno una volta. Si spengono da **Ponte › Solo uscite**.

---

## I conti (piano gratuito)

| | limite gratuito | Mirino ne usa |
|---|---|---|
| richieste al Worker | 100'000 al giorno | ~1'500 (un giro al minuto + l'app) |
| tempo di calcolo | 10 ms a richiesta | 1–2 ms a posizione, più un mercato della lista a giro |
| scritture KV | 1'000 al giorno | una manciata: solo quando un consiglio cambia o arriva un avviso d'ingresso |
| domande a Capital.com | 10 al secondo | 3 alla volta dall'app, le candele restano in memoria |

## Se qualcosa non va

- **«Capital.com rifiuta le credenziali»**: quasi sempre è la password. Ci va
  quella della *chiave API*, non quella con cui entri nel conto. Poi: la chiave
  è del conto giusto? Con `CAPITAL_DEMO = 1` il ponte parla con il server demo.
- **«Credenziali giuste, ma sul server demo non hai un conto attivo»** (`error.null.accountId`):
  Capital.com ti fa entrare ma non trova un conto su quel server. Apri il conto
  demo su Capital.com, oppure aggiungi la variabile `CAPITAL_DEMO` = `0` (tipo
  Text) per collegare il conto reale. Il ponte resta in sola lettura.
- **Entri su Capital.com con Apple o Google**: in `CAPITAL_LOGIN` va l'email
  che trovi in *Impostazioni › Profilo* su Capital.com (con "Nascondi la mia
  email" di Apple è un indirizzo `…@privaterelay.appleid.com`). La password è
  sempre quella della chiave API.
- **«Il ponte non risponde»**: l'indirizzo deve essere quello del Worker
  (`https://…workers.dev`), senza niente dopo. Aprilo nel browser: deve dire
  *il ponte è acceso*.
- **«Codice d'accesso sbagliato»**: la `CHIAVE` nell'app deve essere identica
  al segreto. Dopo dodici tentativi sbagliati lo stesso indirizzo aspetta un'ora.
- **L'app dice che collega ma poi «Percorso non ammesso»**: hai incollato una
  versione vecchia di `worker.js`. Ricopialo da GitHub.
- **Nessun avviso su Telegram**: nell'app, scheda **Ponte**, c'è scritto cosa
  manca (token, chat o deposito). Il messaggio di prova dice se il bot risponde.
  Ricordati di scrivere almeno una volta al bot, altrimenti Telegram non lo lascia parlare.
- **Un mercato «non trovato»**: il nome (epic) su Capital.com è diverso, o sul
  tuo conto quello strumento non c'è. Toglilo e cercalo dalla scheda **Ponte › Cerca**.
