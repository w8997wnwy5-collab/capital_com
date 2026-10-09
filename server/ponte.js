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
     — le fa il robot, da solo, con le regole del motore, e solo quando lo
     accendi tu. Non esiste un indirizzo del ponte che inoltri un ordine
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
     GET  /api/robot               il robot: acceso?, conto, posizioni, diario
     POST /api/robot/avvia         accendilo (budget, tetto di perdita, posti)
     POST /api/robot/ferma         spegnilo; {chiudi: true} chiude anche tutto
   Senza codice, ma con un segreto nel percorso e uno nell'intestazione:
     POST /tg/<segreto>            i comandi da Telegram: /stato /stop /chiudi
   ══════════════════════════════════════════════════════════════════════════ */

const VERSIONE = '2.0';
const SERVER_REALE = 'https://api-capital.backend-capital.com';
const SERVER_DEMO = 'https://demo-api-capital.backend-capital.com';
const ORIGINI_PREDEFINITE = 'https://w8997wnwy5-collab.github.io';
const APP_PREDEFINITA = 'https://w8997wnwy5-collab.github.io/capital_com/';

/* Capital.com chiude la sessione dopo dieci minuti senza richieste. Si
   rinnova a otto, prima che lo faccia lei. */
const SESSIONE_MS = 8 * 60000;

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
];

