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
     prendi meta', sposta lo stop...) ti scrive su Telegram. Il motore e'
     lo stesso file dell'app, cucito qui sopra da tools/cuci_worker.js:
     telefono e ponte non possono dare consigli diversi.

   Endpoint (tutti con  Authorization: Bearer <CHIAVE>):
     GET  /api/stato               il ponte e' acceso? demo o reale? avvisi?
     GET  /api/cap/<percorso>      un percorso di Capital.com, in lettura
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
    throw new ErroreCapital(r.status === 401 || r.status === 400 ? 401 : 502, frase(dettaglio, r.status));
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
function frase(codice, stato) {
  const c = String(codice || '');
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
  if (!r.ok) throw new ErroreCapital(r.status === 404 ? 404 : 502, frase(dati && dati.errorCode, r.status));
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

   Nella memoria lunga (KV, MEMORIA) ci stanno due cose per posizione:
     segui:<id>    come va letta: stile, R iniziale, se hai gia' preso meta'.
                   La scrive l'app quando premi "Sono entrato" o cambi
                   qualcosa; se non c'e', la scrive il ponte la prima volta
                   che vede la posizione, cosi' l'R non cambia piu'.
     avviso:<id>   l'ultimo consiglio mandato, per non ripeterlo ogni minuto.

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

async function candeleDi(env, epic, risoluzione, quante) {
  return Motore.candele(await leggi(env, 'prices/' + epic, new URLSearchParams({ resolution: risoluzione, max: String(quante) })));
}

/* Il consiglio per una posizione, esattamente come lo calcola l'app. */
async function consiglioPer(env, pos, imp, rif, folle) {
  const M = Motore;
  const stile = M.STILI[imp.stile] ? imp.stile : 'swing';
  const S = M.STILI[stile];
  const cs = await candeleDi(env, pos.epic, S.segnale, S.candele);
  const ct = await candeleDi(env, pos.epic, S.tempo, S.candeleTempo);
  const prezzo = { bid: pos.bid, ask: pos.ask };
  const an = M.analizza(cs, ct, { rif: pos.epic === (imp.riferimento || 'US500') ? null : rif, percLunghi: folle[pos.epic], prezzo });
  if (!an.ok) return null;
  let orario = null;
  if (S.chiudiASera) {
    const d = await leggi(env, 'markets/' + pos.epic, new URLSearchParams());
    orario = M.orari(d.instrument && d.instrument.openingHours, Date.now());
  }
  return M.consiglio({
    pos: { ...pos, R: imp.R, stopIniziale: imp.stopIniziale, parziale: !!imp.parziale, rinforzata: !!imp.rinforzata,
           puntiEntrata: imp.puntiEntrata, passo: imp.passo },
    prezzo, ct, an, stile, ora: Date.now(), orari: orario,
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

async function sorveglia(env) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT || !env.MEMORIA) return { saltato: 'avvisi spenti' };
  const lista = ((await leggi(env, 'positions', new URLSearchParams())).positions || []).map(daCapital);
  const manuali = (await leggiKV(env, 'manuali')) || [];
  for (const m of manuali) {
    if (lista.some(p => p.id === m.id)) continue;
    try {
      const d = await leggi(env, 'markets/' + m.epic, new URLSearchParams());
      lista.push({ ...m, bid: d.snapshot.bid, ask: d.snapshot.offer, stato: d.snapshot.marketStatus });
    } catch (e) { /* un mercato che non risponde non ferma gli altri */ }
  }
  if (!lista.length) return { posizioni: 0 };

  const aperte = lista.filter(p => p.stato === 'TRADEABLE');
  if (!aperte.length) return { posizioni: lista.length, aperte: 0 };

  const rifEpic = env.RIFERIMENTO || 'US500';
  const epics = [...new Set(aperte.map(p => p.epic))];
  let folle = {};
  try {
    const s = await leggi(env, 'clientsentiment', new URLSearchParams({ marketIds: epics.join(',') }));
    for (const x of s.clientSentiments || []) folle[x.marketId] = x.longPositionPercentage;
  } catch (e) { folle = {}; }

  const rifPer = {};
  const mandati = [];
  for (const pos of aperte) {
    try {
      let imp = await leggiKV(env, 'segui:' + pos.id);
      if (!imp) {
        /* la prima volta: si fissa il rischio iniziale, che da qui non cambia */
        imp = { stile: env.STILE || 'swing', riferimento: rifEpic };
        if (pos.stop != null && (pos.stop - pos.entrata) * pos.dir < 0) imp.stopIniziale = pos.stop;
        await scriviKV(env, 'segui:' + pos.id, imp);
      }
      const S = Motore.STILI[imp.stile] || Motore.STILI.swing;
      if (!rifPer[S.segnale]) rifPer[S.segnale] = Motore.indicatori(await candeleDi(env, rifEpic, S.segnale, S.candele));
      if (!imp.R && !imp.stopIniziale) {
        const cs = await candeleDi(env, pos.epic, S.segnale, S.candele);
        const R = Motore.rischioIniziale(cs, Motore.indicatori(cs), pos.aperta);
        if (R) { imp.R = R; await scriviKV(env, 'segui:' + pos.id, imp); }
      }
      const c = await consiglioPer(env, pos, imp, rifPer[S.segnale], folle);
      if (!c) continue;
      const prima = await leggiKV(env, 'avviso:' + pos.id);
      const cambiato = !prima || prima.verdetto !== c.verdetto ||
        (c.verdetto === 'stop' && Math.abs(c.stopRegola - prima.stop) / c.R >= 0.25);
      if (!cambiato) continue;
      await scriviKV(env, 'avviso:' + pos.id, { verdetto: c.verdetto, stop: c.stopRegola, quando: Date.now() });
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
      const r = await telegram(env, '<b>Mirino</b>\nGli avvisi arrivano qui. Quando una posizione aperta va toccata, te lo scrivo.' +
        (env.MEMORIA ? '' : '\n\nAttenzione: manca il deposito MEMORIA, senza gli avvisi automatici restano spenti.'));
      return json(r, r.ok ? 200 : 400, extra);
    }
    if (url.pathname === '/api/sorveglia' && req.method === 'POST') {
      return json(await sorveglia(env), 200, extra);
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
    ctx.waitUntil(sorveglia(env).catch(e => console.log('sorveglianza:', e.message)));
  },
};
