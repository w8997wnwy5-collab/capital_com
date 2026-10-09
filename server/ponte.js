/* Il ponte.
   ══════════════════════════════════════════════════════════════════════════
   L'app sta su GitHub Pages, che e' un sito statico e pubblico: le chiavi di
   Capital.com li' dentro le leggerebbe chiunque. Per questo esiste questo
   pezzo. Vive su Cloudflare, tiene le chiavi come segreti, apre la sessione
   con Capital.com e passa all'app i dati che servono. E SOLO quelli.

   Tre scelte che vale la pena avere scritte accanto al codice:

     SOLA LETTURA. Il ponte sa chiedere prezzi, mercati, posizioni e conto.
     Non sa aprire, chiudere o modificare niente: non c'e' una riga che
     faccia POST o DELETE verso Capital.com, a parte l'apertura della
     sessione. Mirino ti dice cosa fare; il dito sul tasto resta il tuo.
     Se un giorno qualcuno rubasse il codice d'accesso, potrebbe guardare,
     non toccare.

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
   ══════════════════════════════════════════════════════════════════════════ */

const VERSIONE = '1.0';
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
    if (!indicatoriGia.has(cs)) indicatoriGia.set(cs, Motore.indicatori(cs));
    ctx.rif[chiave] = indicatoriGia.get(cs);
  }
  return ctx.rif[chiave];
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
  const an = M.analizza(cs, ct, { rif, percLunghi: folle[pos.epic], prezzo });
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
  const an = M.analizza(cs, ct, { rif, percLunghi: folle[epic], prezzo });
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

async function sorveglia(env, ora) {
  ora = ora || Date.now();
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT || !env.MEMORIA) return { saltato: 'avvisi spenti' };
  const imp = (await leggiKV(env, 'impostazioni')) || {};
  const rifEpic = imp.riferimento || env.RIFERIMENTO || 'US500';
  const ctx = { rif: {}, folle: {} };
  const lista = await posizioniAperte(env);
  /* prima le uscite: sono quelle che costano soldi se arrivano tardi */
  const uscite = await sorvegliaUscite(env, ctx, lista, imp, rifEpic, ora);
  let ingressi;
  try { ingressi = await sorvegliaIngressi(env, ctx, lista, imp, rifEpic, ora); }
  catch (e) { ingressi = { errore: e.message }; }
  return { ...uscite, ingressi };
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
