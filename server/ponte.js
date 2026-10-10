/* Il ponte.
   ══════════════════════════════════════════════════════════════════════════
   L'app sta su GitHub Pages, che e' un sito statico e pubblico: le chiavi di
   Capital.com li' dentro le leggerebbe chiunque. Per questo esiste questo
   pezzo. Vive su Cloudflare, tiene le chiavi come segreti, apre la sessione
   con Capital.com e passa all'app i dati che servono. E SOLO quelli.

   Tre scelte che vale la pena avere scritte accanto al codice:

     SOLA LETTURA, TRANNE IL ROBOT. Tutto quello che arriva da fuori (l'app,
     il browser) puo' solo leggere: prezzi, mercati, posizioni, conto. Le
     uniche scritture verso Capital.com — aprire, spostare lo stop, chiudere
     e, se lo chiedi all'avvio, alzare la leva al massimo — le fa il robot,
     da solo, con le regole del motore, e solo quando lo accendi tu. Non esiste un indirizzo del ponte che inoltri un ordine
     scelto da fuori: chi rubasse il codice d'accesso potrebbe accendere o
     spegnere il robot, non fare un ordine suo. Il robot ha un tetto di
     perdita: arrivato li' si ferma da solo e chiude tutto.

     UNA LISTA DI PERCORSI AMMESSI. Non un proxy generico: ogni percorso di
     Capital.com che passa di qui e' scritto in PERCORSI, e i parametri pure.

     GLI AVVISI. Ogni minuto il ponte guarda le posizioni aperte e chiede al
     motore lo stesso consiglio che vedi sul telefono. Quando cambia (esci,
     prendi meta', sposta lo stop...) ti scrive su Telegram. Nello stesso
     giro guarda un mercato della lista, a rotazione, e se e' pronto per il
     tuo profilo ti scrive l'ordine da fare. Il motore e'
     lo stesso file dell'app, cucito qui sopra da tools/cuci_worker.js:
     telefono e ponte non possono dare consigli diversi.

   Endpoint (tutti con  Authorization: Bearer <CHIAVE>):
     GET  /api/stato               il ponte e' acceso? demo o reale? avvisi?
     GET  /api/cap/<percorso>      un percorso di Capital.com, in lettura
     GET  /api/impostazioni        budget, profilo e lista per gli avvisi d'ingresso
     POST /api/impostazioni        li manda l'app quando cambiano
     GET  /api/segui               le posizioni che il ponte sorveglia
     POST /api/segui               come sorvegliarne una (stile, rischio, ...)
     DELETE /api/segui/<id>        smetti di sorvegliarla
     POST /api/telegram/prova      un messaggio di prova
     GET  /api/robot               il robot: acceso?, comando in attesa, conto,
                                   posizioni, diario, cosa ha guardato, ultimo giro
     POST /api/robot/avvia         accendilo (stile, tetto di perdita, posti): lo
                                   applica il giro del cron, entro un minuto
     POST /api/robot/ferma         spegnilo; {chiudi: true} chiude anche tutto
   Senza codice, ma con un segreto nel percorso e uno nell'intestazione:
     POST /tg/<segreto>            i comandi da Telegram: /stato /stop /chiudi
   ══════════════════════════════════════════════════════════════════════════ */

const VERSIONE = '2.1';
const SERVER_REALE = 'https://api-capital.backend-capital.com';
const SERVER_DEMO = 'https://demo-api-capital.backend-capital.com';
const ORIGINI_PREDEFINITE = 'https://w8997wnwy5-collab.github.io';
const APP_PREDEFINITA = 'https://w8997wnwy5-collab.github.io/capital_com/';

/* Capital.com chiude la sessione dopo dieci minuti senza richieste. Si
   rinnova a otto, prima che lo faccia lei. */
const SESSIONE_MS = 8 * 60000;
/* Quanto si aspetta una risposta prima di lasciar perdere. Senza, una
   richiesta che non torna terrebbe il giro appeso fino a quando Cloudflare
   lo chiude, e con lui il blocco "un giro alla volta". */
const ATTESA_MS = 20000;

/* I percorsi ammessi, con quanto si possono tenere in memoria (secondi).
   Le posizioni e il conto mai: sono la cosa che deve essere vera adesso. */
const PERCORSI = [
  { re: /^markets$/,                            cache: 3,   query: ['epics', 'searchTerm'] },
  { re: /^markets\/[A-Za-z0-9._-]{1,40}$/,      cache: 60,  query: [] },
  { re: /^prices\/[A-Za-z0-9._-]{1,40}$/,       cache: -1,  query: ['resolution', 'max', 'from', 'to'] },
  { re: /^clientsentiment$/,                    cache: 300, query: ['marketIds'] },
  { re: /^clientsentiment\/[A-Za-z0-9._-]{1,40}$/, cache: 300, query: [] },
  { re: /^positions$/,                          cache: 0,   query: [] },
  { re: /^workingorders$/,                      cache: 0,   query: [] },
  { re: /^accounts$/,                           cache: 0,   query: [] },
  { re: /^accounts\/preferences$/,              cache: 600, query: [] },
  { re: /^marketnavigation$/,                   cache: 600, query: [] },
  { re: /^marketnavigation\/[A-Za-z0-9._-]{1,80}$/, cache: 300, query: ['limit'] }
];
/* Le candele si tengono tanto quanto sono lunghe: una giornaliera non cambia
   in un minuto, un quarto d'ora si'. */
const CACHE_PREZZI = { DAY: 600, WEEK: 1800, HOUR_4: 300, HOUR: 120, MINUTE_30: 60, MINUTE_15: 30, MINUTE_5: 15, MINUTE: 10 };

/* ─────────────────────────── utilita' ─────────────────────────── */

