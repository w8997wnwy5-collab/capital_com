/* ============================================================================
   esempio.js — un Capital.com finto, per provare l'app senza chiavi.

   Risponde alle stesse domande con le stesse forme di Capital.com (prices
   con bid e ask, marketDetails, clientSentiments, positions...): cosi' in
   modalita' esempio l'app fa ESATTAMENTE il percorso che fa con i dati veri,
   e se qualcosa si rompe si rompe anche qui, dove lo si vede.

   I prezzi sono inventati ma non a caso: l'indice ha fasi di trend e fasi
   laterali, la volatilita' si raggruppa, e ogni titolo e' l'indice per il
   suo beta piu' una storia sua. Stesso titolo, stesso giorno, stessi numeri.
   ========================================================================= */

(function (radice) {
'use strict';

var GIORNO = 86400000;

/* epic, nome, tipo, prezzo d'oggi, volatilita' annua, beta, valuta */
var UNIVERSO = [
  ['US500', 'US 500', 'INDICES', 6620, 0.16, 1, 'USD'],
  ['US100', 'US Tech 100', 'INDICES', 24400, 0.21, 1.2, 'USD'],
  ['US30', 'US Wall Street 30', 'INDICES', 46200, 0.15, 0.9, 'USD'],
  ['DE40', 'Germany 40', 'INDICES', 24150, 0.18, 0.8, 'EUR'],
  ['IT40', 'Italy 40', 'INDICES', 42300, 0.19, 0.8, 'EUR'],
  ['UK100', 'UK 100', 'INDICES', 9350, 0.14, 0.6, 'GBP'],
  ['NVDA', 'NVIDIA', 'SHARES', 186, 0.48, 1.7, 'USD'],
  ['TSLA', 'Tesla', 'SHARES', 431, 0.62, 1.9, 'USD'],
  ['AAPL', 'Apple', 'SHARES', 255, 0.27, 1.1, 'USD'],
  ['MSFT', 'Microsoft', 'SHARES', 522, 0.25, 1.0, 'USD'],
  ['AMZN', 'Amazon', 'SHARES', 221, 0.33, 1.3, 'USD'],
  ['META', 'Meta Platforms', 'SHARES', 717, 0.38, 1.4, 'USD'],
  ['GOOGL', 'Alphabet', 'SHARES', 244, 0.31, 1.1, 'USD'],
  ['AMD', 'Advanced Micro Devices', 'SHARES', 211, 0.55, 1.8, 'USD'],
  ['AVGO', 'Broadcom', 'SHARES', 345, 0.45, 1.5, 'USD'],
  ['NFLX', 'Netflix', 'SHARES', 1210, 0.36, 1.1, 'USD'],
  ['PLTR', 'Palantir', 'SHARES', 179, 0.70, 2.0, 'USD'],
  ['COIN', 'Coinbase', 'SHARES', 356, 0.80, 2.2, 'USD'],
  ['MSTR', 'Strategy', 'SHARES', 338, 0.85, 2.3, 'USD'],
  ['UBER', 'Uber', 'SHARES', 97, 0.40, 1.3, 'USD'],
  ['BA', 'Boeing', 'SHARES', 216, 0.35, 1.0, 'USD']
];
var CAMBI = { USDCHF: 0.798, EURCHF: 0.934, GBPCHF: 1.071, EURUSD: 1.170, GBPUSD: 1.342 };

function info(epic) {
  for (var i = 0; i < UNIVERSO.length; i++) {
    var u = UNIVERSO[i];
    if (u[0] === epic) return { epic: u[0], nome: u[1], tipo: u[2], prezzo: u[3], vol: u[4], beta: u[5], valuta: u[6] };
  }
  return null;
}

/* sessioni: le borse europee la mattina, quelle americane il pomeriggio (UTC) */
function sessione(inf) {
  if (inf.valuta === 'EUR' || inf.valuta === 'GBP') return { inizio: 7 * 60, barre: 9, testo: '07:00 - 15:30' };
  return { inizio: 13 * 60 + 30, barre: 7, testo: '13:30 - 20:00' };
}

/* ── caso ripetibile ── */
function hash(s) {
  var h = 2166136261, i;
  for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function generatore(seme) {
  var a = seme >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normale(rnd) {
  var u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ── i giorni di borsa ── */
function giorniBorsa(fine, quanti) {
  var out = [], d = Math.floor(fine / GIORNO) * GIORNO;
  while (out.length < quanti) {
    var g = new Date(d).getUTCDay();
    if (g !== 0 && g !== 6) out.push(d);
    d -= GIORNO;
  }
  return out.reverse();
}

/* I rendimenti giornalieri dell'indice: fasi (trend su, trend giu', laterale)
   che durano settimane, e volatilita' che si raggruppa. */
var cacheRendimenti = {};
function rendimenti(epic, n, volAnnua, seme) {
  var chiave = epic + '|' + n;
  if (cacheRendimenti[chiave]) return cacheRendimenti[chiave];
  var rnd = generatore(seme), out = [], fase = 0, deriva = 0, varianza = Math.pow(volAnnua / Math.sqrt(252), 2), i;
  var base = varianza;
  for (i = 0; i < n; i++) {
    if (i === 0 || rnd() < 1 / 45) {
      fase = rnd();
      deriva = fase < 0.38 ? 0.9 : fase < 0.62 ? -0.8 : 0;
      deriva *= Math.sqrt(base) * (0.15 + 0.2 * rnd());
    }
    var r = deriva + Math.sqrt(varianza) * normale(rnd);
    out.push(r);
    varianza = 0.03 * base + 0.90 * varianza + 0.07 * r * r;
  }
  cacheRendimenti[chiave] = out;
  return out;
}

/* ── le candele giornaliere: 1000 giorni fino a oggi ── */
var cacheSerie = {};
function serieGiorno(epic, ora) {
  var inf = info(epic);
  if (!inf) return null;
  var oggi = Math.floor(ora / GIORNO);
  var chiave = epic + '|' + oggi;
  if (cacheSerie[chiave]) return cacheSerie[chiave];
  var giorni = giorniBorsa(ora, 1000), n = giorni.length;
  var rIdx = rendimenti('US500', n, 0.16, hash('US500|' + oggi));
  var rnd = generatore(hash(epic + '|' + oggi + '|propri'));
  var proprio = epic === 'US500' ? null : rendimenti(epic + '-propri', n, Math.sqrt(Math.max(0.01, inf.vol * inf.vol - Math.pow(inf.beta * 0.16, 2))), hash(epic + '|' + oggi));
  var r = [], i;
  for (i = 0; i < n; i++) r.push(proprio ? inf.beta * rIdx[i] + proprio[i] : rIdx[i]);
  /* all'indietro dal prezzo di oggi, cosi' il prezzo finale e' quello noto */
  var chiusure = new Array(n);
  chiusure[n - 1] = inf.prezzo * (1 + 0.02 * (rnd() - 0.5));
  for (i = n - 1; i > 0; i--) chiusure[i - 1] = chiusure[i] / Math.exp(r[i]);
  var spreadRel = inf.tipo === 'INDICES' ? 0.00012 : 0.0008;
  var out = [];
  for (i = 0; i < n; i++) {
    var c = chiusure[i], o = i ? chiusure[i - 1] * Math.exp(0.15 * r[i] * normale(rnd) * 0.5) : c;
    var escursione = Math.abs(r[i]) + Math.sqrt(inf.vol * inf.vol / 252) * (0.4 + 0.6 * rnd());
    var h = Math.max(o, c) * (1 + escursione * 0.5 * rnd());
    var l = Math.min(o, c) * (1 - escursione * 0.5 * rnd());
    out.push({ t: giorni[i], o: o, h: h, l: l, c: c, s: c * spreadRel, v: Math.round(1000 + 4000 * rnd() * (1 + 8 * Math.abs(r[i]) / Math.sqrt(inf.vol * inf.vol / 252) / 10)) });
  }
  var ris = { inf: inf, giorni: out };
  cacheSerie[chiave] = ris;
  return ris;
}

/* Le candele piu' corte nascono dentro quelle giornaliere come un ponte
   browniano dall'apertura alla chiusura: cosi' massimi e minimi tornano
   con la candela del giorno, e chi guarda le orarie vede la stessa storia. */
function suddividi(padre, figli, durata, inizio, rnd) {
  var out = [], prezzi = [padre.o], i, passo = (padre.c - padre.o) / figli;
  var rumore = (padre.h - padre.l) / Math.sqrt(figli) * 0.45;
  var scarto = 0;
  for (i = 1; i <= figli; i++) {
    scarto = scarto * 0.6 + normale(rnd) * rumore;
    var ponte = i === figli ? 0 : scarto * Math.sqrt((figli - i) / figli);
    prezzi.push(padre.o + passo * i + ponte);
  }
  for (i = 0; i < figli; i++) {
    var o = prezzi[i], c = prezzi[i + 1];
    var ampiezza = Math.abs(c - o) * 0.3 + rumore * 0.35 * rnd();
    out.push({ t: inizio + i * durata, o: o, h: Math.max(o, c) + ampiezza * rnd(), l: Math.min(o, c) - ampiezza * rnd(),
               c: c, s: padre.s, v: Math.round(padre.v / figli * (0.5 + rnd())) });
  }
  return out;
}

function serie(epic, risoluzione, quante, ora) {
  var sg = serieGiorno(epic, ora);
  if (!sg) return null;
  var ses = sessione(sg.inf);
  var giorni = sg.giorni.filter(function (g) { return g.t + ses.inizio * 60000 <= ora; });
  if (risoluzione === 'DAY') return giorni.slice(-quante);
  var perOra = risoluzione === 'HOUR' ? 1 : risoluzione === 'HOUR_4' ? 0.25 : risoluzione === 'MINUTE_30' ? 2 : risoluzione === 'MINUTE_15' ? 4 : risoluzione === 'MINUTE_5' ? 12 : 60;
  var perGiorno = Math.max(1, Math.round(ses.barre * perOra));
  var durata = Math.round(60 / perOra) * 60000;
  var servono = Math.ceil(quante / perGiorno) + 1, out = [], i;
  for (i = Math.max(0, giorni.length - servono); i < giorni.length; i++) {
    var g = giorni[i];
    var rnd = generatore(hash(epic + '|' + g.t + '|' + risoluzione));
    var figli = suddividi(g, perGiorno, durata, g.t + ses.inizio * 60000, rnd);
    for (var j = 0; j < figli.length; j++) if (figli[j].t + durata <= ora + durata) out.push(figli[j]);
  }
  return out.filter(function (b) { return b.t <= ora; }).slice(-quante);
}

/* il prezzo che si muove: ogni 5 secondi un passo piccolo attorno all'ultima chiusura */
function ultimo(epic, ora) {
  var sg = serieGiorno(epic, ora);
  if (!sg) return null;
  var ore = serie(epic, 'HOUR', 2, ora) || [];
  var base = ore.length ? ore[ore.length - 1].c : sg.giorni[sg.giorni.length - 1].c;
  var rnd = generatore(hash(epic + '|' + Math.floor(ora / 5000)));
  var mid = base * (1 + (rnd() - 0.5) * sg.inf.vol / Math.sqrt(252) * 0.15);
  var s = sg.giorni[sg.giorni.length - 1].s;
  var ieri = sg.giorni.length > 1 ? sg.giorni[sg.giorni.length - 2].c : mid;
  return { bid: mid - s / 2, offer: mid + s / 2, ieri: ieri, h: sg.giorni[sg.giorni.length - 1].h, l: sg.giorni[sg.giorni.length - 1].l };
}

/* ── le risposte, nella forma di Capital.com ── */

function iso(ms) { return new Date(ms).toISOString().slice(0, 19); }
function lato(x, s) { return { bid: +(x - s / 2).toFixed(4), ask: +(x + s / 2).toFixed(4) }; }

function rispostaPrezzi(epic, q, ora) {
  var b = serie(epic, q.resolution || 'MINUTE', Math.min(1000, +q.max || 10), ora);
  if (!b) return { errore: 404, errorCode: 'error.not-found.epic' };
  return {
    prices: b.map(function (x) {
      return { snapshotTime: iso(x.t), snapshotTimeUTC: iso(x.t),
               openPrice: lato(x.o, x.s), closePrice: lato(x.c, x.s), highPrice: lato(x.h, x.s), lowPrice: lato(x.l, x.s),
               lastTradedVolume: x.v };
    }),
    instrumentType: info(epic).tipo
  };
}

function orariDi(inf) {
  var t = [sessione(inf).testo];
  return { mon: t, tue: t, wed: t, thu: t, fri: t, sat: [], sun: [], zone: 'UTC' };
}

function stato(inf, ora) { return inSessione(inf, ora) ? 'TRADEABLE' : 'CLOSED'; }
function inSessione(inf, ora) {
  var g = new Date(ora).getUTCDay();
  if (g === 0 || g === 6) return false;
  var m = new Date(ora).getUTCHours() * 60 + new Date(ora).getUTCMinutes(), ses = sessione(inf);
  return m >= ses.inizio && m < ses.inizio + ses.barre * 60 + (ses.barre === 9 ? -30 : 0);
}

function dettagli(epic, ora) {
  var inf = info(epic);
  if (!inf) return null;
  var u = ultimo(epic, ora);
  var azione = inf.tipo === 'SHARES';
  return {
    instrument: {
      epic: epic, expiry: '-', name: inf.nome, lotSize: 1, type: inf.tipo,
      controlledRiskAllowed: true, streamingPricesAvailable: true, currency: inf.valuta,
      marginFactor: azione ? 20 : 5, marginFactorUnit: 'PERCENTAGE',
      openingHours: orariDi(inf),
      overnightFee: { longRate: azione ? -0.0178 : -0.0151, shortRate: azione ? -0.0042 : -0.0031,
                      swapChargeTimestamp: 0, swapChargeInterval: 1440 }
    },
    dealingRules: {
      minStepDistance: { unit: 'POINTS', value: 0.01 },
      minDealSize: { unit: 'POINTS', value: azione ? 1 : 0.1 },
      minSizeIncrement: { unit: 'POINTS', value: azione ? 1 : 0.1 },
      minControlledRiskStopDistance: { unit: 'PERCENTAGE', value: 2 },
      minNormalStopOrLimitDistance: { unit: 'PERCENTAGE', value: 0.1 },
      maxStopOrLimitDistance: { unit: 'PERCENTAGE', value: 60 },
      marketOrderPreference: 'AVAILABLE_DEFAULT_ON', trailingStopsPreference: 'AVAILABLE'
    },
    snapshot: {
      marketStatus: stato(inf, ora), netChange: +(((u.bid + u.offer) / 2) - u.ieri).toFixed(4),
      percentageChange: +((((u.bid + u.offer) / 2) / u.ieri - 1) * 100).toFixed(4),
      updateTime: iso(ora), delayTime: 0, bid: +u.bid.toFixed(4), offer: +u.offer.toFixed(4),
      high: +u.h.toFixed(4), low: +u.l.toFixed(4), decimalPlacesFactor: 2, scalingFactor: 1
    }
  };
}

function riassuntoMercato(d) {
  return { epic: d.instrument.epic, instrumentName: d.instrument.name, instrumentType: d.instrument.type,
           expiry: '-', lotSize: 1, high: d.snapshot.high, low: d.snapshot.low,
           percentageChange: d.snapshot.percentageChange, netChange: d.snapshot.netChange,
           bid: d.snapshot.bid, offer: d.snapshot.offer, updateTimeUTC: d.snapshot.updateTime,
           delayTime: 0, streamingPricesAvailable: true, marketStatus: d.snapshot.marketStatus, scalingFactor: 1 };
}

function cambioFinto(epic, ora) {
  if (!CAMBI[epic]) return null;
  var x = CAMBI[epic], s = x * 0.0002;
  return { instrument: { epic: epic, name: epic.slice(0, 3) + '/' + epic.slice(3), type: 'CURRENCIES', currency: epic.slice(3),
                         marginFactor: 3.33, marginFactorUnit: 'PERCENTAGE' },
           dealingRules: { minDealSize: { unit: 'POINTS', value: 100 } },
           snapshot: { marketStatus: 'TRADEABLE', bid: x - s / 2, offer: x + s / 2, percentageChange: 0, netChange: 0, updateTime: iso(ora) } };
}

/* La posizione aperta d'esempio: lunga sul titolo col punteggio migliore,
   comprata tre giorni di borsa fa. Serve a far vedere il consiglio. */
var posizioniFinte = null;
function posizioni(ora) {
  if (posizioniFinte) return posizioniFinte;
  var epic = 'NVDA', sg = serieGiorno(epic, ora), g = sg.giorni, i = g.length - 4;
  var livello = g[i].o + g[i].s / 2;
  posizioniFinte = [{
    position: { contractSize: 1, createdDate: iso(g[i].t + 14 * 3600000), createdDateUTC: iso(g[i].t + 14 * 3600000),
                dealId: 'esempio-0001', dealReference: 'p_esempio-0001', size: 20, leverage: 5, direction: 'BUY',
                level: +livello.toFixed(2), currency: 'USD', guaranteedStop: false, stopLevel: +(livello * 0.955).toFixed(2) },
    market: riassuntoMercato(dettagli(epic, ora))
  }];
  return posizioniFinte;
}

/* Il punto d'ingresso: un percorso dell'API di Capital.com, la risposta. */
function risposta(percorso, query, ora) {
  ora = ora || Date.now();
  query = query || {};
  var m;
  if ((m = /^prices\/([^/]+)$/.exec(percorso))) return rispostaPrezzi(decodeURIComponent(m[1]), query, ora);
  if ((m = /^markets\/([^/]+)$/.exec(percorso))) {
    var ep = decodeURIComponent(m[1]);
    return dettagli(ep, ora) || cambioFinto(ep, ora) || { errore: 404, errorCode: 'error.not-found.epic' };
  }
  if (percorso === 'markets') {
    if (query.epics) {
      return { marketDetails: String(query.epics).split(',').map(function (e) { return dettagli(e, ora) || cambioFinto(e, ora); })
        .filter(Boolean) };
    }
    var cerca = String(query.searchTerm || '').toLowerCase();
    return { markets: UNIVERSO.filter(function (u) { return !cerca || u[0].toLowerCase().indexOf(cerca) >= 0 || u[1].toLowerCase().indexOf(cerca) >= 0; })
      .map(function (u) { return riassuntoMercato(dettagli(u[0], ora)); }) };
  }
  if (percorso === 'clientsentiment') {
    return { clientSentiments: String(query.marketIds || '').split(',').filter(Boolean).map(function (e) {
      var l = 30 + (hash(e + '|folla|' + Math.floor(ora / GIORNO)) % 5500) / 100;
      return { marketId: e, longPositionPercentage: +l.toFixed(2), shortPositionPercentage: +(100 - l).toFixed(2) };
    }) };
  }
  if (percorso === 'positions') {
    var lista = posizioni(ora);
    lista.forEach(function (p) { p.market = riassuntoMercato(dettagli(p.market.epic, ora)); });
    return { positions: lista };
  }
  if (percorso === 'accounts') {
    return { accounts: [{ accountId: 'ESEMPIO', accountName: 'CHF', status: 'ENABLED', accountType: 'CFD', preferred: true,
                          balance: { balance: 10000, deposit: 10000, profitLoss: 0, available: 9120 }, currency: 'CHF', symbol: 'CHF' }] };
  }
  if (percorso === 'accounts/preferences') {
    return { hedgingMode: false, leverages: {
      SHARES: { current: 5, available: [1, 2, 3, 4, 5] }, INDICES: { current: 20, available: [1, 2, 5, 10, 20] },
      CURRENCIES: { current: 30, available: [1, 10, 20, 30] }, COMMODITIES: { current: 10, available: [1, 5, 10] },
      CRYPTOCURRENCIES: { current: 2, available: [1, 2] } } };
  }
  if ((m = /^marketnavigation\/(.+)$/.exec(percorso))) {
    var nodo = decodeURIComponent(m[1]);
    var tutti = UNIVERSO.filter(function (u) { return u[2] === 'SHARES'; }).map(function (u) { return riassuntoMercato(dettagli(u[0], ora)); });
    if (/volatile/.test(nodo)) tutti.sort(function (a, b) { return Math.abs(b.percentageChange) - Math.abs(a.percentageChange); });
    else if (/gainers|risers/.test(nodo)) tutti.sort(function (a, b) { return b.percentageChange - a.percentageChange; });
    else if (/losers|fallers/.test(nodo)) tutti.sort(function (a, b) { return a.percentageChange - b.percentageChange; });
    return { nodes: [], markets: tutti.slice(0, 10) };
  }
  if (percorso === 'marketnavigation') return { nodes: [{ id: 'hierarchy_v1.commons_group', name: 'commons_group' }] };
  return { errore: 404, errorCode: 'error.not-found.path' };
}

var API = { risposta: risposta, UNIVERSO: UNIVERSO, info: info, serie: serie, CAMBI: CAMBI };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
radice.Esempio = API;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