async function scriviCapital(env, metodo, percorso, corpo, tentativo = 0) {
  if (!SCRITTURE.some(w => w.metodo === metodo && w.re.test(percorso))) throw new ErroreCapital(403, 'Scrittura non ammessa: ' + metodo + ' ' + percorso);
  const s = await sessioneValida(env);
  const r = await fetch(server(env) + '/api/v1/' + percorso, {
    method: metodo,
    headers: { 'X-SECURITY-TOKEN': s.token, 'CST': s.cst, 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
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
  });
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
/* il riferimento (l'S&P 500) con i suoi indicatori, una volta per giro */
async function riferimentoDi(env, ctx, rifEpic, S) {
  const chiave = rifEpic + '|' + S.segnale;
  if (!ctx.rif[chiave]) {
    const cs = await candeleDi(env, rifEpic, S.segnale, S.candeleVive);
    if (!indicatoriGia.has(cs)) { indicatoriGia.set(cs, Motore.indicatori(cs)); ctx.freddi = (ctx.freddi || 0) + 1; }
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

async function sorvegliaUscite(env, ctx, lista, imp, rifEpic, ora) {
  const aperte = lista.filter(p => p.stato === 'TRADEABLE');
  const mandati = [];
  for (const pos of aperte) {
    try {
      let seg = await leggiKV(env, 'segui:' + pos.id);
      if (!seg) {
        /* la prima volta: si fissa il rischio iniziale, che da qui non cambia */
        seg = { stile: imp.stile || env.STILE || 'swing', riferimento: rifEpic };
        if (pos.stop != null && (pos.stop - pos.entrata) * pos.dir < 0) seg.stopIniziale = pos.stop;
        await scriviKV(env, 'segui:' + pos.id, seg);
      }
      const S = Motore.STILI[seg.stile] || Motore.STILI.swing;
      if (!seg.R && seg.stopIniziale == null) {
        const cs = await candeleDi(env, pos.epic, S.segnale, S.candeleVive);
        const R = Motore.rischioIniziale(cs, Motore.indicatori(cs), pos.aperta);
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
   ogni minuto. Lo stato sta in KV sotto 'robot', una chiave sola, letta
   all'inizio del giro e scritta alla fine solo se qualcosa e' cambiato:

     acceso, avviato, fermato, motivo
     capitaleIniziale   il patrimonio (saldo + risultato aperto) all'avvio
     perditaMax         il tetto: arrivato li' si ferma e chiude tutto
     maxPosizioni, budget, stile, lista, riferimento, valuta
     aperte             le posizioni aperte dal robot: le altre non le tocca
     inAttesa           ordini mandati di cui non si e' vista la conferma
     chiuse             l'ultima chiusura per mercato, per non rientrare subito
     diario             le ultime 40 cose fatte

   L'ordine di un giro:
     1. il conto: se la perdita dall'avvio ha raggiunto il tetto, si ferma e
        chiude tutte le sue posizioni;
     2. le sue posizioni che non ci sono piu' (stop o take profit scattati su
        Capital.com) escono dalla lista;
     3. per ognuna delle sue posizioni: chiudere, spostare lo stop, o niente.
        Anche da fermo: "Ferma" vuol dire che non apre piu' niente, non che
        abbandona quello che ha aperto;
     4. se e' acceso: un mercato della lista, a rotazione, e se e' pronto per
        il profilo Estremo si apre.

   Il calcolo e' la risorsa scarsa (10 ms a giro sul piano gratuito): gli
   indicatori di un mercato si tengono finche' le sue candele sono le
   stesse, e in un giro se ne ricalcolano al massimo ROBOT_CALCOLI. Le
   posizioni saltate si guardano al giro dopo; intanto stop e take profit
   sono gia' su Capital.com. */

const ROBOT_BASE = { acceso: false, aperte: [], inAttesa: [], chiuse: {}, diario: [] };

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
    ' · posizioni ' + (robot.aperte || []).length + '/' + robot.maxPosizioni;
}

async function chiudiTutto(env, robot, ora, motivo) {
  const esiti = [];
  for (const a of (robot.aperte || []).slice()) {
    try {
      const r = await chiudiPosizione(env, a.id);
      robot.aperte = robot.aperte.filter(x => x.id !== a.id);
      robot.chiuse[a.epic] = { dir: a.dir, quando: ora };
      annota(robot, ora, 'chiusa', nomePos(a) + ': chiusa (' + motivo + ')' + (r.profitto != null ? ', ' + soldi(r.profitto, r.valuta) : '') + '.');
      esiti.push({ id: a.id, ok: true, profitto: r.profitto, valuta: r.valuta });
    } catch (e) {
      annota(robot, ora, 'errore', nomePos(a) + ': non riesco a chiuderla (' + e.message + ').');
      esiti.push({ id: a.id, ok: false, errore: e.message });
    }
  }
  return esiti;
}

async function giroRobot(env, ctx, robot, lista, rifEpic, ora) {
  const M = Motore, out = { azioni: [] };
  robot.aperte = robot.aperte || []; robot.inAttesa = robot.inAttesa || []; robot.chiuse = robot.chiuse || {}; robot.diario = robot.diario || [];
  const stile = M.STILI[robot.stile] ? robot.stile : 'swing', S = M.STILI[stile];
  const nota = (tipo, testo) => { annota(robot, ora, tipo, testo); out.azioni.push(tipo + ': ' + testo); };
  const errore = testo => {
    /* lo stesso errore si scrive una volta ogni mezz'ora: ogni scrittura in
       KV conta, e un errore che si ripete ogni minuto le brucerebbe tutte */
    const u = robot.ultimoErrore;
    if (u && u.testo === testo && ora - u.quando < 30 * 60000) return;
    robot.ultimoErrore = { testo, quando: ora };
    nota('errore', testo);
  };

  /* 1. il conto e il tetto */
  const conto = await contoAdesso(env);
  if (!conto) throw new Error('Capital.com non manda il conto.');
  const perdita = Math.max(0, robot.capitaleIniziale - conto.patrimonio);
  out.conto = conto; out.perdita = perdita;
  if (robot.acceso && perdita >= robot.perditaMax) {
    robot.acceso = false; robot.fermato = ora; robot.motivo = 'tetto';
    nota('tetto', 'Perdita dall\'avvio ' + M.fmtNum(perdita, 2) + ' ' + conto.valuta + ': tetto di ' + M.fmtNum(robot.perditaMax, 0) + ' raggiunto. Mi fermo e chiudo tutto.');
    const esiti = await chiudiTutto(env, robot, ora, 'tetto di perdita');
    await telegram(env, '<b>ROBOT FERMATO · tetto di perdita</b>\nPerdita dall\'avvio ' + M.fmtNum(perdita, 2) + ' ' + html(conto.valuta) +
      '. Ho chiuso ' + esiti.filter(e => e.ok).length + ' posizioni' + (esiti.some(e => !e.ok) ? ', ' + esiti.filter(e => !e.ok).length + ' NON si sono chiuse: controlla su Capital.com' : '') + '.');
    return out;
  }

  /* 2. quello che e' successo su Capital.com dall'ultimo giro */
  const presenti = new Map(lista.map(p => [p.id, p]));
  for (const w of robot.inAttesa.slice()) {
    /* un ordine partito senza conferma (la rete, un timeout): se la
       posizione e' comparsa, e' sua */
    const trovata = lista.find(p => p.epic === w.epic && p.dir === w.dir && !robot.aperte.some(a => a.id === p.id) && Math.abs(p.aperta - w.quando) < 10 * 60000);
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
    robot.aperte = robot.aperte.filter(x => x.id !== a.id);
    robot.chiuse[a.epic] = { dir: a.dir, quando: ora };
    nota('chiusa', nomePos(a) + ': l\'ha chiusa Capital.com (stop o take profit).');
    await telegram(env, '<b>CHIUSA · ' + html(nomePos(a)) + '</b>\nL\'ha chiusa Capital.com: e\' scattato lo stop o il take profit.' + html(piede(robot, conto)));
  }

  /* 3. le sue posizioni, a rotazione, con un tetto ai calcoli da capo */
  const limite = +env.ROBOT_CALCOLI > 0 ? +env.ROBOT_CALCOLI : 4;
  const giro = Math.floor(ora / 60000), n = robot.aperte.length;
  const ordine = robot.aperte.map((_, i) => robot.aperte[(i + giro) % n]);
  for (const a of ordine) {
    const pos = presenti.get(a.id);
    if (!pos || pos.stato !== 'TRADEABLE') continue;
    try {
      if ((ctx.freddi || 0) >= limite && await sarebbeFreddo(env, ctx, pos.epic, S, rifEpic)) { out.rimandate = (out.rimandate || 0) + 1; continue; }
      const c = await consiglioPer(env, ctx, pos, { stile, R: a.R, stopIniziale: a.stopIniziale, parziale: true, rinforzata: true, passo: a.passo }, rifEpic, ora);
      const d = M.robotUscita(c, { dir: pos.dir, stop: pos.stop }, stile);
      if (d.azione === 'chiudi') {
        const r = await chiudiPosizione(env, pos.id);
        robot.aperte = robot.aperte.filter(x => x.id !== a.id);
        robot.chiuse[a.epic] = { dir: a.dir, quando: ora };
        const esito = r.profitto != null ? ' Risultato ' + soldi(r.profitto, r.valuta) + '.' : '';
        nota('chiusa', nomePos(a) + ': ' + d.motivo + esito);
        await telegram(env, '<b>CHIUSA · ' + html(nomePos(a)) + '</b>\n' + html(d.motivo) + html(esito) + html(piede(robot, conto)));
      } else if (d.azione === 'stop') {
        const dmk = await leggi(env, 'markets/' + pos.epic, new URLSearchParams());
        const livello = arrotonda(d.livello, decimaliDi(dmk, d.livello));
        await spostaStop(env, pos.id, livello, a.tp);
        nota('stop', nomePos(a) + ': stop a ' + M.fmtPrezzo(livello) + '. ' + d.motivo);
        await telegram(env, '<b>STOP SPOSTATO · ' + html(nomePos(a)) + '</b>\nStop a ' + M.fmtPrezzo(livello) + '. ' + html(d.motivo));
      }
    } catch (e) { errore(nomePos(a) + ': ' + e.message); }
  }

  /* 4. gli ingressi */
  if (robot.acceso && (robot.lista || []).length) {
    const quanti = +env.ROBOT_MERCATI_PER_GIRO > 0 ? Math.min(5, +env.ROBOT_MERCATI_PER_GIRO) : 1;
    for (let i = 0; i < quanti; i++) {
      const epic = robot.lista[(giro * quanti + i) % robot.lista.length];
      try { out.entrata = await entrataRobot(env, ctx, robot, epic, lista, conto, perdita, rifEpic, ora, nota); }
      catch (e) { errore(epic + ': ' + e.message); }
    }
  }
  return out;
}

async function entrataRobot(env, ctx, robot, epic, lista, conto, perdita, rifEpic, ora, nota) {
  const M = Motore, stile = M.STILI[robot.stile] ? robot.stile : 'swing', S = M.STILI[stile];
  if (robot.inAttesa.some(w => w.epic === epic)) return { epic, motivo: 'ordine in attesa di conferma' };
  const d = await leggi(env, 'markets/' + epic, new URLSearchParams());
  const sn = d.snapshot || {};
  if (sn.marketStatus !== 'TRADEABLE') return { epic, motivo: 'mercato chiuso' };
  const cs = await candeleDi(env, epic, S.segnale, S.candeleVive);
  const ct = await candeleDi(env, epic, S.tempo, S.candeleTempo);
  const rif = epic === rifEpic ? null : await riferimentoDi(env, ctx, rifEpic, S);
  const folle = await follaDi(env, ctx, [epic]);
  const prezzo = sn.bid > 0 && sn.offer > 0 ? { bid: sn.bid, ask: sn.offer } : null;
  const an = M.analizza(cs, ct, { ser: serDi(ctx, cs, rif), rif, percLunghi: folle[epic], prezzo });
  if (!M.pronto(an, M.ROBOT.profilo)) return { epic, punti: an.punti, motivo: 'nessun segnale' };

  let leve = null;
  try { leve = (await leggi(env, 'accounts/preferences', new URLSearchParams())).leverages || null; } catch (e) { leve = null; }
  const strumento = M.strumentoDa(d, leve);
  const cambio = await cambioVerso(env, strumento.valuta, conto.valuta);
  const p = M.piano({ an, budget: robot.budget, profilo: M.ROBOT.profilo, stile, strumento, cambio,
                      notte: M.notteDa(d.instrument && d.instrument.overnightFee) || undefined });
  /* il rischio gia' in gioco: per ogni sua posizione, quanto si perde se
     scatta lo stop che c'e' adesso su Capital.com (a pareggio vale zero) */
  const rischioAperto = robot.aperte.reduce((t, a) => {
    const pos = lista.find(x => x.id === a.id);
    const stop = pos && pos.stop != null ? pos.stop : a.stopIniziale;
    return t + Math.max(0, (a.entrata - stop) * a.dir) * a.dim * (a.cambio || 1);
  }, 0);
  const dec = M.robotEntrata({
    an, piano: p, ora, stile,
    stato: { aperte: lista.length, maxPosizioni: robot.maxPosizioni, residuo: robot.perditaMax - perdita, rischioAperto, disponibile: conto.disponibile },
    giaDentro: lista.some(x => x.epic === epic), chiusaDiRecente: robot.chiuse[epic],
    orario: M.orari(d.instrument && d.instrument.openingHours, ora),
  });
  if (!dec.apri) return { epic, punti: an.punti, motivo: dec.motivo };

  const decimali = decimaliDi(d, p.entrata);
  const stop = arrotonda(dec.stop, decimali), tp = arrotonda(dec.tp, decimali);
  const nome = (d.instrument && d.instrument.name) || epic;
  const attesa = { epic, nome, dir: dec.dir, dim: dec.dim, R: dec.R, stopIniziale: stop, tp, cambio, valuta: strumento.valuta,
                   passo: strumento.passo, quando: ora, punti: an.punti, grado: an.grado };
  robot.inAttesa.push(attesa);
  let r;
  try { r = await apriPosizione(env, epic, dec.dir, dec.dim, stop, tp); }
  catch (e) {
    /* rifiutato: non c'e' niente da aspettare. Altro errore (rete): resta in
       attesa, e se la posizione compare il giro dopo la si adotta */
    if (/rifiutato/i.test(e.message)) robot.inAttesa = robot.inAttesa.filter(x => x !== attesa);
    throw e;
  }
  robot.inAttesa = robot.inAttesa.filter(x => x !== attesa);
  const posizione = { ...attesa, id: r.id, entrata: r.livello || dec.entrata, dim: r.dim, aperta: ora };
  delete posizione.quando;
  robot.aperte.push(posizione);
  lista.push({ id: r.id, epic, dir: dec.dir, stop, stato: 'TRADEABLE' });
  const verbo = dec.dir > 0 ? 'Comprate' : 'Vendute';
  nota('aperta', nomePos(posizione) + ': ' + M.fmtNum(r.dim, r.dim % 1 ? 2 : 0) + ' a circa ' + M.fmtPrezzo(posizione.entrata) + ', stop ' + M.fmtPrezzo(stop) + ', take profit ' + M.fmtPrezzo(tp) + '.');
  await telegram(env, '<b>APERTA · ' + html(nomePos(posizione)) + '</b> · grado ' + an.grado + ' (' + M.segno(an.punti) + ')\n' +
    verbo + ' ' + M.fmtNum(r.dim, r.dim % 1 ? 2 : 0) + ' a circa ' + M.fmtPrezzo(posizione.entrata) + '\n' +
    'Stop ' + M.fmtPrezzo(stop) + ' · take profit ' + M.fmtPrezzo(tp) + '\n' +
    'Rischio ' + M.fmtNum(dec.rischio, 2) + ' ' + html(conto.valuta) + ' · margine ' + M.fmtNum(dec.margine, 2) + ' ' + html(conto.valuta) + '\n' +
    html(dec.motivo) + html(piede(robot, conto)));
  return { epic, aperta: true, id: r.id, dim: r.dim };
}

async function avviaRobot(env, ora, b, origine) {
  const M = Motore;
  const conto = await contoAdesso(env);
  if (!conto) throw new Error('Capital.com non manda il conto: non posso fissare il punto di partenza.');
  const vecchio = (await leggiKV(env, 'robot')) || {};
  const lista = (Array.isArray(b.lista) ? b.lista : []).map(String).filter(e => /^[A-Za-z0-9._-]{1,40}$/.test(e)).slice(0, 60);
  if (!lista.length) throw new Error('La lista dei mercati e\' vuota.');
  const perditaMax = Math.min(+b.perditaMax > 0 ? +b.perditaMax : 50, conto.patrimonio > 0 ? conto.patrimonio : Infinity);
  const robot = {
    ...ROBOT_BASE, ...vecchio,
    acceso: true, avviato: ora, fermato: null, motivo: '', ultimoErrore: null,
    capitaleIniziale: conto.patrimonio, perditaMax,
    maxPosizioni: Math.max(1, Math.min(10, Math.round(+b.maxPosizioni) || 10)),
    budget: +b.budget > 0 ? +b.budget : perditaMax,
    stile: M.STILI[b.stile] ? b.stile : 'swing', lista,
    riferimento: /^[A-Za-z0-9._-]{1,40}$/.test(String(b.riferimento || '')) ? String(b.riferimento) : 'US500',
    valuta: conto.valuta,
  };
  annota(robot, ora, 'acceso', 'Acceso. Tetto di perdita ' + M.fmtNum(perditaMax, 2) + ' ' + conto.valuta + ', fino a ' + robot.maxPosizioni +
    ' posizioni, budget ' + M.fmtNum(robot.budget, 0) + ', ' + lista.length + ' mercati, ' + M.STILI[robot.stile].nome + '.');
  await scriviKV(env, 'robot', robot);
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
    await telegram(env, '<b>ROBOT ACCESO</b>\nPatrimonio di partenza ' + M.fmtNum(conto.patrimonio, 2) + ' ' + html(conto.valuta) +
      '. Tetto di perdita ' + M.fmtNum(perditaMax, 2) + ': arrivato li\' mi fermo e chiudo tutto.\nFino a ' + robot.maxPosizioni + ' posizioni, ' +
      lista.length + ' mercati, profilo Estremo, ' + M.STILI[robot.stile].nome + '.\n' +
      (webhook ? 'Comandi: /stato · /stop (non apro piu\' niente) · /chiudi (fermo e chiudo tutto)' : 'I comandi da Telegram non sono attivi: fermami dall\'app.'));
  }
  return { robot, webhook };
}

async function fermaRobot(env, ora, chiudi, chi) {
  const robot = { ...ROBOT_BASE, ...((await leggiKV(env, 'robot')) || {}) };
  const eraAcceso = robot.acceso;
  robot.acceso = false; robot.fermato = ora; robot.motivo = chi;
  annota(robot, ora, 'fermo', 'Fermato ' + chi + (chiudi ? ', con chiusura di tutte le posizioni.' : '. Non apro piu\' niente; le posizioni aperte le porto a fine con le loro regole.'));
  const esiti = chiudi ? await chiudiTutto(env, robot, ora, 'fermato ' + chi) : [];
  await scriviKV(env, 'robot', robot);
  return { robot, esiti, eraAcceso };
}

async function testoStato(env) {
  const M = Motore, robot = await leggiKV(env, 'robot');
  if (!robot) return 'Il robot non e\' mai stato acceso.';
  let conto = null;
  try { conto = await contoAdesso(env); } catch (e) { conto = null; }
  const righe = ['<b>ROBOT ' + (robot.acceso ? 'ACCESO' : 'SPENTO') + '</b>' + (robot.acceso ? '' : (robot.motivo === 'tetto' ? ' · fermato dal tetto di perdita' : ''))];
  if (conto) righe.push('Dall\'avvio: ' + soldi(conto.patrimonio - robot.capitaleIniziale, conto.valuta) + ' (tetto ' + M.fmtNum(robot.perditaMax, 0) + ')');
  righe.push('Posizioni del robot: ' + (robot.aperte || []).length + '/' + robot.maxPosizioni);
  for (const a of robot.aperte || []) righe.push('· ' + html(nomePos(a)) + ' ' + M.fmtNum(a.dim, a.dim % 1 ? 2 : 0) + ' da ' + M.fmtPrezzo(a.entrata));
  const ult = (robot.diario || [])[0];
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
      await telegram(env, '<b>ROBOT FERMATO, POSIZIONI CHIUSE</b>\nChiuse ' + r.esiti.filter(e => e.ok).length + '.' + (male ? ' ' + male + ' NON si sono chiuse: controlla su Capital.com.' : ''));
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
async function sorveglia(env, ora) {
  if (giroInCorso) return { saltato: 'il giro di prima non e\' ancora finito' };
  giroInCorso = sorvegliaUnGiro(env, ora);
  try { return await giroInCorso; } finally { giroInCorso = null; }
}

async function sorvegliaUnGiro(env, ora) {
  ora = ora || Date.now();
  if (!env.MEMORIA) return { saltato: 'manca il deposito MEMORIA' };
  const robot = await leggiKV(env, 'robot');
  const robotVivo = !!(robot && (robot.acceso || (robot.aperte || []).length || (robot.inAttesa || []).length));
  const avvisi = !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT);
  if (!avvisi && !robotVivo) return { saltato: 'avvisi spenti' };
  const imp = (await leggiKV(env, 'impostazioni')) || {};
  const rifEpic = (robotVivo && robot.riferimento) || imp.riferimento || env.RIFERIMENTO || 'US500';
  const ctx = { rif: {}, folle: {}, freddi: 0 };
  const lista = await posizioniAperte(env);
  let esitoRobot = null;
  if (robotVivo) {
    const prima = JSON.stringify(robot);
    try { esitoRobot = await giroRobot(env, ctx, robot, lista, rifEpic, ora); }
    catch (e) {
      esitoRobot = { errore: e.message };
      if (!robot.ultimoErrore || robot.ultimoErrore.testo !== e.message || ora - robot.ultimoErrore.quando > 30 * 60000) {
        robot.ultimoErrore = { testo: e.message, quando: ora };
        annota(robot, ora, 'errore', e.message);
      }
    }
    if (JSON.stringify(robot) !== prima) await scriviKV(env, 'robot', robot);
  }
  /* le posizioni del robot le gestisce lui: gli avvisi sono per le altre */
  const delRobot = new Set(((robot && robot.aperte) || []).map(a => a.id));
  const altre = lista.filter(p => !delRobot.has(p.id));
  const uscite = avvisi ? await sorvegliaUscite(env, ctx, altre, imp, rifEpic, ora) : { saltato: 'avvisi spenti' };
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
      let conto = null, lista = [], problema = null;
      try {
        conto = await contoAdesso(env);
        lista = ((await leggi(env, 'positions', new URLSearchParams())).positions || []).map(daCapital);
      } catch (e) { problema = e.message; }
      const aperte = ((robot && robot.aperte) || []).map(a => {
        const p = lista.find(x => x.id === a.id);
        return { ...a, prezzo: p ? (a.dir > 0 ? p.bid : p.ask) : null, stop: p ? p.stop : null, presente: !!p };
      });
      return json({
        versione: VERSIONE, demo: eDemo(env), memoria: !!env.MEMORIA, telegram: !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT),
        robot: robot ? { ...robot, aperte } : null, conto, problema,
        risultato: robot && conto && robot.capitaleIniziale != null ? conto.patrimonio - robot.capitaleIniziale : null,
      }, 200, extra);
    }
    if (url.pathname === '/api/robot/avvia' && req.method === 'POST') {
      if (!env.MEMORIA) return json({ errore: 'Senza il deposito MEMORIA il robot non puo\' ricordare cosa ha aperto: collegalo prima.' }, 400, extra);
      const r = await avviaRobot(env, Date.now(), await req.json(), url.origin);
      return json({ ok: true, robot: r.robot, webhook: r.webhook }, 200, extra);
    }
    if (url.pathname === '/api/robot/ferma' && req.method === 'POST') {
      let b = {};
      try { b = await req.json(); } catch (e) { b = {}; }
      const r = await fermaRobot(env, Date.now(), !!b.chiudi, 'dall\'app');
      if (r.eraAcceso || b.chiudi) {
        await telegram(env, '<b>ROBOT FERMATO</b> dall\'app.\n' + (b.chiudi
          ? 'Chiuse ' + r.esiti.filter(e => e.ok).length + ' posizioni' + (r.esiti.some(e => !e.ok) ? ', ' + r.esiti.filter(e => !e.ok).length + ' NON si sono chiuse: controlla su Capital.com' : '') + '.'
          : 'Non apro piu\' niente; le posizioni aperte le porto a fine con le loro regole.'));
      }
      return json({ ok: true, robot: r.robot, esiti: r.esiti }, 200, extra);
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