function json(dati, stato = 200, extra = {}) {
  return new Response(JSON.stringify(dati), {
    status: stato,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

/* CORS: solo l'origine dell'app. Un asterisco qui vorrebbe dire che
   qualunque sito puo' far parlare il browser di chi passa con il ponte. */
function intestazioniCors(req, env) {
  const ammesse = (env.ORIGINI || ORIGINI_PREDEFINITE).split(',').map(s => s.trim()).filter(Boolean);
  const origine = req.headers.get('Origin') || '';
  if (!ammesse.includes(origine)) return null;
  return {
    'access-control-allow-origin': origine,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

/* Confronto a tempo costante: un confronto normale si ferma alla prima
   lettera diversa, e il tempo che ci mette dice quante ne hai azzeccate. */
function uguali(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/* Tentativi sbagliati per indirizzo, in memoria. Non e' una cassaforte (ogni
   copia del Worker ha la sua memoria), e' un freno: dodici all'ora bastano a
   chi sbaglia a scrivere e rendono inutile provare a indovinare. */
const sbagli = new Map();
function bloccato(ip) {
  const s = sbagli.get(ip);
  return s && s.n >= 12 && Date.now() - s.da < 3600000;
}
function segnaSbaglio(ip) {
  const s = sbagli.get(ip);
  if (!s || Date.now() - s.da > 3600000) sbagli.set(ip, { n: 1, da: Date.now() });
  else s.n++;
  if (sbagli.size > 500) sbagli.clear();
}

function autorizzato(req, env) {
  if (!env.CHIAVE) return false;
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return !!m && uguali(m[1].trim(), env.CHIAVE);
}

function server(env) { return env.CAPITAL_DEMO === '0' || env.CAPITAL_DEMO === 'no' ? SERVER_REALE : SERVER_DEMO; }
function eDemo(env) { return server(env) === SERVER_DEMO; }

/* ─────────────────────────── Capital.com ─────────────────────────── */

let sessione = null;          /* { cst, token, usata } */
let aprendo = null;           /* una sola apertura alla volta */

async function apriSessione(env) {
  if (!env.CAPITAL_API_KEY || !env.CAPITAL_LOGIN || !env.CAPITAL_PASSWORD) {
    throw new ErroreCapital(500, 'Mancano i segreti CAPITAL_API_KEY, CAPITAL_LOGIN o CAPITAL_PASSWORD.');
  }
  const prova = async () => fetch(server(env) + '/api/v1/session', {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': env.CAPITAL_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: env.CAPITAL_LOGIN, password: env.CAPITAL_PASSWORD, encryptedPassword: false }),
    signal: AbortSignal.timeout(ATTESA_MS),
  });
  let r = await prova();
  /* Capital.com accetta un'apertura al secondo: se due copie del Worker ci
     provano insieme, la seconda aspetta e riprova una volta. */
  if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1100)); r = await prova(); }
  if (!r.ok) {
    let dettaglio = '';
    try { dettaglio = (await r.json()).errorCode || ''; } catch (e) { /* niente */ }
    throw new ErroreCapital(r.status === 401 || r.status === 400 ? 401 : 502, frase(dettaglio, r.status, env));
  }
  const cst = r.headers.get('CST'), token = r.headers.get('X-SECURITY-TOKEN');
  if (!cst || !token) throw new ErroreCapital(502, 'Capital.com ha aperto la sessione ma non ha mandato i gettoni.');
  sessione = { cst, token, usata: Date.now() };
  return sessione;
}

async function sessioneValida(env) {
  if (sessione && Date.now() - sessione.usata < SESSIONE_MS) return sessione;
  if (!aprendo) aprendo = apriSessione(env).finally(() => { aprendo = null; });
  return aprendo;
}

class ErroreCapital extends Error {
  constructor(stato, messaggio) { super(messaggio); this.stato = stato; }
}

/* I codici di errore di Capital.com, detti in italiano. */
function frase(codice, stato, env) {
  const c = String(codice || '');
  /* Le credenziali vanno bene, ma su questo server non c'e' un conto: capita
     a chi non ha mai aperto il conto demo, perche' il ponte parte dal demo. */
  if (/null\.accountId/.test(c)) {
    return env && eDemo(env)
      ? 'Credenziali giuste, ma sul server demo di Capital.com non hai un conto attivo (' + c + '). Apri il conto demo su Capital.com, oppure metti la variabile CAPITAL_DEMO = 0 nel Worker per usare il conto reale (il ponte e\' comunque in sola lettura).'
      : 'Credenziali giuste, ma il conto reale non risulta attivo per l\'API (' + c + '). Controlla che il conto sia verificato, oppure torna al demo con CAPITAL_DEMO = 1.';
  }
  if (/invalid\.details|invalid\.password|invalid\.api\.key|error\.null\.api\.key/.test(c)) {
    return 'Capital.com rifiuta le credenziali (' + c + '). Controlla email, chiave API e la PASSWORD DELLA CHIAVE (non quella del conto), e che la chiave sia del conto giusto: demo o reale.';
  }
  if (/too-many|rate/.test(c) || stato === 429) return 'Capital.com dice di rallentare (troppe richieste). Riprova fra qualche secondo.';
  if (/not-found\.epic|epic/.test(c)) return 'Mercato non trovato su Capital.com (' + c + ').';
  if (/not-found/.test(c)) return 'Capital.com non conosce questa richiesta (' + c + ').';
  return 'Capital.com ha risposto ' + stato + (c ? ' (' + c + ')' : '') + '.';
}

async function chiediCapital(env, percorso, query, tentativo = 0) {
  const s = await sessioneValida(env);
  const qs = query && [...query.keys()].length ? '?' + query.toString() : '';
  const r = await fetch(server(env) + '/api/v1/' + percorso + qs, {
    headers: { 'X-SECURITY-TOKEN': s.token, 'CST': s.cst },
    signal: AbortSignal.timeout(ATTESA_MS),
  });
  if (r.status === 401 && tentativo === 0) { sessione = null; return chiediCapital(env, percorso, query, 1); }
  if (r.status === 429 && tentativo === 0) {
    await new Promise(ok => setTimeout(ok, 600));
    return chiediCapital(env, percorso, query, 1);
  }
  if (r.ok) s.usata = Date.now();
  const testo = await r.text();
  let dati = null;
  try { dati = testo ? JSON.parse(testo) : {}; } catch (e) { dati = null; }
  if (!r.ok) throw new ErroreCapital(r.status === 404 ? 404 : 502, frase(dati && dati.errorCode, r.status, env));
  if (dati == null) throw new ErroreCapital(502, 'Capital.com ha risposto qualcosa che non e\' JSON.');
  return dati;
}

/* La memoria corta: niente Cache API, che sui *.workers.dev non funziona.
   Una mappa per copia del Worker basta: le candele giornaliere chieste da
   ventuno mercati due volte in un minuto non devono costare due giri. */
const memoria = new Map();
function dallaMemoria(chiave) {
  const m = memoria.get(chiave);
  if (!m) return null;
  if (Date.now() > m.scade) { memoria.delete(chiave); return null; }
  return m.dati;
}
function inMemoria(chiave, dati, secondi) {
  if (!(secondi > 0)) return;
  if (memoria.size > 300) memoria.delete(memoria.keys().next().value);
  memoria.set(chiave, { dati, scade: Date.now() + secondi * 1000 });
}

function regolaPer(percorso) { return PERCORSI.find(p => p.re.test(percorso)) || null; }

async function leggi(env, percorso, parametri) {
  const regola = regolaPer(percorso);
  if (!regola) throw new ErroreCapital(403, 'Percorso non ammesso: ' + percorso);
  const q = new URLSearchParams();
  for (const k of regola.query) {
    const v = parametri.get(k);
    if (v != null && v !== '') q.set(k, v.slice(0, 600));
  }
  let secondi = regola.cache;
  if (secondi < 0) secondi = CACHE_PREZZI[q.get('resolution') || 'MINUTE'] || 10;
  const chiave = percorso + '?' + q.toString();
  const vecchio = dallaMemoria(chiave);
  if (vecchio) return vecchio;
  const dati = await chiediCapital(env, percorso, q);
  inMemoria(chiave, dati, secondi);
  return dati;
}

/* ── le scritture ──

   Le uniche richieste che cambiano qualcosa sul conto. Le chiama solo il
   robot (giroRobot, fermaRobot), mai una richiesta dall'esterno: nessuna
   porta del ponte le inoltra. La lista qui sotto e' corta apposta. */
const SCRITTURE = [
  { metodo: 'POST',   re: /^positions$/ },                       /* apri */
  { metodo: 'PUT',    re: /^positions\/[A-Za-z0-9._-]{1,80}$/ },  /* sposta lo stop */
  { metodo: 'DELETE', re: /^positions\/[A-Za-z0-9._-]{1,80}$/ },  /* chiudi */
  { metodo: 'PUT',    re: /^accounts\/preferences$/ },           /* la leva al massimo, se l'hai chiesto all'avvio */
];

async function scriviCapital(env, metodo, percorso, corpo, tentativo = 0) {
  if (!SCRITTURE.some(w => w.metodo === metodo && w.re.test(percorso))) throw new ErroreCapital(403, 'Scrittura non ammessa: ' + metodo + ' ' + percorso);
  const s = await sessioneValida(env);
  const r = await fetch(server(env) + '/api/v1/' + percorso, {
    method: metodo,
    headers: { 'X-SECURITY-TOKEN': s.token, 'CST': s.cst, 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(ATTESA_MS),
  });
  /* 401 e 429 vogliono dire che Capital.com NON ha eseguito: si puo' riprovare
     una volta senza rischiare un ordine doppio */
  if (r.status === 401 && tentativo === 0) { sessione = null; return scriviCapital(env, metodo, percorso, corpo, 1); }
  if (r.status === 429 && tentativo === 0) { await new Promise(ok => setTimeout(ok, 1100)); return scriviCapital(env, metodo, percorso, corpo, 1); }
  if (r.ok) s.usata = Date.now();
  let dati = null;
  try { dati = await r.json(); } catch (e) { dati = null; }
  if (!r.ok) throw new ErroreCapital(r.status === 404 ? 404 : 502, frase(dati && dati.errorCode, r.status, env));
  return dati || {};
}

/* L'esito vero di un ordine: Capital.com risponde subito con un riferimento,
   e il risultato (accettato o rifiutato, e il numero della posizione) va
   chiesto a parte. Il numero della posizione aperta e' quello in
   affectedDeals con stato OPENED, non quello in testa. */
async function confermaDeal(env, riferimento) {
  for (let i = 0; i < 3; i++) {
    try { return await chiediCapital(env, 'confirms/' + encodeURIComponent(riferimento), new URLSearchParams()); }
    catch (e) { if (i === 2) throw e; await new Promise(ok => setTimeout(ok, 400 * (i + 1))); }
  }
  return null;
}

async function apriPosizione(env, epic, dir, dim, stop, tp) {
  const corpo = { epic, direction: dir > 0 ? 'BUY' : 'SELL', size: dim, guaranteedStop: false, trailingStop: false, stopLevel: stop };
  if (tp != null) corpo.profitLevel = tp;
  const r = await scriviCapital(env, 'POST', 'positions', corpo);
  if (!r.dealReference) throw new Error('Capital.com non ha dato un riferimento per l\'ordine.');
  const c = await confermaDeal(env, r.dealReference);
  if (!c || c.dealStatus !== 'ACCEPTED') throw new Error('Ordine rifiutato da Capital.com: ' + ((c && (c.reason || c.dealStatus)) || 'nessuna conferma'));
  const aperto = (c.affectedDeals || []).find(x => x.status === 'OPENED');
  return { id: aperto ? aperto.dealId : c.dealId, livello: +c.level || null, dim: +c.size || dim };
}

async function spostaStop(env, id, stop, tp) {
  const corpo = { guaranteedStop: false, trailingStop: false, stopLevel: stop };
  if (tp != null) corpo.profitLevel = tp;
  const r = await scriviCapital(env, 'PUT', 'positions/' + id, corpo);
  if (r.dealReference) {
    const c = await confermaDeal(env, r.dealReference).catch(() => null);
    if (c && c.dealStatus && c.dealStatus !== 'ACCEPTED') throw new Error('Stop rifiutato da Capital.com: ' + (c.reason || c.dealStatus));
  }
}

async function chiudiPosizione(env, id) {
  try {
    const r = await scriviCapital(env, 'DELETE', 'positions/' + id);
    if (r.dealReference) {
      const c = await confermaDeal(env, r.dealReference).catch(() => null);
      if (c && c.dealStatus && c.dealStatus !== 'ACCEPTED') throw new Error('Chiusura rifiutata da Capital.com: ' + (c.reason || c.dealStatus));
      return { ok: true, profitto: c && c.profit != null ? +c.profit : null, valuta: c && c.profitCurrency };
    }
    return { ok: true };
  } catch (e) {
    /* gia' chiusa (dallo stop, dal take profit o da te): va bene lo stesso */
    if (e instanceof ErroreCapital && e.stato === 404) return { ok: true, giaChiusa: true };
    throw e;
  }
}

/* ─────────────────────────── Telegram ─────────────────────────── */

async function telegram(env, testo) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT) return { ok: false, motivo: 'Telegram non configurato' };
  const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT, text: testo, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  }).catch(e => new Response(JSON.stringify({ ok: false, description: 'Telegram non risponde (' + e.message + ')' }), { status: 599 }));
  let d = {};
  try { d = await r.json(); } catch (e) { /* niente */ }
  return { ok: r.ok && d.ok !== false, motivo: d.description || (r.ok ? '' : 'Telegram ha risposto ' + r.status) };
}

