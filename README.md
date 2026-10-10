<img src="icon.svg" width="72" align="left" alt="">

# Mirino

### Leva alta, mira stretta.

<br clear="left">

Un'app che legge i mercati di **Capital.com** e ti dice dove giocare, quando
entrare, quanto mettere e — la parte che conta, a leva — **quando uscire**.

Gli dici quanto vuoi mettere in gioco. Lei guarda indici e titoli, sceglie i
colpi, li dimensiona sulla leva del tuo conto e, quando entri, ti segue: tieni,
sposta lo stop, prendi metà, rinforza, esci. Se l'app è chiusa, te lo scrive su
Telegram — e ti scrive anche quando un mercato della lista è pronto per entrare,
con l'ordine già calcolato.

E se vuoi che faccia tutto da solo, c'è **il robot**: premi *Avvia* e apre e
chiude posizioni sul tuo conto, con il profilo **Estremo**, finché non lo fermi
tu o finché non arriva alla **perdita massima** che hai scelto. Lì si ferma e
chiude tutto.

Il profilo di partenza è **medio-alto**: il 4% del budget a colpo, segnali A e B,
fino a tre colpi aperti. Non è prudente, e non vuole esserlo. Ma ogni colpo ha
uno stop, e ogni numero che l'app mostra viene da quello che le stesse regole
avrebbero fatto sulla storia vera, con lo spread vero.

Per provarla subito con dati inventati: `https://w8997wnwy5-collab.github.io/capital_com/?esempio`

---

## Leggi prima questo

**Nessuna app sa dove va il mercato.** Mirino non lo sa. Quello che fa è più
piccolo e più onesto:

- applica sempre le stesse regole, senza paura e senza noia;
- dimensiona ogni colpo sul **rischio**, non sulla speranza: se lo stop scatta
  perdi quello che avevi deciso, non di più;
- ti dice **quanto hanno reso quelle regole in passato**, sui mercati che giochi,
  e quanto è probabile che sia stata fortuna.

Le regole di trend e momento sono l'unica regolarità dei mercati azionari che
regge su cent'anni di dati, e anche lì il vantaggio non è grande. A leva, un
periodo storto costa il doppio. Gioca solo soldi che puoi permetterti di perdere
tutti. I numeri d'esempio nell'app sono **inventati** e lo dicono.

---

## Cosa fa

| Scheda | Cosa ci trovi |
|---|---|
| **Radar** | Il vento del mercato (S&P 500 sopra o sotto le medie) e tutti i mercati della lista in ordine: chi è pronto, chi quasi, chi è fermo. Per ognuno direzione, grado, punteggio, quando entrare (*Entra ora*, *Limite 182.40*, *Se rompe 190.10*), la folla di Capital.com e com'è andata la sua storia. Sotto, dove si muove Capital.com oggi. |
| **Colpo** | Un solo campo — quanto vuoi mettere — e da lì tutto: il piano dei colpi di adesso con rischio e margine totali, e per ogni mercato l'ordine esatto da fare su Capital.com, stop, due obiettivi, rischio in franchi, margine con la tua leva, quante volte segnali così sono andati bene, dove può stare il prezzo fra una settimana, e perché. |
| **Robot** | *Avvia* e *Ferma*. Apre e chiude da solo, anche con l'app chiusa: perdita dall'avvio contro il tetto, le sue posizioni, cosa ha fatto, le stesse regole rigiocate sulla storia. Da Telegram: `/stato`, `/stop`, `/chiudi`. |
| **In gioco** | Le posizioni aperte: quelle su Capital.com le vede da solo, appena le apri. Per ognuna il consiglio di adesso, in grande, con il motivo. Sotto, il libro delle chiuse. |
| **Precisione** | Le stesse regole rigiocate sugli ultimi quattro anni di ogni mercato: colpi, vinti, R medio, il periodo peggiore, la curva colpo dopo colpo. Detto in italiano prima che in numeri, compreso *potrebbe essere fortuna* quando lo è. |
| **Ponte** | Il collegamento a Capital.com, la lista dei mercati (si cerca e si aggiunge qualunque cosa quoti Capital.com), gli avvisi. |

## Come decide

### Il punteggio

Sette letture, ciascuna fra −1 e +1, pesate in un punteggio da −100 a +100.
Sopra zero il mercato spinge su, sotto spinge giù.