function html(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* ─────────────────────────── la sorveglianza ───────────────────────────

   Nella memoria lunga (KV, MEMORIA) ci stanno:
     segui:<id>     come va letta una posizione: stile, R iniziale, se hai
                    gia' preso meta'. La scrive l'app quando premi "Sono
                    entrato" o cambi qualcosa; se non c'e', la scrive il ponte
                    la prima volta che vede la posizione, cosi' l'R non cambia.
     avviso:<id>    l'ultimo consiglio mandato, per non ripeterlo ogni minuto.
     impostazioni   budget, profilo, stile e lista, mandati dall'app: servono
                    agli avvisi d'ingresso.
     ingresso:<epic> l'ultimo avviso d'ingresso su quel mercato.

   Si scrive solo quando qualcosa cambia: il piano gratuito di KV concede
   mille scritture al giorno, e qui se ne fanno una manciata. */

async function leggiKV(env, chiave) {
  if (!env.MEMORIA) return null;
  try { return await env.MEMORIA.get(chiave, 'json'); } catch (e) { return null; }
}
async function scriviKV(env, chiave, valore) {
  if (!env.MEMORIA) return;
  await env.MEMORIA.put(chiave, JSON.stringify(valore), { expirationTtl: 60 * 86400 });
}

function daCapital(p) {
  const pos = p.position || {}, mk = p.market || {};
  const quando = pos.createdDateUTC || pos.createdDate;
  return {
    id: pos.dealId, epic: mk.epic, nome: mk.instrumentName || mk.epic, tipo: mk.instrumentType,
    dir: pos.direction === 'SELL' ? -1 : 1, entrata: +pos.level, dim: +pos.size,
    aperta: Date.parse(/Z$/.test(quando || '') ? quando : (quando || '') + 'Z') || Date.now(),
    stop: pos.stopLevel != null ? +pos.stopLevel : null, obiettivo: pos.profitLevel != null ? +pos.profitLevel : null,
    leva: pos.leverage || null, valuta: pos.currency || '',
    bid: +mk.bid, ask: +mk.offer, stato: mk.marketStatus, capital: true,
  };
}

/* Le candele lette restano agganciate alla risposta da cui vengono: finche'
   la risposta e' in memoria (dieci minuti per le giornaliere) non si
   ricalcolano. Il tempo di calcolo e' la risorsa scarsa del piano gratuito. */
const candeleGia = new WeakMap(), indicatoriGia = new WeakMap();
async function candeleDi(env, epic, risoluzione, quante) {
  const r = await leggi(env, 'prices/' + epic, new URLSearchParams({ resolution: risoluzione, max: String(quante) }));
  if (!candeleGia.has(r)) candeleGia.set(r, Motore.candele(r));
  return candeleGia.get(r);
}
/* il riferimento (l'S&P 500), una volta per giro: solo le medie che il
   punteggio usa (riferimentoLeggero), che costano poco e non si contano */
async function riferimentoDi(env, ctx, rifEpic, S) {
  const chiave = rifEpic + '|' + S.segnale;
  if (!ctx.rif[chiave]) {
    const cs = await candeleDi(env, rifEpic, S.segnale, S.candeleVive);
    if (!indicatoriGia.has(cs)) indicatoriGia.set(cs, Motore.riferimentoLeggero(cs));
    ctx.rif[chiave] = indicatoriGia.get(cs);
  }
  return ctx.rif[chiave];
}
/* Gli indicatori di un mercato, tenuti finche' le sue candele e il suo
   riferimento sono gli stessi. ctx.freddi conta quanti se ne sono dovuti
   calcolare da capo in questo giro: e' quello che costa. */
const serGia = new WeakMap();
function serDi(ctx, cs, rif) {
  const m = serGia.get(cs);
  if (m && m.rif === rif) return m.ser;
  const ser = Motore.indicatori(cs, rif);
  serGia.set(cs, { rif, ser });
  ctx.freddi = (ctx.freddi || 0) + 1;
  return ser;
}
async function sarebbeFreddo(env, ctx, epic, S, rifEpic) {
  const cs = await candeleDi(env, epic, S.segnale, S.candeleVive);
  const rif = epic === rifEpic ? null : await riferimentoDi(env, ctx, rifEpic, S);
  const m = serGia.get(cs);
  return !(m && m.rif === rif);
}
async function follaDi(env, ctx, epics) {
  const mancano = epics.filter(e => !(e in ctx.folle));
  if (mancano.length) {
    try {
      const s = await leggi(env, 'clientsentiment', new URLSearchParams({ marketIds: mancano.join(',') }));
      for (const x of s.clientSentiments || []) ctx.folle[x.marketId] = x.longPositionPercentage;
    } catch (e) { /* senza folla il punteggio si fa lo stesso */ }
    for (const e of mancano) if (!(e in ctx.folle)) ctx.folle[e] = null;
  }
  return ctx.folle;
}

/* Il consiglio per una posizione, esattamente come lo calcola l'app: stesse
   candele (le ultime candeleVive), stesso riferimento, stessa folla. */
async function consiglioPer(env, ctx, pos, imp, rifEpic, ora) {
  const M = Motore;
  const stile = M.STILI[imp.stile] ? imp.stile : 'swing';
  const S = M.STILI[stile];
  const cs = await candeleDi(env, pos.epic, S.segnale, S.candeleVive);
  const ct = await candeleDi(env, pos.epic, S.tempo, S.candeleTempo);
  const rif = pos.epic === rifEpic ? null : await riferimentoDi(env, ctx, rifEpic, S);
  const folle = await follaDi(env, ctx, [pos.epic]);
  const prezzo = { bid: pos.bid, ask: pos.ask };
  const an = M.analizza(cs, ct, { ser: serDi(ctx, cs, rif), rif, percLunghi: folle[pos.epic], prezzo });
  if (!an.ok) return null;
  let orario = null;
  if (S.chiudiASera) {
    const d = await leggi(env, 'markets/' + pos.epic, new URLSearchParams());
    orario = M.orari(d.instrument && d.instrument.openingHours, ora);
  }
  return M.consiglio({
    pos: { ...pos, R: imp.R, stopIniziale: imp.stopIniziale, parziale: !!imp.parziale, rinforzata: !!imp.rinforzata,
           puntiEntrata: imp.puntiEntrata, passo: imp.passo },
    prezzo, ct, an, stile, ora, orari: orario,
  });
}

function messaggio(env, pos, c) {
  const M = Motore;
  const verso = pos.dir > 0 ? 'lungo' : 'corto';
  const segnoR = c.rOra >= 0 ? '+' : '';
  const righe = [
    '<b>' + html(c.titolo.toUpperCase()) + ' · ' + html(pos.nome) + ' ' + verso + '</b>',
    html(c.frase),
    '',
    'Prezzo ' + M.fmtPrezzo(c.uscita) + ' · ' + segnoR + M.fmtNum(c.rOra, 2) + 'R · ' + (c.pnl >= 0 ? '+' : '') + M.fmtNum(c.pnl, 2) + ' ' + html(pos.valuta),
    'Stop ' + M.fmtPrezzo(c.stopEff) + ' · obiettivi ' + M.fmtPrezzo(c.tp1) + ' / ' + M.fmtPrezzo(c.tp2),
  ];
  if (c.motivi.length > 1) righe.push(html(c.motivi.slice(1).join(' ')));
  righe.push('', '<a href="' + html(env.APP || APP_PREDEFINITA) + '#gioco">Apri Mirino</a>');
  return righe.join('\n');
}

const DA_AVVISARE = { esci: 1, incassa: 1, meta: 1, stop: 1, rinforza: 1, attento: 1 };

/* le posizioni aperte: quelle su Capital.com e quelle segnate a mano */
async function posizioniAperte(env) {
  const lista = ((await leggi(env, 'positions', new URLSearchParams())).positions || []).map(daCapital);
  const manuali = (await leggiKV(env, 'manuali')) || [];
  for (const m of manuali) {
    if (lista.some(p => p.id === m.id)) continue;
    try {
      const d = await leggi(env, 'markets/' + m.epic, new URLSearchParams());
      lista.push({ ...m, bid: d.snapshot.bid, ask: d.snapshot.offer, stato: d.snapshot.marketStatus });
    } catch (e) { lista.push({ ...m, stato: 'SCONOSCIUTO' }); }
  }
  return lista;
}

async function sorvegliaUscite(env, ctx, lista, imp, rifEpic, ora, limite = Infinity) {
  const aperte = lista.filter(p => p.stato === 'TRADEABLE');
  const mandati = [];
  /* a rotazione: se il calcolo del giro e' finito, le altre al giro dopo */
  const giro = Math.floor(ora / 60000);
  const ordine = aperte.map((_, i) => aperte[(i + giro) % aperte.length]);
  for (const pos of ordine) {
    try {
      let seg = await leggiKV(env, 'segui:' + pos.id);
      if (!seg) {
        /* la prima volta: si fissa il rischio iniziale, che da qui non cambia */
        seg = { stile: imp.stile || env.STILE || 'swing', riferimento: rifEpic };
        if (pos.stop != null && (pos.stop - pos.entrata) * pos.dir < 0) seg.stopIniziale = pos.stop;
        await scriviKV(env, 'segui:' + pos.id, seg);
      }
      const S = Motore.STILI[seg.stile] || Motore.STILI.swing;
      if ((ctx.freddi || 0) >= limite && await sarebbeFreddo(env, ctx, pos.epic, S, rifEpic)) continue;
      if (!seg.R && seg.stopIniziale == null) {
        const cs = await candeleDi(env, pos.epic, S.segnale, S.candeleVive);
        const R = Motore.rischioIniziale(cs, Motore.indicatori(cs), pos.aperta, seg.stile);
        if (R) { seg.R = R; await scriviKV(env, 'segui:' + pos.id, seg); }
      }
      const c = await consiglioPer(env, ctx, pos, seg, rifEpic, ora);
      if (!c) continue;
      const prima = await leggiKV(env, 'avviso:' + pos.id);
      const cambiato = !prima || prima.verdetto !== c.verdetto ||
        (c.verdetto === 'stop' && Math.abs(c.stopRegola - prima.stop) / c.R >= 0.25);
      if (!cambiato) continue;
      await scriviKV(env, 'avviso:' + pos.id, { verdetto: c.verdetto, stop: c.stopRegola, quando: ora });
      if (DA_AVVISARE[c.verdetto]) {
        const r = await telegram(env, messaggio(env, pos, c));
        mandati.push({ id: pos.id, verdetto: c.verdetto, ok: r.ok });
      }
    } catch (e) {
      mandati.push({ id: pos.id, errore: e.message });
    }
  }
  return { posizioni: lista.length, aperte: aperte.length, mandati };
}

/* ── gli ingressi ──

   Un mercato della lista a ogni giro, a rotazione: con diciotto mercati
   ognuno viene guardato ogni diciotto minuti. Tutti insieme ogni minuto non
   ci stanno nei dieci millisecondi di calcolo del piano gratuito, e per uno
   che gioca sulle giornaliere un quarto d'ora non cambia niente.

   La rotazione segue l'orologio (minuto % lunghezza della lista), non un
   contatore: un contatore andrebbe scritto in KV a ogni giro, 1440 volte al
   giorno, e il piano gratuito ne concede mille.

   Quando un mercato diventa pronto per il tuo profilo arriva l'avviso, con
   l'ordine gia' calcolato come nell'app. Non arriva se:
     - il mercato e' chiuso;
     - sei gia' dentro su quel mercato, o hai gia' tutti i colpi del profilo
       aperti (l'avviso arrivera' quando si libera un posto, se e' ancora pronto);
     - te l'ha gia' detto nelle ultime 12 ore (3 in intraday) per la stessa
       direzione: un punteggio che balla attorno alla soglia non deve
       mandarti cinque messaggi;
     - con il tuo budget non si arriva alla taglia minima. */

function messaggioIngresso(env, epic, nome, an, p, valuta) {
  const M = Motore;
  const verbo = p.dir > 0 ? 'compra' : 'vendi';
  const q = M.fmtNum(p.dim, p.passo < 1 ? 2 : 0);
  const ordine = p.tipo === 'mercato' ? verbo.charAt(0).toUpperCase() + verbo.slice(1) + ' ' + q + ' a mercato, circa ' + M.fmtPrezzo(p.entrata) + '.'
    : p.tipo === 'limite' ? 'Ordine limite: ' + verbo + ' ' + q + ' a ' + M.fmtPrezzo(p.entrata) + '.'
    : 'Ordine stop: ' + verbo + ' ' + q + ' se tocca ' + M.fmtPrezzo(p.entrata) + '.';
  return [
    '<b>ENTRA · ' + html(nome) + ' ' + (p.dir > 0 ? 'lungo' : 'corto') + '</b> · grado ' + an.grado + ' (' + M.segno(an.punti) + ')',
    html(ordine),
    'Stop ' + M.fmtPrezzo(p.stop) + ' · obiettivi ' + M.fmtPrezzo(p.tp1) + ' / ' + M.fmtPrezzo(p.tp2),
    'Rischio ' + M.fmtNum(p.perdita, 0) + ' ' + html(valuta) + ' · margine ' + M.fmtNum(p.margine, 0) + ' ' + html(valuta) + ' (leva ' + M.fmtLeva(p.leva) + ')',
    html(p.motivoTempo),
    '',
    '<a href="' + html(env.APP || APP_PREDEFINITA) + '#colpo/' + encodeURIComponent(epic) + '">Apri il piano</a>',
  ].join('\n');
}

async function cambioVerso(env, da, a) {
  if (!da || !a || da === a) return 1;
  const mid = d => { const s = d.snapshot || {}; return (s.bid + s.offer) / 2; };
  try { const x = mid(await leggi(env, 'markets/' + da + a, new URLSearchParams())); if (x > 0) return x; } catch (e) { /* si prova al contrario */ }
  try { const x = mid(await leggi(env, 'markets/' + a + da, new URLSearchParams())); if (x > 0) return 1 / x; } catch (e) { /* niente */ }
  return 1;
}

async function sorvegliaIngressi(env, ctx, lista, imp, rifEpic, ora) {
  if (imp.ingressi === false) return { saltato: 'spenti dall\'app' };
  const elenco = Array.isArray(imp.lista) ? imp.lista : [];
  if (!Motore.PROFILI[imp.profilo] || !(imp.budget > 0) || !elenco.length) {
    return { saltato: 'mancano le impostazioni: apri l\'app collegata al ponte' };
  }
  const M = Motore, P = M.PROFILI[imp.profilo];
  const stile = M.STILI[imp.stile] ? imp.stile : 'swing', S = M.STILI[stile];
  const epic = elenco[Math.floor(ora / 60000) % elenco.length];
  const esito = { epic };
  const d = await leggi(env, 'markets/' + epic, new URLSearchParams());
  const sn = d.snapshot || {};
  if (sn.marketStatus !== 'TRADEABLE') return { ...esito, saltato: 'chiuso' };

  const cs = await candeleDi(env, epic, S.segnale, S.candeleVive);
  const ct = await candeleDi(env, epic, S.tempo, S.candeleTempo);
  const rif = epic === rifEpic ? null : await riferimentoDi(env, ctx, rifEpic, S);
  const folle = await follaDi(env, ctx, [epic]);
  const prezzo = sn.bid > 0 && sn.offer > 0 ? { bid: sn.bid, ask: sn.offer } : null;
  const an = M.analizza(cs, ct, { ser: serDi(ctx, cs, rif), rif, percLunghi: folle[epic], prezzo });
  if (!an.ok) return { ...esito, saltato: an.motivo };
  esito.punti = an.punti;

  const chiave = 'ingresso:' + epic;
  const prima = await leggiKV(env, chiave);
  if (!M.pronto(an, imp.profilo)) {
    /* si "spegne" solo se scende otto punti sotto la soglia, o si gira */
    if (prima && prima.pronto && (Math.abs(an.punti) < M.sogliaProfilo(imp.profilo) - 8 || an.dir !== prima.dir)) {
      await scriviKV(env, chiave, { pronto: false, dir: prima.dir, quando: prima.quando });
    }
    return { ...esito, pronto: false };
  }
  esito.pronto = true;
  if (prima && prima.dir === an.dir && (prima.pronto || ora - prima.quando < (stile === 'intraday' ? 3 : 12) * 3600000)) {
    return { ...esito, gia: true };
  }
  if (lista.some(p => p.epic === epic)) return { ...esito, saltato: 'sei gia\' dentro' };
  if (lista.length >= P.colpi) return { ...esito, saltato: 'posti pieni' };

  let leve = null;
  try { leve = (await leggi(env, 'accounts/preferences', new URLSearchParams())).leverages || null; } catch (e) { leve = null; }
  const strumento = M.strumentoDa(d, leve);
  const cambio = await cambioVerso(env, strumento.valuta, imp.valuta);
  const p = M.piano({ an, budget: imp.budget, profilo: imp.profilo, stile, strumento, cambio,
                      notte: M.notteDa(d.instrument && d.instrument.overnightFee) || undefined });
  if (!p.ok || !p.ammesso || p.sottoMinimo) return { ...esito, saltato: 'budget sotto la taglia minima' };

  const r = await telegram(env, messaggioIngresso(env, epic, (d.instrument && d.instrument.name) || epic, an, p, imp.valuta || strumento.valuta || ''));
  if (r.ok) await scriviKV(env, chiave, { pronto: true, dir: an.dir, grado: an.grado, quando: ora });
  return { ...esito, mandato: r.ok, dim: p.dim, stop: p.stop };
}

/* ─────────────────────────── il robot ───────────────────────────

   Lo accendi dall'app, lo fermi dall'app o da Telegram. Gira nel cron di
   ogni minuto. In KV ci sono due chiavi, e ognuna ha un solo padrone:

     robot:comando   l'ultimo ordine tuo: avvia (con le impostazioni) o
                     ferma (e se chiudere tutto). La scrivono SOLO l'app e
                     Telegram.
     robot           lo stato del robot. Lo scrive SOLO il giro del cron.

   Cosi' un "Ferma" non si puo' perdere: prima c'era una chiave sola, e un
   giro partito un attimo prima del tuo Ferma la riscriveva con "acceso".
   Adesso il giro legge il comando, lo applica una volta (si ricorda quale
   ha visto: comandoVisto) e lo ricontrolla prima di ogni ordine.

   Lo stato:
     acceso, avviato, fermato, motivo
     capitaleIniziale   il patrimonio (saldo + risultato aperto) all'avvio
     perditaMax         il tetto: arrivato li' si ferma e chiude tutto
     maxPosizioni, stile, lista, riferimento, valuta
     aperte             le posizioni aperte dal robot: le altre non le tocca
     inAttesa           ordini mandati di cui non si e' vista la conferma
     chiuse             l'ultima chiusura per mercato, per non rientrare subito
     chiudiTutto        c'e' da chiudere tutto (tetto, "ferma e chiudi"): si
                        riprova a ogni giro finche' non resta niente
     diario             le ultime 40 cose fatte
     visti              per ogni mercato l'ultima occhiata: punteggio e perche'
                        non e' entrato. E' la risposta a "perche' non apre?"
     battito            l'ultimo giro: se e' vecchio, il cron non gira

   Le scritture in KV sono contate (mille al giorno gratis): si scrive quando
   cambia qualcosa che conta, e comunque ogni cinque minuti per il battito e
   i visti. Mai a ogni giro.

   L'ordine di un giro:
     0. il comando, se ce n'e' uno nuovo;
     1. il conto: se la perdita dall'avvio ha raggiunto il tetto, si ferma e
        chiude tutto; se c'e' da chiudere tutto, chiude e basta;
     2. le sue posizioni che non ci sono piu' (stop o take profit scattati su
        Capital.com) escono dalla lista;
     3. per ognuna delle sue posizioni: chiudere, spostare lo stop, o niente.
        Anche da fermo: "Ferma" vuol dire che non apre piu' niente, non che
        abbandona quello che ha aperto;
     4. se e' acceso: i mercati della lista, a rotazione, e se uno e' pronto
        per il profilo Estremo si apre.

   Il calcolo e' la risorsa scarsa (10 ms a giro sul piano gratuito): in un
   giro si calcolano da capo al massimo ROBOT_CALCOLI mercati, prima le
   posizioni e poi gli ingressi. Quello che resta si guarda al giro dopo;
   intanto stop e take profit sono gia' su Capital.com. */

/* sempre una copia nuova: un oggetto condiviso fra i giri si porterebbe
   dietro le posizioni di un altro */
function robotBase() { return { acceso: false, aperte: [], inAttesa: [], chiuse: {}, rifiuti: {}, diario: [], visti: {}, errori: {}, colpi: { n: 0, vinti: 0 } }; }
/* dopo un ordine rifiutato, quel mercato si lascia stare mezz'ora: se manca
   il margine o la taglia non va, riprovare ogni giro non cambia niente */
const PAUSA_RIFIUTO = 30 * 60000;
const BATTITO_MS = 5 * 60000;
/* quanti mercati guarda a ogni giro, se non lo dici tu (ROBOT_MERCATI_PER_GIRO) */
const MERCATI_PER_GIRO = { swing: 1, intraday: 1, rapido: 2 };

function contoDa(a) {
  const c = (a.accounts || []).find(x => x.preferred) || (a.accounts || [])[0];
  if (!c || !c.balance) return null;
  const b = c.balance, aperto = +(b.profitLoss || 0);
  return { valuta: c.currency, saldo: +b.balance, aperto, disponibile: +b.available, patrimonio: +b.balance + aperto };
}
async function contoAdesso(env) { return contoDa(await leggi(env, 'accounts', new URLSearchParams())); }

function decimaliDi(d, x) {
  const f = d && d.snapshot && d.snapshot.decimalPlacesFactor;
  return Number.isInteger(f) && f >= 0 && f <= 8 ? f : Motore.decimaliPer(x);
}
function arrotonda(x, dec) { return Number(x.toFixed(dec)); }

/* segreti derivati dalla CHIAVE: il percorso e l'intestazione del webhook
   di Telegram. Chi non ha la CHIAVE non li puo' indovinare. */
async function segreto(env, scopo) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.CHIAVE || '') + '|' + scopo)));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function annota(robot, ora, tipo, testo) {
  robot.diario = [{ quando: ora, tipo, testo }].concat(robot.diario || []).slice(0, 40);
}
function nomePos(a) { return (a.nome || a.epic) + ' ' + (a.dir > 0 ? 'lungo' : 'corto'); }
function soldi(x, valuta) { return (x >= 0 ? '+' : '−') + Motore.fmtNum(Math.abs(x), 2) + ' ' + (valuta || ''); }
function piede(robot, conto) {
  if (!conto || robot.capitaleIniziale == null) return '';
  return '\nDall\'avvio: ' + soldi(conto.patrimonio - robot.capitaleIniziale, conto.valuta) + ' · tetto ' + Motore.fmtNum(robot.perditaMax, 0) + ' ' + conto.valuta +
    ' · posizioni ' + (robot.aperte || []).length + '/' + robot.maxPosizioni +
    (robot.colpi && robot.colpi.n ? ' · colpi ' + robot.colpi.vinti + ' vinti su ' + robot.colpi.n : '');
}
function stileDi(robot) { return Motore.STILI[robot.stile] ? robot.stile : 'swing'; }

/* tutto quello che conta per decidere se scrivere: non il battito e i
   visti, che cambiano a ogni giro */
function sostanza(robot) {
  const { battito, visti, scritto, ...resto } = robot;
  return JSON.stringify(resto);
}
function idComando(ora) { return ora + '-' + Math.random().toString(36).slice(2, 8); }

/* un ordine partito senza conferma (la rete, un timeout) e la posizione
   che e' comparsa su Capital.com: stesso mercato, verso, taglia, minuti */
function trovaOrdine(robot, lista, w) {
  return lista.find(p => p.epic === w.epic && p.dir === w.dir && Math.abs(p.dim - w.dim) < 1e-9 &&
    !robot.aperte.some(a => a.id === p.id) && Math.abs(p.aperta - w.quando) < 10 * 60000) || null;
}

/* una posizione del robot che si e' chiusa: fuori dalla lista, pausa sul
   mercato, e il conto dei colpi */
function togli(robot, a, ora, profitto) {
  robot.aperte = robot.aperte.filter(x => x.id !== a.id);
  robot.chiuse[a.epic] = { dir: a.dir, quando: ora };
  robot.colpi = robot.colpi || { n: 0, vinti: 0 };
  robot.colpi.n++;
  if (profitto > 0) robot.colpi.vinti++;
}

async function chiudiTutto(env, robot, lista, ora, motivo) {
  const esiti = [], presenti = new Set(lista.map(p => p.id));
  /* gli ordini senza conferma: se la posizione c'e', si chiude anche quella;
     se non c'e' ancora, si aspetta (al massimo un quarto d'ora) */
  for (const w of robot.inAttesa.slice()) {
    const t = trovaOrdine(robot, lista, w);
    if (t) robot.aperte.push({ ...w, id: t.id, entrata: t.entrata, dim: t.dim, aperta: t.aperta });
    if (t || ora - w.quando > 15 * 60000) robot.inAttesa = robot.inAttesa.filter(x => x !== w);
  }
  for (const a of robot.aperte.slice()) {
    try {
      const r = presenti.has(a.id) ? await chiudiPosizione(env, a.id) : { ok: true, giaChiusa: true };
      togli(robot, a, ora, r.profitto);
      annota(robot, ora, 'chiusa', nomePos(a) + ': chiusa (' + motivo + ')' + (r.profitto != null ? ', ' + soldi(r.profitto, r.valuta) : '') + '.');
      esiti.push({ id: a.id, ok: true, profitto: r.profitto, valuta: r.valuta, giaChiusa: !!r.giaChiusa });
    } catch (e) {
      annota(robot, ora, 'errore', nomePos(a) + ': non riesco a chiuderla (' + e.message + '). Riprovo al prossimo giro.');
      esiti.push({ id: a.id, ok: false, errore: e.message });
    }
  }
  return esiti;
}

/* La leva al massimo che Capital.com ti concede, per ogni tipo di strumento
   (indici, azioni, ...): la chiedi tu all'avvio. Con un conto piccolo e' il
   margine a decidere quanto e' grande una posizione, e la leva lo
   moltiplica. Si fa una volta per avvio; se Capital.com dice di no, il robot
   lo scrive e gioca con la leva che c'e'. */
async function mettiLevaMassima(env, robot, nota) {
  for (const k of [...memoria.keys()]) if (k.startsWith('accounts/preferences')) memoria.delete(k);
  const pref = await leggi(env, 'accounts/preferences', new URLSearchParams());
  const leve = pref.leverages || {}, nuove = {}, righe = [];
  for (const [tipo, v] of Object.entries(leve)) {
    const max = Math.max(...((v && v.available) || []).filter(x => x > 0));
    if (Number.isFinite(max) && max > (v.current || 0)) { nuove[tipo] = max; righe.push(tipo + ' ' + (v.current || '?') + ':1 → ' + max + ':1'); }
  }
  if (!righe.length) { nota('leva', 'Leva gia\' al massimo che Capital.com ti concede.'); return { cambiata: false }; }
  await scriviCapital(env, 'PUT', 'accounts/preferences', { leverages: nuove });
  for (const k of [...memoria.keys()]) if (k.startsWith('accounts/preferences')) memoria.delete(k);
  nota('leva', 'Leva al massimo: ' + righe.join(', ') + '.');
  return { cambiata: true, righe };
}