| Lettura | Peso | Cosa guarda |
|---|---|---|
| Trend | 28% | prezzo rispetto alle medie a 20, 50 e 200, e la pendenza della 50 |
| Momento | 24% | rendimento di 20 e 60 periodi, diviso per quanto il titolo si muove di solito |
| Accelerazione | 10% | l'istogramma del MACD |
| Rottura | 14% | chiusura sopra il massimo (o sotto il minimo) delle 20 candele prima, meglio con volumi |
| Estensione | 10% | **contro**: RSI oltre 75 o prezzo a più di 2 ATR dalla media frenano |
| Forza relativa | 8% | il titolo rispetto all'indice di riferimento |
| Indice | 6% | l'indice di riferimento in trend o no |
| Folla | 8% | la percentuale di clienti Capital.com lunghi, **letta al contrario** |

L'ADX fa da manopola: in un mercato senza direzione trend e momento pesano
poco più della metà. Grado **A** da 55, **B** da 40, **C** da 28.

I pesi non sono stati ottimizzati sui dati, apposta: un punteggio tarato sul
passato vince sempre sul passato e basta.

### Quando entrare

La direzione la dice la scala lunga, il momento la scala corta.

- **Entra ora**: spinge e non è tirato, o ha appena finito di ritracciare.
- **Limite**: il prezzo è scappato (RSI alto sulla scala corta): ordine in attesa
  verso la media. Entrare più in basso vuol dire uno stop più vicino a parità di rischio.
- **Se rompe**: è a un passo dal massimo di 20 candele. Ordine stop appena sopra:
  si entra solo se rompe davvero.

Tre stili: **Swing** (segnale sulle giornaliere, momento sulle orarie, da qualche
giorno a tre settimane), **Intraday** (orarie e quarti d'ora, fuori prima della
chiusura) e **Rapido**, il mordi e fuggi con una ragione: sui quarti d'ora
compra la discesa dentro una salita (e vende il rimbalzo dentro una discesa),
incassa tutto a +1R, mai più di un'ora dentro, fuori prima di sera.

### Quanto mettere

| Profilo | Rischio a colpo | Gradi | Colpi aperti | Margine massimo |
|---|---|---|---|---|
| Deciso | 2.5% del budget | A | 3 | 50% |
| **Aggressivo** (predefinito) | **4%** | **A, B** | **3** | **65%** |
| Spinto | 6% | A, B, C | 4 | 85% |

Un B rischia tre quarti di un A, un C la metà. La taglia è
`rischio ÷ distanza dello stop`, arrotondata in giù al passo di Capital.com. La
**leva** del tuo conto (letta da Capital.com, per tipo di strumento) decide solo
quanto margine ti blocca: la perdita la decide lo stop. L'app ti dice anche
dove Capital.com ti chiuderebbe senza stop e quanto costano le notti.

### Quando uscire

Una regola sola, usata uguale dal piano, dal consiglio e dal backtest:

| Quando | Cosa |
|---|---|
| sempre | stop iniziale a **1.5 ATR** dall'entrata. R = quella distanza |
| a +1R | lo stop va a **pareggio** |
| a +1R con segnale ancora A, prima del primo incasso | si può **rinforzare** di metà |
| a +1.5R | si **chiude metà** |
| dopo | lo stop **insegue** a 2.5 ATR dal massimo |
| a +3.5R | si **incassa** il resto |
| se il segnale si gira | (grado C dall'altra parte) si **esce**, anche in guadagno |
| candela violenta contro | si esce senza aspettare lo stop |
| intraday e rapido, 20 minuti alla chiusura | fuori |

Il **Rapido** ha regole sue e non usa il punteggio. Entra solo con un trend
chiaro (prezzo sopra la media di circa 50 ore e la media che sale, o il
contrario) e dopo una discesa di almeno 2 ATR sotto la media corta; salta i
mercati dove lo spread supera il 10% dell'ATR. Stop a 1.2 ATR, tutto a +1R,
al massimo quattro quarti d'ora, niente pareggio e niente stop che insegue.

### Il Rapido sui dati veri

Prima di metterlo nel robot è stato misurato su sei anni di prezzi veri al
minuto (histdata, 2013-2018) di S&P 500, DAX, Euro Stoxx 50 e Nikkei, con lo
spread tipico di Capital.com e lo slittamento sugli stop. Le regole si
tarano sul 2013-2015 e si verificano sul 2016-2018 senza ritocchi; il codice
di ogni idea l'ha controllato un verificatore separato.

| Regola sui 15 minuti | 2016-2018, a colpo, con i costi |
|---|---|
| Il punteggio (il Rapido di prima) | −0.13R, 10-13 colpi al giorno per indice |
| Punteggio con filtri (sessione, trend orario, solo A, spread) | −0.035R |
| Rottura del range d'apertura, momento di fine giornata | −0.03R e −0.015R |
| "Chiudi appena sei in guadagno" (take profit a 0.5R) | sempre peggio: vinci il 55-58%, servirebbe il 66% |
| **Discesa di 2 ATR dentro un trend (il Rapido di adesso)** | **+0.024R** (+0.087R prima dei costi, su tutti e 4 gli indici); circa un colpo ogni 4-5 giorni per indice |

È la sola che regge, e regge poco: +0.024R a colpo non è una certezza
statistica. Sui quarti d'ora lo spread si mangia quasi tutto il vantaggio.

Il consiglio non ha memoria: si ricava tutto dal prezzo d'entrata e dalle
candele dopo. Così il telefono e il ponte arrivano alla stessa risposta senza parlarsi.

Su Capital.com l'incasso a metà si fa aprendo **due posizioni** da metà taglia,
con lo stesso stop e take profit diversi: l'app ti scrive le quantità esatte.

### Le probabilità

Vengono dal backtest, non da un'opinione: tutti i colpi che le regole avrebbero
fatto su tutti i mercati della lista, divisi per grado. Con pochi colpi la stima
viene tirata verso il *non so* (50%, 0R). Il cono di previsione usa quanto si è
mosso il prezzo, in passato, dopo segnali dello stesso grado: se la storia dice
zero, il centro resta sul prezzo di oggi e l'app lo scrive.

## Come si pubblica

1. **Settings › Pages** › *Deploy from a branch* › il ramo con questi file, cartella `/ (root)`.
   Dopo un minuto l'app è su `https://w8997wnwy5-collab.github.io/capital_com/`.
2. Sul telefono: Safari › *Condividi › Aggiungi alla schermata Home*.
3. Funziona subito con i dati d'esempio. Per i tuoi: il ponte, qui sotto.

## Il ponte

L'app è una pagina statica e pubblica: le chiavi di Capital.com lì dentro le
leggerebbe chiunque. Il ponte è un Worker su Cloudflare (gratis) che tiene le
chiavi come segreti, apre la sessione con Capital.com e passa all'app solo
quello che serve, da una lista di percorsi scritta nel codice. Quello che arriva
da fuori (l'app, il browser) può **solo leggere**. Le uniche scritture verso
Capital.com le fa il robot, quando lo accendi tu: aprire, spostare lo stop,
chiudere e, se lo chiedi all'avvio, alzare la leva al massimo. Non c'è un indirizzo del ponte che inoltri un ordine scelto da fuori.

Ogni minuto guarda le posizioni aperte e, se il consiglio cambia, ti scrive su
**Telegram**. Nello stesso giro guarda un mercato della lista, a rotazione, e se
è pronto per il tuo profilo ti manda l'ordine da fare. Usa lo stesso `motore.js`
dell'app, cucito dentro `server/worker.js`, e legge il segnale sulle stesse 400
candele dell'app: telefono e ponte non possono dare consigli diversi.

Istruzioni passo per passo: [`server/COME-SI-ACCENDE.md`](server/COME-SI-ACCENDE.md).

## Il robot

Vive nel ponte, non nel telefono: gira nel cron di ogni minuto, anche con l'app
chiusa. Il telefono lo accende, lo spegne e lo guarda.

| Cosa | Come |
|---|---|
| Profilo | **Estremo**: segnali A, B e C, fino a 10 posizioni |
| Quanto rischia | gioca per il massimo: si ragiona sulla **perdita massima**, non sul budget del Colpo. Un A rischia un terzo del tetto, un B un quarto, un C un sesto (con 60 CHF: 20, 15, 10). La taglia minima di Capital.com va bene fino a metà del tetto |
| Leva | se lo scegli all'avvio, il robot alza la leva al **massimo che Capital.com ti concede** per ogni tipo di strumento. Con un conto piccolo è il margine (ne usa fino al 95%) moltiplicato per la leva a decidere quanto è grande una posizione |
| Stile | quello che scegli prima di *Avvia*. **Rapido**: compra la discesa dentro una salita sui quarti d'ora, take profit a +1R, al massimo un'ora; rientra sullo stesso mercato dopo un quarto d'ora |
| Quando entra | a rotazione, uno o due mercati della lista al minuto; solo se il segnale è pronto **e** il momento è "entra ora" (mai a prezzo scappato) |
| Protezione | ogni posizione nasce con **stop loss** e **take profit** già su Capital.com: se il ponte si ferma, restano |
| Gestione | stop a pareggio, poi lo stop che insegue; esce se il segnale si gira, dopo il tempo massimo, prima della chiusura. Una posizione sola per colpo: niente metà |
| Perché non entra | nella scheda Robot, *Cosa sta guardando*: per ogni mercato il punteggio e il motivo (nessun segnale, prezzo scappato, chiuso, margine finito…). Su Telegram: `/stato` |
| Il cron gira? | *Avvia* scrive un comando che applica il giro del minuto: è lui che manda **ROBOT ACCESO** su Telegram. Se l'app resta su *Si sta accendendo* più di due minuti, su Cloudflare manca il Cron Trigger, e l'app lo dice |
| Tetto | non mette mai a rischio più di quanto resta della **perdita massima**; se la perdita dall'avvio la raggiunge, si ferma e chiude tutto. Il tetto conta da quando premi *Avvia* e guarda tutto il conto |
| Ferma | *Ferma*: non apre più niente, le posizioni aperte le porta a fine. *Ferma e chiudi tutto*: chiude subito. Da Telegram `/stop` e `/chiudi` |
| Le tue posizioni | non le tocca |

Con un conto piccolo il margine decide quante posizioni apre davvero: il robot ne
usa al massimo il 90%. Il tetto ferma le perdite normali; un buco di prezzo (una notizia,
l'apertura del lunedì) può superarlo di quel tanto che nessuno stop può fermare.

## Come è verificato

```bash
node tools/test_motore.js      # 91 controlli sul motore
node tools/test_ponte.mjs      # 100 controlli sul ponte, con un Capital.com finto che accetta ordini
node tools/cuci_worker.js      # ricuce server/worker.js dopo ogni modifica
```

| Verifica | Esito |
|---|---|
| EMA, RSI, ATR contro un'implementazione scritta a parte | scarto 0 |
| Il punteggio alla candela t, tagliando la storia a t (anche l'indice) | identico: nessuno sguardo nel futuro |
| Passeggiata a caso senza costi, 6'500 colpi (anche con le regole del robot) | R medio −0.01 e −0.02, t = −0.7 e −1.2: compatibile con zero, come deve |
| Il Rapido sui dati veri 2016-2018 (vedi sopra), rifatto dal motore del progetto | 641 colpi, +0.024R a colpo: identico alla verifica indipendente |
| Ogni prezzo d'entrata e d'uscita del backtest dentro la sua candela | 0 fuori su 13'000 |
| Aggiungere lo spread | il risultato peggiora, mai migliora |
| Il ponte: percorsi non in lista, scritture verso Capital.com, altri siti, codici sbagliati | tutti respinti |
| Il ponte: stesso consiglio due minuti di fila | nessun secondo messaggio, nessuna scrittura |
| Il ponte: avvisi d'ingresso su un giro della lista | esattamente i mercati che l'app chiama pronti, con la stessa taglia e lo stesso stop |
| Il robot: ogni ordine | nasce con stop loss e take profit dalla parte giusta del prezzo |
| Il robot: rischio e margine | rischio di tutte le posizioni sotto il tetto, margine sotto il disponibile |
| Il robot: doppioni, stop, chiusure di Capital.com | nessun doppione; stop a pareggio una volta sola; si accorge delle chiusure |
| Il robot: tetto di perdita | si ferma, chiude tutto e non apre più niente |
| Il robot: comandi Telegram | solo dalla tua chat, con percorso e intestazione segreti |
| Il robot: un Ferma durante un giro, o un attimo prima di un ordine | non si perde: il giro dopo lo applica, l'ordine non parte |
| Il robot: ordine partito senza conferma | lo stato è salvato prima dell'ordine; il giro dopo adotta la posizione, senza un secondo ordine |
| Il robot: ordine rifiutato | l'errore si scrive una volta, quel mercato si lascia stare mezz'ora |
| Il robot: scritture in KV | con niente da fare, una ogni cinque minuti |

Il test sulla passeggiata a caso è quello decisivo: su un mercato senza memoria
nessuna regola può guadagnare. Se il backtest dicesse il contrario, starebbe barando.
E una volta barava: faceva uscire gli stop esattamente sul livello, e su campioni
grandi questo inventava +0.03/+0.06R a colpo. Adesso ogni stop preso dentro la
candela paga 0.05 ATR di slittamento, e il test usa candele quasi continue.

Il backtest considera spread vero di ogni candela, buchi d'apertura (si esce
all'apertura, non allo stop), slittamento sugli stop, lo stop prima
dell'obiettivo quando nella stessa candela ci sono tutti e due, e le notti. Non
considera le trimestrali e le notizie: l'app lo dice nella scheda Precisione.

## Come è fatta

```
index.html              l'app: radar, colpo, robot, in gioco, precisione, ponte
motore.js               il motore: indicatori, punteggio, piano, consiglio, backtest. Niente DOM
esempio.js              un Capital.com finto per provare senza chiavi, stesse risposte di quello vero
sw.js, manifest.webmanifest, icon.svg     l'app sul telefono
server/ponte.js         il Worker: sessione Capital.com, percorsi ammessi, avvisi Telegram, il robot
server/worker.js        ponte.js con il motore cucito sopra: e' il file da incollare su Cloudflare
server/wrangler.toml    per chi pubblica il Worker dal terminale
server/COME-SI-ACCENDE.md
tools/test_motore.js, tools/test_ponte.mjs, tools/cuci_worker.js
```

Fonti dei dati, tutte da Capital.com attraverso il ponte: candele con bid e ask
(`/prices`), mercati, regole di negoziazione e orari (`/markets`), sentiment dei
clienti (`/clientsentiment`), posizioni aperte (`/positions`), conto e leve
(`/accounts`), i mercati che si muovono di più (`/marketnavigation`).

## Sicurezza

- Nel repository non c'è nessun segreto. Le chiavi di Capital.com e di Telegram stanno solo nei segreti del Worker.
- Il ponte risponde solo con il codice d'accesso, solo all'indirizzo dell'app, e dopo dodici codici sbagliati blocca quell'indirizzo per un'ora.
- Dal ponte non passa nessun ordine scelto da fuori: le scritture verso Capital.com sono solo quelle del robot (aprire, spostare lo stop, chiudere). Chi rubasse il codice d'accesso potrebbe accendere o spegnere il robot, non fare un ordine suo.
- I comandi del robot su Telegram funzionano solo dalla tua chat, su un percorso segreto e con un'intestazione segreta derivati dalla `CHIAVE`.
- Budget, lista, posizioni segnate a mano e libro stanno solo nel browser del telefono.

## Se qualcosa non va

- **Scritto `ESEMPIO` in alto**: l'app non è collegata. Scheda **Ponte**, indirizzo e codice, **Collega**.
- **Un mercato «non letto»**: sul tuo conto quell'epic non esiste o ha un nome diverso. Toglilo e cercalo da **Ponte › Cerca**.
- **Nessuna posizione in *In gioco*, ma su Capital.com ce l'hai**: controlla che il ponte sia sul conto giusto (`CAPITAL_DEMO`: `1` demo, `0` reale).
- **Il consiglio sul telefono e quello su Telegram non coincidono**: lo stile (Swing, Intraday o Rapido) si cambia dall'app, che lo passa al ponte per le posizioni aperte. Le posizioni aperte *prima* di collegare la memoria il ponte le legge con lo stile predefinito, Swing.
- **Gli avvisi arrivano solo con l'app aperta**: quelli del telefono sì, è il telefono che addormenta le app. Quelli sicuri sono su Telegram.
- **La scheda Robot dice "ponte vecchio"**: ricopia `server/worker.js` su Cloudflare (Edit code › incolla › Deploy).
- **Il robot è acceso ma non apre niente**: scheda Robot, *Cosa sta guardando*: per ogni mercato c'è il motivo. Di solito: nessun segnale pronto, prezzo scappato, mercato chiuso, margine finito. Se in alto c'è un avviso rosso «il robot non gira», manca l'orologio (Cron Trigger `* * * * *`) su Cloudflare.
- Tutto il resto del ponte: [`server/COME-SI-ACCENDE.md`](server/COME-SI-ACCENDE.md#se-qualcosa-non-va).

## Avvertenza

Il trading di CFD a leva comporta un rischio alto di perdere denaro in fretta.
Un robot che apre e chiude da solo lo fa senza chiederti niente. Questo software
è fornito senza garanzie e non è una consulenza finanziaria. Usa solo capitale che
puoi permetterti di perdere integralmente, e scegli una perdita massima che sei
disposto a perdere tutta.