/* il comando dall'app o da Telegram, una volta sola */
function applicaComando(robot, comando, ora, nota) {
  if (!comando || comando.id === robot.comandoVisto) return null;
  robot.comandoVisto = comando.id;
  const M = Motore;
  if (comando.azione === 'avvia') {
    const imp = comando.impostazioni || {};
    if (comando.chiudiPrima && ((robot.aperte || []).length || (robot.inAttesa || []).length)) robot.chiudiTutto = true;
    Object.assign(robot, {
      acceso: true, avviato: comando.quando, fermato: null, motivo: '', errori: {}, colpi: { n: 0, vinti: 0 },
      capitaleIniziale: comando.capitaleIniziale, valuta: comando.valuta,
      perditaMax: imp.perditaMax, maxPosizioni: imp.maxPosizioni, stile: imp.stile, lista: imp.lista, riferimento: imp.riferimento,
      levaMassima: imp.levaMassima !== false, levaFatta: false, visti: {},
    });
    nota('acceso', 'Acceso. Tetto di perdita ' + M.fmtNum(robot.perditaMax, 2) + ' ' + (robot.valuta || '') + ', fino a ' + robot.maxPosizioni +
      ' posizioni, ' + robot.lista.length + ' mercati, ' + M.STILI[stileDi(robot)].nome + '.');
    return 'avvia';
  }
  if (comando.azione === 'ferma') {
    const eraAcceso = robot.acceso;
    robot.acceso = false; robot.fermato = comando.quando; robot.motivo = comando.chi || '';
    if (comando.chiudi) robot.chiudiTutto = true;
    if (eraAcceso || comando.chiudi) {
      nota('fermo', 'Fermato ' + (comando.chi || '') + (comando.chiudi ? ', con chiusura di tutte le posizioni.' : '. Non apro piu\' niente; le posizioni aperte le porto a fine con le loro regole.'));
    }
    return 'ferma';
  }
  return null;
}

/* Come e' finita una posizione che ha chiuso Capital.com da sola: dal prezzo
   di adesso si capisce se ha preso il take profit o lo stop. E' una stima:
   il numero vero e' nello storico di Capital.com. */
async function comeEFinita(env, a) {
  let px = null;
  try {
    const s = (await leggi(env, 'markets/' + a.epic, new URLSearchParams())).snapshot || {};
    if (s.bid > 0 && s.offer > 0) px = (s.bid + s.offer) / 2;
  } catch (e) { px = null; }
  const stop = a.stop != null ? a.stop : a.stopIniziale;
  if (px == null || a.tp == null || stop == null) return { testo: 'e\' scattato lo stop o il take profit', profitto: null };
  const presoTp = Math.abs(px - a.tp) < Math.abs(px - stop);
  const livello = presoTp ? a.tp : stop;
  const profitto = (livello - a.entrata) * a.dir * a.dim * (a.cambio || 1);
  return { testo: (presoTp ? 'take profit' : 'stop') + ' a ' + Motore.fmtPrezzo(livello) + ', circa ' + soldi(profitto, ''), profitto, presoTp };
}

async function giroRobot(env, ctx, robot, lista, rifEpic, ora, opz) {
  const M = Motore, out = { azioni: [] };
  opz = opz || {};
  const base = robotBase();
  for (const k of Object.keys(base)) if (robot[k] == null) robot[k] = base[k];
  robot.battito = { quando: ora };
  const nota = (tipo, testo) => { annota(robot, ora, tipo, testo); out.azioni.push(tipo + ': ' + testo); };
  const errore = testo => {
    /* lo stesso errore si scrive una volta ogni mezz'ora: ogni scrittura in
       KV conta, e un errore che si ripete ogni minuto le brucerebbe tutte */
    for (const t of Object.keys(robot.errori)) if (ora - robot.errori[t] >= 30 * 60000) delete robot.errori[t];
    if (robot.errori[testo]) return;
    robot.errori[testo] = ora;
    nota('errore', testo);
  };

  /* 0. il comando */
  const cmd = applicaComando(robot, opz.comando, ora, nota);
  out.comando = cmd;
  const stile = stileDi(robot), S = M.STILI[stile];

  /* 1. il conto e il tetto */
  const conto = await contoAdesso(env);
  if (!conto) throw new Error('Capital.com non manda il conto.');
  if (robot.capitaleIniziale == null && robot.acceso) robot.capitaleIniziale = conto.patrimonio;
  const perdita = Math.max(0, robot.capitaleIniziale - conto.patrimonio);
  out.conto = conto; out.perdita = perdita;
  Object.assign(robot.battito, { patrimonio: conto.patrimonio, disponibile: conto.disponibile, valuta: conto.valuta });
  if (cmd === 'avvia') {
    const quanti = Math.min(5, +env.ROBOT_MERCATI_PER_GIRO > 0 ? +env.ROBOT_MERCATI_PER_GIRO : MERCATI_PER_GIRO[stile] || 1);
    await telegram(env, '<b>ROBOT ACCESO</b>\nPatrimonio di partenza ' + M.fmtNum(robot.capitaleIniziale, 2) + ' ' + html(conto.valuta) +
      '. Tetto di perdita ' + M.fmtNum(robot.perditaMax, 2) + ': arrivato li\' mi fermo e chiudo tutto.\nFino a ' + robot.maxPosizioni + ' posizioni, profilo Estremo, ' +
      S.nome + '. Rischio a colpo: ' + M.fmtNum(M.rischioRobot(robot.perditaMax, 'A'), 2) + ' su un A, ' + M.fmtNum(M.rischioRobot(robot.perditaMax, 'C'), 2) + ' su un C.\n' +
      'Guardo ' + robot.lista.length + ' mercati, ' + quanti + ' al minuto: il giro completo dura ' + Math.ceil(robot.lista.length / quanti) + ' minuti.\n' +
      'Comandi: /stato · /stop (non apro piu\' niente) · /chiudi (fermo e chiudo tutto)');
  }
  if (robot.acceso && robot.levaMassima && !robot.levaFatta) {
    robot.levaFatta = true;
    try {
      const r = await mettiLevaMassima(env, robot, nota);
      if (r.cambiata) await telegram(env, '<b>LEVA AL MASSIMO</b>\n' + html(r.righe.join('\n')) + '\nPosizioni piu\' grandi con lo stesso margine: guadagni e perdite piu\' veloci. Il tetto resta quello.');
    } catch (e) { nota('errore', 'Non riesco a mettere la leva al massimo (' + e.message + '): gioco con quella che c\'e\'. Puoi alzarla tu su Capital.com, Impostazioni › Leva.'); }
  }
  let tettoAdesso = false;
  if (robot.acceso && perdita >= robot.perditaMax) {
    robot.acceso = false; robot.fermato = ora; robot.motivo = 'tetto'; robot.chiudiTutto = true; tettoAdesso = true;
    nota('tetto', 'Perdita dall\'avvio ' + M.fmtNum(perdita, 2) + ' ' + conto.valuta + ': tetto di ' + M.fmtNum(robot.perditaMax, 0) + ' raggiunto. Mi fermo e chiudo tutto.');
  }
  if (robot.chiudiTutto) {
    const esiti = await chiudiTutto(env, robot, lista, ora, robot.motivo === 'tetto' ? 'tetto di perdita' : 'fermato ' + (robot.motivo || ''));
    const chiuse = esiti.filter(e => e.ok && !e.giaChiusa).length, male = esiti.filter(e => !e.ok).length;
    if (tettoAdesso) {
      await telegram(env, '<b>ROBOT FERMATO · tetto di perdita</b>\nPerdita dall\'avvio ' + M.fmtNum(perdita, 2) + ' ' + html(conto.valuta) +
        '. Ho chiuso ' + esiti.filter(e => e.ok).length + ' posizioni' + (male ? ', ' + male + ' NON si sono chiuse: riprovo a ogni minuto, controlla su Capital.com' : '') + '.');
    } else if (chiuse || male) {
      await telegram(env, '<b>ROBOT · chiusura</b>\nChiuse ' + chiuse + ' posizioni' + (male ? ', ' + male + ' NON si sono chiuse: riprovo a ogni minuto, controlla su Capital.com' : '') + '.');
    }
    if (!robot.aperte.length && !robot.inAttesa.length) robot.chiudiTutto = false;
    return out;
  }

  /* 2. quello che e' successo su Capital.com dall'ultimo giro */
  const presenti = new Map(lista.map(p => [p.id, p]));
  for (const w of robot.inAttesa.slice()) {
    const trovata = trovaOrdine(robot, lista, w);
    if (trovata) {
      robot.aperte.push({ ...w, id: trovata.id, entrata: trovata.entrata, dim: trovata.dim, aperta: trovata.aperta });
      robot.inAttesa = robot.inAttesa.filter(x => x !== w);
      nota('aperta', nomePos(w) + ': ordine confermato in ritardo, la posizione e\' mia.');
    } else if (ora - w.quando > 15 * 60000) {
      robot.inAttesa = robot.inAttesa.filter(x => x !== w);
    }
  }
  for (const a of robot.aperte.slice()) {
    if (presenti.has(a.id)) continue;
    const fine = await comeEFinita(env, a);
    togli(robot, a, ora, fine.profitto);
    nota('chiusa', nomePos(a) + ': l\'ha chiusa Capital.com (' + fine.testo + ').');
    await telegram(env, '<b>' + (fine.presoTp ? 'INCASSATO' : 'CHIUSA') + ' · ' + html(nomePos(a)) + '</b>\nL\'ha chiusa Capital.com: ' + html(fine.testo) + '.' + html(piede(robot, conto)));
  }

  /* 3. le sue posizioni, a rotazione, con un tetto ai calcoli da capo. Un
     calcolo resta per gli ingressi, se e' acceso. */
  const limite = +env.ROBOT_CALCOLI > 0 ? +env.ROBOT_CALCOLI : 3;
  const perPosizioni = robot.acceso ? Math.max(1, limite - 1) : limite;
  const giro = Math.floor(ora / 60000), n = robot.aperte.length;
  const ordine = robot.aperte.map((_, i) => robot.aperte[(i + giro) % n]);
  for (const a of ordine) {
    const pos = presenti.get(a.id);
    if (!pos || pos.stato !== 'TRADEABLE') continue;
    try {
      if ((ctx.freddi || 0) >= perPosizioni && await sarebbeFreddo(env, ctx, pos.epic, S, rifEpic)) { out.rimandate = (out.rimandate || 0) + 1; continue; }
      const c = await consiglioPer(env, ctx, pos, { stile, R: a.R, stopIniziale: a.stopIniziale, parziale: true, rinforzata: true, passo: a.passo }, rifEpic, ora);
      const d = M.robotUscita(c, { dir: pos.dir, stop: pos.stop }, stile);
      if (d.azione === 'chiudi') {
        const r = await chiudiPosizione(env, pos.id);
        const profitto = r.profitto != null ? r.profitto : (c ? c.pnlConto : null);
        togli(robot, a, ora, profitto);
        const esito = r.profitto != null ? ' Risultato ' + soldi(r.profitto, r.valuta) + '.' : '';
        nota('chiusa', nomePos(a) + ': ' + d.motivo + esito);
        await telegram(env, '<b>CHIUSA · ' + html(nomePos(a)) + '</b>\n' + html(d.motivo) + html(esito) + html(piede(robot, conto)));
      } else if (d.azione === 'stop') {
        const dmk = await leggi(env, 'markets/' + pos.epic, new URLSearchParams());
        const livello = arrotonda(d.livello, decimaliDi(dmk, d.livello));
        await spostaStop(env, pos.id, livello, a.tp);
        a.stop = livello;
        nota('stop', nomePos(a) + ': stop a ' + M.fmtPrezzo(livello) + '. ' + d.motivo);
        /* nel rapido gli stop si muovono spesso: su Telegram arrivano solo
           aperture e chiusure */
        if (stile !== 'rapido') await telegram(env, '<b>STOP SPOSTATO · ' + html(nomePos(a)) + '</b>\nStop a ' + M.fmtPrezzo(livello) + '. ' + html(d.motivo));
      }
    } catch (e) { errore(nomePos(a) + ': ' + e.message); }
  }

  /* 4. gli ingressi */
  if (robot.acceso && (robot.lista || []).length) {
    const quanti = Math.min(5, +env.ROBOT_MERCATI_PER_GIRO > 0 ? +env.ROBOT_MERCATI_PER_GIRO : MERCATI_PER_GIRO[stile] || 1);
    const lunghezza = robot.lista.length;
    for (const k of Object.keys(robot.rifiuti)) if (ora - robot.rifiuti[k].quando >= PAUSA_RIFIUTO) delete robot.rifiuti[k];
    for (let i = 0; i < Math.min(quanti, lunghezza); i++) {
      const epic = robot.lista[(giro * quanti + i) % lunghezza];
      let e;
      try { e = await entrataRobot(env, ctx, robot, epic, lista, conto, perdita, rifEpic, ora, nota, opz.salva, limite); }
      catch (err) { errore(epic + ': ' + err.message); e = { epic, motivo: 'errore: ' + err.message }; }
      if (e.rimandato) { out.rimandate = (out.rimandate || 0) + 1; continue; }
      robot.visti[epic] = { quando: ora, punti: e.punti != null ? e.punti : null, motivo: e.aperta ? 'aperta' : e.motivo };
      out.entrate = (out.entrate || []).concat([e]);
    }
    /* solo i mercati della lista */
    for (const k of Object.keys(robot.visti)) if (!robot.lista.includes(k)) delete robot.visti[k];
  }
  robot.battito.calcoli = ctx.freddi || 0;
  robot.battito.rimandate = out.rimandate || 0;
  return out;
}

async function entrataRobot(env, ctx, robot, epic, lista, conto, perdita, rifEpic, ora, nota, salva, limite) {
  const M = Motore, stile = stileDi(robot), S = M.STILI[stile];
  if (robot.inAttesa.some(w => w.epic === epic)) return { epic, motivo: 'ordine in attesa di conferma' };
  if (lista.some(x => x.epic === epic)) return { epic, motivo: 'gia\' dentro su questo mercato' };
  const rifiuto = robot.rifiuti[epic];
  if (rifiuto && ora - rifiuto.quando < PAUSA_RIFIUTO) {
    return { epic, motivo: 'Capital.com ha rifiutato l\'ordine (' + rifiuto.perche + '): riprovo fra ' + Math.ceil((PAUSA_RIFIUTO - (ora - rifiuto.quando)) / 60000) + ' minuti' };
  }
  const d = await leggi(env, 'markets/' + epic, new URLSearchParams());
  const sn = d.snapshot || {};
  if (sn.marketStatus !== 'TRADEABLE') return { epic, motivo: 'mercato chiuso' };
  if ((ctx.freddi || 0) >= limite && await sarebbeFreddo(env, ctx, epic, S, rifEpic)) return { epic, rimandato: true };
  const cs = await candeleDi(env, epic, S.segnale, S.candeleVive);
  const ct = await candeleDi(env, epic, S.tempo, S.candeleTempo);
  const rif = epic === rifEpic ? null : await riferimentoDi(env, ctx, rifEpic, S);
  const folle = await follaDi(env, ctx, [epic]);
  const prezzo = sn.bid > 0 && sn.offer > 0 ? { bid: sn.bid, ask: sn.offer } : null;
  const an = M.analizza(cs, ct, { ser: serDi(ctx, cs, rif), rif, percLunghi: folle[epic], prezzo });
  /* il Rapido entra sul ritracciamento nel trend, gli altri sul punteggio.
     Il segnale del Rapido si legge sull'ultima candela CHIUSA, come nella
     misura sui dati veri: quella di adesso e' ancora a meta'. */
  const rapido = !!S.ritraccio;
  let rq = null;
  if (an.ok && rapido) {
    const tc = cs[cs.length - 1].t + S.barMs <= ora ? an.t : an.t - 1;
    rq = M.ritraccio(an.ser, tc, prezzo ? prezzo.ask - prezzo.bid : NaN);
    an.ritraccio = rq;
    if (Number.isFinite(an.ser.atr[tc]) && an.ser.atr[tc] > 0) an.atr = an.ser.atr[tc];
  }
  if (rapido && !(rq && rq.dir)) return { epic, punti: an.ok ? an.punti : null, motivo: an.ok ? rq.motivo : an.motivo };
  if (!rapido && !M.pronto(an, M.ROBOT.profilo)) return { epic, punti: an.ok ? an.punti : null, motivo: an.ok ? 'nessun segnale' : an.motivo };

  let leve = null;
  try { leve = (await leggi(env, 'accounts/preferences', new URLSearchParams())).leverages || null; } catch (e) { leve = null; }
  const strumento = M.strumentoDa(d, leve);
  const cambio = await cambioVerso(env, strumento.valuta, conto.valuta);
  const p = M.piano({ an, budget: robot.perditaMax, profilo: M.ROBOT.profilo, stile, strumento, cambio,
                      notte: M.notteDa(d.instrument && d.instrument.overnightFee) || undefined,
                      ...(rapido ? { dir: rq.dir, tempismo: { tipo: 'mercato', livello: rq.dir > 0 ? sn.offer : sn.bid, motivo: rq.motivo } } : {}) });
  /* il rischio gia' in gioco: per ogni sua posizione, quanto si perde ancora
     DA ADESSO se scatta lo stop che c'e' su Capital.com. Il tetto si misura
     sul patrimonio, che il risultato aperto lo contiene gia': una posizione
     in guadagno con lo stop a pareggio rischia di restituire quel guadagno. */
  const rischioAperto = robot.aperte.reduce((t, a) => {
    const pos = lista.find(x => x.id === a.id);
    const stop = pos && pos.stop != null ? pos.stop : (a.stop != null ? a.stop : a.stopIniziale);
    const px = pos && pos.bid > 0 && pos.ask > 0 ? (a.dir > 0 ? pos.bid : pos.ask) : a.entrata;
    return t + Math.max(0, (px - stop) * a.dir) * a.dim * (a.cambio || 1);
  }, 0) + robot.inAttesa.reduce((t, w) => t + w.R * w.dim * (w.cambio || 1), 0);
  const dec = M.robotEntrata({
    an, piano: p, ora, stile,
    stato: { aperte: lista.length + robot.inAttesa.length, maxPosizioni: robot.maxPosizioni, tetto: robot.perditaMax,
             residuo: robot.perditaMax - perdita, rischioAperto, disponibile: conto.disponibile },
    giaDentro: false, chiusaDiRecente: robot.chiuse[epic],
    orario: M.orari(d.instrument && d.instrument.openingHours, ora),
  });
  if (!dec.apri) return { epic, punti: an.punti, motivo: dec.motivo };

  /* un attimo prima dell'ordine: e' arrivato un Ferma? */
  const comando = await leggiKV(env, 'robot:comando');
  if (comando && comando.id !== robot.comandoVisto && comando.azione === 'ferma') return { epic, punti: an.punti, motivo: 'fermato adesso: niente ordine' };

  const decimali = decimaliDi(d, p.entrata);
  const stop = arrotonda(dec.stop, decimali), tp = arrotonda(dec.tp, decimali);
  const nome = (d.instrument && d.instrument.name) || epic;
  const attesa = { epic, nome, dir: dec.dir, dim: dec.dim, R: dec.R, stopIniziale: stop, tp, cambio, valuta: strumento.valuta,
                   passo: strumento.passo, quando: ora, punti: an.punti, grado: an.grado };
  robot.inAttesa.push(attesa);
  /* lo stato si salva PRIMA dell'ordine: se il giro muore a meta' (la rete,
     il tempo di calcolo), quello dopo sa che c'era un ordine in volo e
     adotta la posizione quando compare */
  if (salva) await salva();
  let r;
  try { r = await apriPosizione(env, epic, dec.dir, dec.dim, stop, tp); }
  catch (e) {
    /* rifiutato: non c'e' niente da aspettare. Altro errore (rete): resta in
       attesa, e se la posizione compare il giro dopo la si adotta */
    if (/rifiutato/i.test(e.message)) {
      robot.inAttesa = robot.inAttesa.filter(x => x !== attesa);
      robot.rifiuti[epic] = { quando: ora, perche: e.message.replace(/^.*?:\s*/, '').slice(0, 80) };
    }
    throw e;
  }
  robot.inAttesa = robot.inAttesa.filter(x => x !== attesa);
  const posizione = { ...attesa, id: r.id, entrata: r.livello || dec.entrata, dim: r.dim, aperta: ora };
  delete posizione.quando;
  robot.aperte.push(posizione);
  lista.push({ id: r.id, epic, dir: dec.dir, stop, dim: r.dim, stato: 'TRADEABLE' });
  const verbo = dec.dir > 0 ? 'Comprate' : 'Vendute';
  nota('aperta', nomePos(posizione) + ': ' + M.fmtNum(r.dim, r.dim % 1 ? 2 : 0) + ' a circa ' + M.fmtPrezzo(posizione.entrata) + ', stop ' + M.fmtPrezzo(stop) + ', take profit ' + M.fmtPrezzo(tp) + '.');
  await telegram(env, '<b>APERTA · ' + html(nomePos(posizione)) + '</b> · grado ' + an.grado + ' (' + M.segno(an.punti) + ')\n' +
    verbo + ' ' + M.fmtNum(r.dim, r.dim % 1 ? 2 : 0) + ' a circa ' + M.fmtPrezzo(posizione.entrata) + '\n' +
    'Stop ' + M.fmtPrezzo(stop) + ' · take profit ' + M.fmtPrezzo(tp) + '\n' +
    'Rischio ' + M.fmtNum(dec.rischio, 2) + ' ' + html(conto.valuta) + ' · margine ' + M.fmtNum(dec.margine, 2) + ' ' + html(conto.valuta) + '\n' +
    html(dec.motivo) + html(piede(robot, conto)));
  return { epic, punti: an.punti, aperta: true, id: r.id, dim: r.dim };
}

/* Avvia: scrive il comando, con il punto di partenza misurato adesso. Lo
   applica il giro del cron, entro un minuto: e' lui che manda ROBOT ACCESO
   su Telegram. Se quel messaggio non arriva, il cron non gira. */
async function avviaRobot(env, ora, b, origine) {
  const M = Motore;
  const conto = await contoAdesso(env);
  if (!conto) throw new Error('Capital.com non manda il conto: non posso fissare il punto di partenza.');
  const lista = (Array.isArray(b.lista) ? b.lista : []).map(String).filter(e => /^[A-Za-z0-9._-]{1,40}$/.test(e)).slice(0, 60);
  if (!lista.length) throw new Error('La lista dei mercati e\' vuota.');
  const perditaMax = Math.min(+b.perditaMax > 0 ? +b.perditaMax : 50, conto.patrimonio > 0 ? conto.patrimonio : Infinity);
  const prima = await leggiKV(env, 'robot:comando'), stato = await leggiKV(env, 'robot');
  /* un "ferma e chiudi" che il giro non ha ancora applicato non si perde */
  const chiudiPrima = !!(prima && prima.azione === 'ferma' && prima.chiudi && prima.id !== (stato && stato.comandoVisto)) || !!(prima && prima.chiudiPrima && prima.id !== (stato && stato.comandoVisto));
  const comando = {
    id: idComando(ora), quando: ora, azione: 'avvia', chi: 'dall\'app', chiudiPrima,
    capitaleIniziale: conto.patrimonio, valuta: conto.valuta,
    impostazioni: {
      perditaMax, maxPosizioni: Math.max(1, Math.min(10, Math.round(+b.maxPosizioni) || 10)),
      stile: M.STILI[b.stile] ? b.stile : 'swing', lista,
      riferimento: /^[A-Za-z0-9._-]{1,40}$/.test(String(b.riferimento || '')) ? String(b.riferimento) : 'US500',
      levaMassima: b.levaMassima !== false,
    },
  };
  await scriviKV(env, 'robot:comando', comando);
  let webhook = null;
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT && origine) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/setWebhook', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: origine + '/tg/' + await segreto(env, 'tg-percorso'), secret_token: await segreto(env, 'tg-intestazione'),
                               allowed_updates: ['message'], drop_pending_updates: true }),
      });
      webhook = (await r.json().catch(() => ({}))).ok === true;
    } catch (e) { webhook = false; }
  }
  return { comando, webhook, conto };
}

/* Ferma: scrive il comando (il giro lo applica e da li' non apre piu'
   niente) e, se chiudi, chiude subito quello che sa essere del robot. Il
   giro dopo richiude quello che fosse rimasto: anche una posizione aperta
   in quel minuto, da un giro che il Ferma non l'aveva ancora visto. */
async function fermaRobot(env, ora, chiudi, chi) {
  const comando = { id: idComando(ora), quando: ora, azione: 'ferma', chiudi: !!chiudi, chi };
  await scriviKV(env, 'robot:comando', comando);
  const stato = { ...robotBase(), ...((await leggiKV(env, 'robot')) || {}) };
  const eraAcceso = !!stato.acceso;
  let esiti = [];
  if (chiudi) {
    const lista = ((await leggi(env, 'positions', new URLSearchParams())).positions || []).map(daCapital);
    const copia = JSON.parse(JSON.stringify(stato));
    copia.inAttesa = copia.inAttesa || [];
    esiti = (await chiudiTutto(env, copia, lista, ora, 'fermato ' + chi)).filter(e => !e.giaChiusa || !e.ok);
  }
  return { esiti, eraAcceso, comando };
}

function comandoPendente(robot, comando) {
  return comando && comando.id !== (robot && robot.comandoVisto) ? comando : null;
}

/* in una riga: perche' non entra, mercato per mercato */
function riassuntoVisti(robot) {
  const v = Object.entries(robot.visti || {});
  if (!v.length) return '';
  const conta = {};
  for (const [, x] of v) {
    const m = String(x.motivo || '').replace(/\s*\(.*$/, '').replace(/^segnale [ABC] /, 'segnale ').replace(/:.*$/, '');
    conta[m] = (conta[m] || 0) + 1;
  }
  return Object.entries(conta).sort((a, b) => b[1] - a[1]).map(([m, k]) => k + ' ' + m).join(' · ');
}

async function testoStato(env) {
  const M = Motore, robot = await leggiKV(env, 'robot'), comando = await leggiKV(env, 'robot:comando');
  const pend = comandoPendente(robot, comando);
  if (!robot && !pend) return 'Il robot non e\' mai stato acceso.';
  const r = robot || {};
  let conto = null;
  try { conto = await contoAdesso(env); } catch (e) { conto = null; }
  const righe = ['<b>ROBOT ' + (r.acceso ? 'ACCESO' : 'SPENTO') + '</b>' + (r.acceso ? ' · ' + M.STILI[stileDi(r)].nome : (r.motivo === 'tetto' ? ' · fermato dal tetto di perdita' : ''))];
  if (pend) righe.push(pend.azione === 'avvia' ? 'Si accende al prossimo giro.' : 'Si ferma al prossimo giro.');
  const ora = Date.now();
  if (r.battito) righe.push('Ultimo giro: ' + Math.max(0, Math.round((ora - r.battito.quando) / 60000)) + ' minuti fa' + (ora - r.battito.quando > 15 * 60000 ? ' — il cron non gira?' : '') + '.');
  else if (pend) righe.push('Nessun giro ancora: se resta cosi\' piu\' di due minuti, su Cloudflare manca il Cron Trigger (* * * * *).');
  if (conto && r.capitaleIniziale != null) righe.push('Dall\'avvio: ' + soldi(conto.patrimonio - r.capitaleIniziale, conto.valuta) + ' (tetto ' + M.fmtNum(r.perditaMax, 0) + ')');
  righe.push('Posizioni del robot: ' + (r.aperte || []).length + '/' + (r.maxPosizioni || 10) + (r.colpi && r.colpi.n ? ' · colpi ' + r.colpi.vinti + ' vinti su ' + r.colpi.n : ''));
  for (const a of r.aperte || []) righe.push('· ' + html(nomePos(a)) + ' ' + M.fmtNum(a.dim, a.dim % 1 ? 2 : 0) + ' da ' + M.fmtPrezzo(a.entrata));
  const visti = riassuntoVisti(r);
  if (r.acceso && visti) righe.push('Ultima occhiata ai mercati: ' + html(visti));
  const ult = (r.diario || [])[0];
  if (ult) righe.push('Ultima cosa: ' + html(ult.testo));
  return righe.join('\n');
}

/* i comandi da Telegram: solo dalla tua chat, solo con i due segreti */
async function comandoTelegram(req, env, url) {
  if (!env.CHIAVE || !env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT) return new Response('no', { status: 404 });
  if (!uguali(url.pathname.slice('/tg/'.length), await segreto(env, 'tg-percorso'))) return new Response('no', { status: 404 });
  if (!uguali(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', await segreto(env, 'tg-intestazione'))) return new Response('no', { status: 403 });
  let u = {};
  try { u = await req.json(); } catch (e) { u = {}; }
  const m = u.message || {};
  if (String(m.chat && m.chat.id) !== String(env.TELEGRAM_CHAT)) return new Response('ok');
  const cmd = String(m.text || '').trim().split(/[\s@]/)[0].toLowerCase();
  const ora = Date.now();
  try {
    if (cmd === '/stop') {
      await fermaRobot(env, ora, false, 'da Telegram');
      await telegram(env, '<b>ROBOT FERMATO</b>\nNon apro piu\' niente. Le posizioni aperte le porto a fine con le loro regole; per chiuderle subito: /chiudi');
    } else if (cmd === '/chiudi') {
      const r = await fermaRobot(env, ora, true, 'da Telegram');
      const male = r.esiti.filter(e => !e.ok).length;
      await telegram(env, '<b>ROBOT FERMATO, POSIZIONI CHIUSE</b>\nChiuse ' + r.esiti.filter(e => e.ok).length + '.' + (male ? ' ' + male + ' NON si sono chiuse: riprovo al prossimo giro, controlla su Capital.com.' : '') +
        '\nSe nel frattempo ne fosse partita un\'altra, la chiudo al prossimo giro.');
    } else if (cmd === '/stato') {
      await telegram(env, await testoStato(env));
    } else {
      await telegram(env, 'Comandi: /stato · /stop (non apro piu\' niente) · /chiudi (fermo e chiudo tutto). Per accendermi usa l\'app.');
    }
  } catch (e) { await telegram(env, 'Errore: ' + html(e.message)); }
  return new Response('ok');
}

/* Un giro alla volta. Se Capital.com risponde lento e un giro dura piu' di
   un minuto, quello dopo non deve partire sopra: due giri insieme leggono
   lo stesso stato del robot, e chi scrive per ultimo cancella quello che ha
   fatto l'altro (una posizione aperta e dimenticata). Il blocco vale per la
   copia del Worker in cui gira; i giri del cron di solito finiscono li'. */
let giroInCorso = null;
/* Le occhiate ai mercati fra una scrittura e l'altra stanno qui, in memoria,
   finche' questa copia del Worker resta viva, e vanno in KV con la scrittura
   dopo (al massimo cinque minuti). Senza, ogni giro ripartirebbe dalla
   copia in KV e si perderebbero quelle dei giri che non scrivono. */
let vistiInMemoria = {};
function unisciVisti(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) if (!out[k] || (v && v.quando > out[k].quando)) out[k] = v;
  return out;
}
let giroDa = 0;
async function sorveglia(env, ora) {
  /* un giro rimasto appeso (una risposta mai arrivata, un'esecuzione chiusa
     da Cloudflare a meta') non deve bloccare per sempre questa copia: dopo
     tre minuti il blocco non vale piu' */
  if (giroInCorso && Date.now() - giroDa < 3 * 60000) return { saltato: 'il giro di prima non e\' ancora finito' };
  const mio = sorvegliaUnGiro(env, ora);
  giroInCorso = mio; giroDa = Date.now();
  try { return await mio; } finally { if (giroInCorso === mio) giroInCorso = null; }
}

async function sorvegliaUnGiro(env, ora) {
  ora = ora || Date.now();
  if (!env.MEMORIA) return { saltato: 'manca il deposito MEMORIA' };
  const letto = await leggiKV(env, 'robot');
  const comando = await leggiKV(env, 'robot:comando');
  const pendente = comandoPendente(letto, comando);
  const robotVivo = !!(pendente || (letto && (letto.acceso || (letto.aperte || []).length || (letto.inAttesa || []).length || letto.chiudiTutto ||
                                              (letto.battito && letto.battito.errore))));
  const avvisi = !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT);
  if (!avvisi && !robotVivo) return { saltato: 'avvisi spenti' };
  const imp = (await leggiKV(env, 'impostazioni')) || {};
  const ctx = { rif: {}, folle: {}, freddi: 0 };
  let lista;
  try { lista = await posizioniAperte(env); }
  catch (e) {
    /* Capital.com non risponde o rifiuta: il giro non si puo' fare. Un Ferma
       pero' si applica lo stesso (per fermarsi non serve Capital.com), e
       l'errore va nello stato: l'app lo mostra, invece di "non gira". */
    if (robotVivo) {
      const robot = { ...robotBase(), ...(letto || {}) };
      const prima = sostanza(robot);
      if (pendente && pendente.azione === 'ferma') applicaComando(robot, pendente, ora, (tipo, testo) => annota(robot, ora, tipo, testo));
      robot.battito = { quando: ora, errore: e.message };
      if (!robot.errori[e.message] || ora - robot.errori[e.message] > 30 * 60000) {
        robot.errori[e.message] = ora;
        annota(robot, ora, 'errore', 'Giro saltato: ' + e.message);
        await telegram(env, '<b>ROBOT · il giro non parte</b>\nCapital.com: ' + html(e.message) + (pendente && pendente.azione === 'ferma' ? '\nIl Ferma l\'ho applicato lo stesso.' : ''));
      }
      if (sostanza(robot) !== prima || ora - (robot.scritto || 0) >= BATTITO_MS) { robot.scritto = ora; await scriviKV(env, 'robot', robot); }
    }
    throw e;
  }
  let esitoRobot = null, robot = letto;
  if (robotVivo) {
    robot = { ...robotBase(), ...(letto || {}) };
    robot.visti = unisciVisti(robot.visti, vistiInMemoria);
    const prima = sostanza(robot);
    /* KV accetta una scrittura al secondo sulla stessa chiave: prima e dopo
       un ordine si salva due volte in pochi istanti, quindi si aspetta il
       giusto, e se KV dice di no si riprova una volta */
    let ultimaScritta = 0;
    const salva = async () => {
      robot.scritto = ora;
      const attesa = ultimaScritta + 1100 - Date.now();
      if (attesa > 0) await new Promise(ok => setTimeout(ok, attesa));
      try { await scriviKV(env, 'robot', robot); }
      catch (e) { await new Promise(ok => setTimeout(ok, 1100)); await scriviKV(env, 'robot', robot); }
      ultimaScritta = Date.now();
    };
    /* il riferimento dipende dallo stile, che un Avvia puo' cambiare: lo
       decide il giro dopo aver letto il comando, qui serve solo il nome */
    const rifEpic = (pendente && pendente.impostazioni && pendente.impostazioni.riferimento) || robot.riferimento || imp.riferimento || env.RIFERIMENTO || 'US500';
    try { esitoRobot = await giroRobot(env, ctx, robot, lista, rifEpic, ora, { comando, salva }); }
    catch (e) {
      esitoRobot = { errore: e.message };
      robot.battito = { ...(robot.battito || { quando: ora }), errore: e.message };
      robot.errori = robot.errori || {};
      if (!robot.errori[e.message] || ora - robot.errori[e.message] > 30 * 60000) {
        robot.errori[e.message] = ora;
        annota(robot, ora, 'errore', e.message);
        await telegram(env, '<b>ROBOT · il giro si ferma</b>\n' + html(e.message));
      }
    }
    vistiInMemoria = { ...robot.visti };
    /* un errore nel battito si toglie subito appena un giro va bene: l'app
       non deve continuare a mostrarlo per cinque minuti */
    const errorePassato = !!(letto && letto.battito && letto.battito.errore) && !(robot.battito && robot.battito.errore);
    if (sostanza(robot) !== prima || errorePassato || ora - (robot.scritto || 0) >= BATTITO_MS) await salva();
  }
  const rifEpic = (robot && robot.acceso && robot.riferimento) || imp.riferimento || env.RIFERIMENTO || 'US500';
  /* le posizioni del robot le gestisce lui: gli avvisi sono per le altre */
  const delRobot = new Set(((robot && robot.aperte) || []).map(a => a.id));
  const altre = lista.filter(p => !delRobot.has(p.id));
  const limite = robotVivo ? (+env.ROBOT_CALCOLI > 0 ? +env.ROBOT_CALCOLI : 3) + 1 : Infinity;
  const uscite = avvisi ? await sorvegliaUscite(env, ctx, altre, imp, rifEpic, ora, limite) : { saltato: 'avvisi spenti' };
  let ingressi = { saltato: 'il robot e\' acceso: gli ingressi li fa lui' };
  if (avvisi && !(robot && robot.acceso)) {
    try { ingressi = await sorvegliaIngressi(env, ctx, lista, imp, rifEpic, ora); }
    catch (e) { ingressi = { errore: e.message }; }
  }
  return { ...uscite, robot: esitoRobot, ingressi, calcoli: ctx.freddi };
}

/* ─────────────────────────── le porte ─────────────────────────── */

async function gestisci(req, env, ctx) {
  const url = new URL(req.url);
  const cors = intestazioniCors(req, env);
  const extra = cors || {};

  if (req.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
  if (url.pathname === '/' || url.pathname === '') {
    return new Response('Mirino · il ponte verso Capital.com e\' acceso (' + (eDemo(env) ? 'conto demo' : 'conto reale') + ').\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname.startsWith('/tg/') && req.method === 'POST') return comandoTelegram(req, env, url);
  if (!url.pathname.startsWith('/api/')) return json({ errore: 'Non c\'e\' niente qui.' }, 404, extra);

  const ip = req.headers.get('CF-Connecting-IP') || 'ignoto';
  if (bloccato(ip)) return json({ errore: 'Troppi codici sbagliati da questo indirizzo. Riprova fra un\'ora.' }, 429, extra);
  if (!env.CHIAVE) return json({ errore: 'Il ponte non ha ancora la CHIAVE: mettila fra i segreti del Worker.' }, 500, extra);
  if (!autorizzato(req, env)) { segnaSbaglio(ip); return json({ errore: 'Codice d\'accesso sbagliato.' }, 401, extra); }

  try {
    if (url.pathname === '/api/stato' && req.method === 'GET') {
      let conto = null, problema = null;
      try {
        const a = await leggi(env, 'accounts', new URLSearchParams());
        const c = (a.accounts || []).find(x => x.preferred) || (a.accounts || [])[0];
        if (c) conto = { id: c.accountId, nome: c.accountName, valuta: c.currency, saldo: c.balance && c.balance.balance,
                         disponibile: c.balance && c.balance.available, pnl: c.balance && c.balance.profitLoss };
      } catch (e) { problema = e.message; }
      return json({ ok: !problema, versione: VERSIONE, demo: eDemo(env), conto, problema,
                    telegram: !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT), memoria: !!env.MEMORIA }, 200, extra);
    }
    if (url.pathname.startsWith('/api/cap/') && req.method === 'GET') {
      const percorso = decodeURIComponent(url.pathname.slice('/api/cap/'.length));
      return json(await leggi(env, percorso, url.searchParams), 200, extra);
    }
    if (url.pathname === '/api/impostazioni' && req.method === 'GET') {
      return json({ memoria: !!env.MEMORIA, impostazioni: (await leggiKV(env, 'impostazioni')) || null }, 200, extra);
    }
    if (url.pathname === '/api/impostazioni' && req.method === 'POST') {
      if (!env.MEMORIA) return json({ errore: 'Senza il deposito MEMORIA il ponte non puo\' ricordare niente.' }, 400, extra);
      const b = await req.json();
      const imp = {
        lista: (Array.isArray(b.lista) ? b.lista : []).map(String).filter(e => /^[A-Za-z0-9._-]{1,40}$/.test(e)).slice(0, 60),
        profilo: Motore.PROFILI[b.profilo] ? b.profilo : 'aggressivo',
        stile: Motore.STILI[b.stile] ? b.stile : 'swing',
        budget: +b.budget > 0 ? +b.budget : null,
        riferimento: /^[A-Za-z0-9._-]{1,40}$/.test(String(b.riferimento || '')) ? String(b.riferimento) : 'US500',
        valuta: /^[A-Z]{3}$/.test(String(b.valuta || '')) ? String(b.valuta) : '',
        ingressi: b.ingressi !== false,
      };
      await scriviKV(env, 'impostazioni', imp);
      return json({ ok: true, impostazioni: imp }, 200, extra);
    }
    if (url.pathname === '/api/segui' && req.method === 'GET') {
      const manuali = (await leggiKV(env, 'manuali')) || [];
      return json({ memoria: !!env.MEMORIA, manuali }, 200, extra);
    }
    if (url.pathname === '/api/segui' && req.method === 'POST') {
      if (!env.MEMORIA) return json({ errore: 'Senza il deposito MEMORIA il ponte non puo\' ricordare niente.' }, 400, extra);
      const b = await req.json();
      const id = String(b.id || '').slice(0, 80);
      if (!id) return json({ errore: 'Manca l\'id della posizione.' }, 400, extra);
      const imp = {
        stile: Motore.STILI[b.stile] ? b.stile : 'swing',
        R: +b.R > 0 ? +b.R : undefined, stopIniziale: Number.isFinite(+b.stopIniziale) ? +b.stopIniziale : undefined,
        parziale: !!b.parziale, rinforzata: !!b.rinforzata, puntiEntrata: Number.isFinite(+b.puntiEntrata) ? +b.puntiEntrata : undefined,
        passo: +b.passo > 0 ? +b.passo : undefined, riferimento: String(b.riferimento || 'US500').slice(0, 40),
      };
      await scriviKV(env, 'segui:' + id, imp);
      /* una posizione presa a mano (non su questo conto Capital.com): il
         ponte se la segna per sorvegliarla lo stesso */
      if (b.manuale) {
        const manuali = ((await leggiKV(env, 'manuali')) || []).filter(m => m.id !== id);
        manuali.push({ id, epic: String(b.epic).slice(0, 40), nome: String(b.nome || b.epic).slice(0, 80), dir: b.dir < 0 ? -1 : 1,
                       entrata: +b.entrata, dim: +b.dim, aperta: +b.aperta || Date.now(), stop: Number.isFinite(+b.stop) ? +b.stop : null,
                       valuta: String(b.valuta || '').slice(0, 5) });
        await scriviKV(env, 'manuali', manuali.slice(-20));
      }
      return json({ ok: true, imp }, 200, extra);
    }
    if (url.pathname.startsWith('/api/segui/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/segui/'.length));
      const manuali = ((await leggiKV(env, 'manuali')) || []).filter(m => m.id !== id);
      await scriviKV(env, 'manuali', manuali);
      if (env.MEMORIA) { await env.MEMORIA.delete('segui:' + id); await env.MEMORIA.delete('avviso:' + id); }
      return json({ ok: true }, 200, extra);
    }
    if (url.pathname === '/api/telegram/prova' && req.method === 'POST') {
      const r = await telegram(env, '<b>Mirino</b>\nGli avvisi arrivano qui: quando un mercato della lista e\' pronto per entrare, e quando una posizione aperta va toccata.' +
        (env.MEMORIA ? '' : '\n\nAttenzione: manca il deposito MEMORIA, senza gli avvisi automatici restano spenti.'));
      return json(r, r.ok ? 200 : 400, extra);
    }
    if (url.pathname === '/api/sorveglia' && req.method === 'POST') {
      return json(await sorveglia(env, Date.now()), 200, extra);
    }
    if (url.pathname === '/api/robot' && req.method === 'GET') {
      const robot = await leggiKV(env, 'robot');
      const comando = comandoPendente(robot, await leggiKV(env, 'robot:comando'));
      let conto = null, lista = [], problema = null;
      try {
        conto = await contoAdesso(env);
        lista = ((await leggi(env, 'positions', new URLSearchParams())).positions || []).map(daCapital);
      } catch (e) { problema = e.message; }
      const aperte = ((robot && robot.aperte) || []).map(a => {
        const p = lista.find(x => x.id === a.id);
        return { ...a, prezzo: p ? (a.dir > 0 ? p.bid : p.ask) : null, stop: p ? p.stop : (a.stop != null ? a.stop : null), presente: !!p };
      });
      return json({
        versione: VERSIONE, demo: eDemo(env), memoria: !!env.MEMORIA, telegram: !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT), ora: Date.now(),
        robot: robot ? { ...robot, aperte } : null,
        comando: comando ? { azione: comando.azione, quando: comando.quando, chiudi: !!comando.chiudi, impostazioni: comando.impostazioni || null } : null,
        conto, problema,
        /* con un Avvia in arrivo il punto di partenza vecchio non vale piu' */
        risultato: robot && conto && robot.capitaleIniziale != null && !(comando && comando.azione === 'avvia') ? conto.patrimonio - robot.capitaleIniziale : null,
      }, 200, extra);
    }
    if (url.pathname === '/api/robot/avvia' && req.method === 'POST') {
      if (!env.MEMORIA) return json({ errore: 'Senza il deposito MEMORIA il robot non puo\' ricordare cosa ha aperto: collegalo prima.' }, 400, extra);
      const r = await avviaRobot(env, Date.now(), await req.json(), url.origin);
      return json({ ok: true, comando: { azione: 'avvia', quando: r.comando.quando, impostazioni: r.comando.impostazioni }, webhook: r.webhook }, 200, extra);
    }
    if (url.pathname === '/api/robot/ferma' && req.method === 'POST') {
      if (!env.MEMORIA) return json({ errore: 'Senza il deposito MEMORIA non c\'e\' un robot da fermare.' }, 400, extra);
      let b = {};
      try { b = await req.json(); } catch (e) { b = {}; }
      const r = await fermaRobot(env, Date.now(), !!b.chiudi, 'dall\'app');
      if (r.eraAcceso || b.chiudi) {
        await telegram(env, '<b>ROBOT FERMATO</b> dall\'app.\n' + (b.chiudi
          ? 'Chiuse ' + r.esiti.filter(e => e.ok).length + ' posizioni' + (r.esiti.some(e => !e.ok) ? ', ' + r.esiti.filter(e => !e.ok).length + ' NON si sono chiuse: riprovo al prossimo giro, controlla su Capital.com' : '') + '.'
          : 'Non apro piu\' niente; le posizioni aperte le porto a fine con le loro regole.'));
      }
      return json({ ok: true, esiti: r.esiti, comando: { azione: 'ferma', quando: r.comando.quando, chiudi: !!b.chiudi } }, 200, extra);
    }
    return json({ errore: 'Non c\'e\' niente qui.' }, 404, extra);
  } catch (e) {
    const stato = e instanceof ErroreCapital ? e.stato : 500;
    return json({ errore: e.message || String(e) }, stato, extra);
  }
}

export default {
  fetch: gestisci,
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(sorveglia(env, evento && evento.scheduledTime).catch(e => console.log('sorveglianza:', e.message)));
  },
};
