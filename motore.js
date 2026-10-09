/* ============================================================================
   motore.js — il cervello di Mirino. Nessun DOM qui dentro: gira uguale nel
   browser, nel Worker di Cloudflare (gli avvisi su Telegram) e sotto node,
   così si può testare davvero.

   Cosa fa, in ordine:

     1. legge le candele di Capital.com (bid e ask veri, non un prezzo medio
        inventato) e ci calcola sopra gli indicatori, tutti CAUSALI: il valore
        alla candela t usa solo le candele fino a t. Lo verifica un test.
     2. ne esce un PUNTEGGIO da -100 a +100: sopra zero il mercato spinge su,
        sotto spinge giù. Dal punteggio esce un grado, A B o C.
     3. il PIANO: quanto mettere, dove entrare, dove sta lo stop, dove si
        incassa, quanto margine blocca la leva. Il dimensionamento parte dal
        rischio, non dalla leva: la leva decide quanto margine ti blocca, lo
        stop decide quanto perdi.
     4. il CONSIGLIO su una posizione già aperta: tieni, sposta lo stop,
        prendi metà, rinforza, incassa, esci. Senza memoria: tutto quello che
        serve si ricava dal prezzo d'entrata e dalle candele dopo. Così il
        telefono e il Worker arrivano alla stessa risposta senza parlarsi.
     5. il BACKTEST: le stesse regole rigiocate sulla storia di ogni titolo,
        con lo spread vero di ogni candela e il costo delle notti. Da lì le
        probabilità che l'app mostra — misurate, non stimate a occhio.
   ========================================================================= */

(function (radice) {
'use strict';

/* ─────────────────────────── numeri di base ─────────────────────────── */

function limita(v, min, max) { return v < min ? min : (v > max ? max : v); }
function tanh(x) { var e = Math.exp(2 * x); return isFinite(e) ? (e - 1) / (e + 1) : (x > 0 ? 1 : -1); }
function media(a) { var t = 0, i; for (i = 0; i < a.length; i++) t += a[i]; return a.length ? t / a.length : 0; }
function finito(x) { return typeof x === 'number' && isFinite(x); }
function vuoto(n) { var a = new Array(n), i; for (i = 0; i < n; i++) a[i] = NaN; return a; }
function devStd(a) {
  if (a.length < 2) return 0;
  var m = media(a), s = 0, i;
  for (i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
  return Math.sqrt(s / (a.length - 1));
}
/* Arrotonda VERSO IL BASSO al passo: una taglia arrotondata in su vuol dire
   rischiare piu' di quanto scritto nel piano, anche se di poco. */
function giuAlPasso(x, passo) {
  if (!(passo > 0)) return x;
  var k = Math.floor(x / passo + 1e-9);
  var dec = Math.max(0, Math.ceil(-Math.log10(passo) - 1e-9));
  return Number((k * passo).toFixed(dec));
}

/* ─────────────────────────── candele ─────────────────────────── */

/* Da Capital.com a qualcosa di usabile. Ogni candela arriva con bid e ask
   separati per apertura, massimo, minimo e chiusura: qui si tiene il medio
   per gli indicatori e lo SPREAD per i conti, perche' chi compra paga l'ask
   e chi vende incassa il bid. Un backtest sul prezzo medio regala lo spread
   a ogni operazione: su un'azione a leva sono soldi veri.

   Le candele senza prezzo (capitano, ai bordi delle sessioni) si buttano. */
function candele(risposta) {
  var lista = (risposta && (risposta.prices || risposta)) || [];
  var out = [], i, p, o, h, l, c, s;
  for (i = 0; i < lista.length; i++) {
    p = lista[i];
    o = medio(p.openPrice); h = medio(p.highPrice); l = medio(p.lowPrice); c = medio(p.closePrice);
    if (!finito(o) || !finito(h) || !finito(l) || !finito(c)) continue;
    s = spread(p.closePrice);
    if (!finito(s)) s = spread(p.openPrice);
    var quando = p.snapshotTimeUTC || p.snapshotTime;
    out.push({
      t: Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(quando) ? quando : quando + 'Z'),
      o: o, h: Math.max(h, o, c), l: Math.min(l, o, c), c: c,
      s: finito(s) && s >= 0 ? s : 0,
      v: finito(p.lastTradedVolume) ? p.lastTradedVolume : 0
    });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  /* doppioni: Capital.com a volte ripete l'ultima candela */
  var pulite = [];
  for (i = 0; i < out.length; i++) {
    if (pulite.length && pulite[pulite.length - 1].t === out[i].t) pulite[pulite.length - 1] = out[i];
    else pulite.push(out[i]);
  }
  return pulite;
}
function medio(x) {
  if (x == null) return NaN;
  if (typeof x === 'number') return x;
  var b = x.bid, a = x.ask;
  if (finito(b) && finito(a)) return (b + a) / 2;
  if (finito(b)) return b;
  if (finito(a)) return a;
  return NaN;
}
function spread(x) {
  if (!x || !finito(x.bid) || !finito(x.ask)) return NaN;
  return x.ask - x.bid;
}

/* ─────────────────────────── indicatori ───────────────────────────
   Tutti restituiscono un array lungo quanto l'ingresso, con NaN finche' non
   hanno abbastanza storia. Nessuno guarda avanti. */

function ema(x, n) {
  var out = vuoto(x.length), a = 2 / (n + 1), somma = 0, k = 0, prec = NaN, i;
  for (i = 0; i < x.length; i++) {
    if (!finito(x[i])) { out[i] = prec; continue; }
    if (k < n) {
      somma += x[i]; k++;
      if (k === n) { prec = somma / n; out[i] = prec; }
    } else {
      prec = prec + a * (x[i] - prec);
      out[i] = prec;
    }
  }
  return out;
}

/* Media di Wilder: quella di RSI, ATR e ADX. E' un'EMA con alfa 1/n. */
function rma(x, n) {
  var out = vuoto(x.length), somma = 0, k = 0, prec = NaN, i;
  for (i = 0; i < x.length; i++) {
    if (!finito(x[i])) { out[i] = prec; continue; }
    if (k < n) {
      somma += x[i]; k++;
      if (k === n) { prec = somma / n; out[i] = prec; }
    } else {
      prec = (prec * (n - 1) + x[i]) / n;
      out[i] = prec;
    }
  }
  return out;
}

function sma(x, n) {
  var out = vuoto(x.length), somma = 0, i;
  for (i = 0; i < x.length; i++) {
    somma += x[i];
    if (i >= n) somma -= x[i - n];
    if (i >= n - 1) out[i] = somma / n;
  }
  return out;
}

function rsi(c, n) {
  var su = vuoto(c.length), giu = vuoto(c.length), i;
  for (i = 1; i < c.length; i++) {
    var d = c[i] - c[i - 1];
    su[i] = d > 0 ? d : 0; giu[i] = d < 0 ? -d : 0;
  }
  var ms = rma(su, n), mg = rma(giu, n), out = vuoto(c.length);
  for (i = 0; i < c.length; i++) {
    if (!finito(ms[i]) || !finito(mg[i])) continue;
    out[i] = mg[i] === 0 ? (ms[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ms[i] / mg[i]);
  }
  return out;
}

function veroRange(h, l, c) {
  var tr = vuoto(c.length), i;
  for (i = 0; i < c.length; i++) {
    tr[i] = i === 0 ? h[i] - l[i]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return tr;
}
function atr(h, l, c, n) { return rma(veroRange(h, l, c), n); }

/* ADX: quanto il mercato ha una direzione, non quale. Sotto 20 il prezzo va
   a zig-zag e i segnali di trend valgono poco; sopra 25 c'e' una strada. */
function adx(h, l, c, n) {
  var len = c.length, pdm = vuoto(len), mdm = vuoto(len), i;
  for (i = 1; i < len; i++) {
    var su = h[i] - h[i - 1], giu = l[i - 1] - l[i];
    pdm[i] = su > giu && su > 0 ? su : 0;
    mdm[i] = giu > su && giu > 0 ? giu : 0;
  }
  var tr = veroRange(h, l, c); tr[0] = NaN;
  var str = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
  var pdi = vuoto(len), mdi = vuoto(len), dx = vuoto(len);
  for (i = 0; i < len; i++) {
    if (!finito(str[i]) || str[i] <= 0) continue;
    pdi[i] = 100 * sp[i] / str[i]; mdi[i] = 100 * sm[i] / str[i];
    var s = pdi[i] + mdi[i];
    dx[i] = s > 0 ? 100 * Math.abs(pdi[i] - mdi[i]) / s : 0;
  }
  return { adx: rma(dx, n), pdi: pdi, mdi: mdi };
}

function macd(c, veloce, lenta, segnale) {
  var a = ema(c, veloce), b = ema(c, lenta), m = vuoto(c.length), i;
  for (i = 0; i < c.length; i++) if (finito(a[i]) && finito(b[i])) m[i] = a[i] - b[i];
  var s = ema(m, segnale), isto = vuoto(c.length);
  for (i = 0; i < c.length; i++) if (finito(m[i]) && finito(s[i])) isto[i] = m[i] - s[i];
  return { macd: m, segnale: s, isto: isto };
}

/* Il canale di Donchian delle n candele PRIMA di questa: chiudere sopra il
   massimo delle ultime venti e' una rottura solo se il massimo non contiene
   la candela stessa. */
function donchianPrima(h, l, n) {
  var alto = vuoto(h.length), basso = vuoto(h.length), i, j;
  for (i = n; i < h.length; i++) {
    var a = -Infinity, b = Infinity;
    for (j = i - n; j < i; j++) { if (h[j] > a) a = h[j]; if (l[j] < b) b = l[j]; }
    alto[i] = a; basso[i] = b;
  }
  return { alto: alto, basso: basso };
}

/* Volatilita' per candela alla RiskMetrics: media esponenziale dei rendimenti
   al quadrato, lambda 0.94. Reagisce in fretta quando il mercato si agita, e
   per uno che gioca a leva e' la cosa che conta. */
function volatilita(c, lambda) {
  lambda = lambda || 0.94;
  var out = vuoto(c.length), v = NaN, i, prime = [];
  for (i = 1; i < c.length; i++) {
    var r = Math.log(c[i] / c[i - 1]);
    if (!finito(r)) { out[i] = v; continue; }
    if (prime.length < 20) {
      prime.push(r);
      if (prime.length === 20) { v = 0; for (var k = 0; k < 20; k++) v += prime[k] * prime[k]; v /= 20; out[i] = Math.sqrt(v); }
      continue;
    }
    v = lambda * v + (1 - lambda) * r * r;
    out[i] = Math.sqrt(v);
  }
  return out;
}

function colonne(cs) {
  var n = cs.length, o = new Array(n), h = new Array(n), l = new Array(n), c = new Array(n),
      s = new Array(n), v = new Array(n), t = new Array(n), i;
  for (i = 0; i < n; i++) {
    o[i] = cs[i].o; h[i] = cs[i].h; l[i] = cs[i].l; c[i] = cs[i].c;
    s[i] = cs[i].s; v[i] = cs[i].v; t[i] = cs[i].t;
  }
  return { o: o, h: h, l: l, c: c, s: s, v: v, t: t, n: n };
}

/* Tutti gli indicatori di una serie, una volta sola. Il punteggio a ogni
   candela legge da qui: cosi' il backtest costa millisecondi. */
function indicatori(cs, riferimento) {
  var k = colonne(cs);
  var d = donchianPrima(k.h, k.l, 20), a = adx(k.h, k.l, k.c, 14), m = macd(k.c, 12, 26, 9);
  var mediaVol = sma(k.v, 20), rapportoVol = vuoto(k.n), i;
  for (i = 1; i < k.n; i++) {
    if (finito(mediaVol[i - 1]) && mediaVol[i - 1] > 0) rapportoVol[i] = k.v[i] / mediaVol[i - 1];
  }
  var ser = {
    k: k,
    ema9: ema(k.c, 9), ema20: ema(k.c, 20), ema50: ema(k.c, 50), ema200: ema(k.c, 200),
    rsi: rsi(k.c, 14), atr: atr(k.h, k.l, k.c, 14), adx: a.adx, pdi: a.pdi, mdi: a.mdi,
    macd: m.macd, macdSegnale: m.segnale, macdIsto: m.isto,
    alto20: d.alto, basso20: d.basso, sigma: volatilita(k.c), rapportoVol: rapportoVol,
    rif: null, rifIdx: null
  };
  if (riferimento && riferimento.k && riferimento.k.n) ser = allineaRiferimento(ser, riferimento);
  return ser;
}

/* Il riferimento (l'S&P 500, di solito) messo in fila con il titolo: per ogni
   candela del titolo, l'ultima candela del riferimento chiusa NON DOPO. */
function allineaRiferimento(ser, rif) {
  var idx = vuoto(ser.k.n), j = -1, i;
  for (i = 0; i < ser.k.n; i++) {
    while (j + 1 < rif.k.n && rif.k.t[j + 1] <= ser.k.t[i]) j++;
    idx[i] = j;
  }
  ser.rif = rif; ser.rifIdx = idx;
  return ser;
}

/* ─────────────────────────── il punteggio ───────────────────────────

   Sette letture, ciascuna fra -1 e +1, pesate. Le prime due (trend e
   momento) sono quelle che portano il peso: e' l'unica regolarita' dei
   mercati azionari che regge da cent'anni di dati, e anche li' non e'
   enorme. Le altre servono a scegliere il MOMENTO, non la direzione.

   L'ADX fa da manopola: in un mercato senza direzione trend e momento
   contano poco piu' della meta'. */

var PESI = { trend: 0.28, momento: 0.24, macd: 0.10, rottura: 0.14, estensione: 0.10,
             forzaRel: 0.08, regime: 0.06, folla: 0.08 };
var GRADI = [ { g: 'A', da: 55 }, { g: 'B', da: 40 }, { g: 'C', da: 28 } ];
var SOGLIA_GIRO = 28;     /* il segnale contrario che fa uscire: un grado C dall'altra parte */
var CALDO = 100;          /* candele minime prima del primo punteggio */

function gradoDi(p) {
  var a = Math.abs(p), i;
  for (i = 0; i < GRADI.length; i++) if (a >= GRADI[i].da) return GRADI[i].g;
  return '';
}

function parti(ser, t) {
  var k = ser.k, c = k.c[t], at = ser.atr[t];
  if (t < 60 || !finito(at) || at <= 0 || !finito(ser.ema50[t])) return null;
  var p = {};

  /* trend: dove sta il prezzo rispetto alle medie, e dove stanno le medie fra
     loro. Senza la 200 (meno di 200 candele) si legge sulle altre due. */
  var lungo = finito(ser.ema200[t]);
  var allineo = (c > ser.ema50[t] ? 0.35 : -0.35) + (ser.ema20[t] > ser.ema50[t] ? 0.35 : -0.35) +
                (lungo ? (ser.ema50[t] > ser.ema200[t] ? 0.30 : -0.30) : 0);
  if (!lungo) allineo /= 0.7;
  var pend = finito(ser.ema50[t - 10]) ? tanh((ser.ema50[t] - ser.ema50[t - 10]) / (2 * at)) : 0;
  p.trend = limita(0.7 * allineo + 0.3 * pend, -1, 1);

  /* momento: il rendimento di 20 e 60 candele diviso per quanto il titolo si
     muove di solito. +10% su un titolo calmo vale piu' di +10% su uno matto. */
  var sg = ser.sigma[t];
  if (finito(sg) && sg > 0) {
    var r20 = t >= 20 ? Math.log(c / k.c[t - 20]) / (sg * Math.sqrt(20)) : 0;
    var r60 = t >= 60 ? Math.log(c / k.c[t - 60]) / (sg * Math.sqrt(60)) : 0;
    p.momento = tanh(0.6 * r20 + 0.4 * r60);
  } else p.momento = 0;

  p.macd = finito(ser.macdIsto[t]) ? tanh(ser.macdIsto[t] / (0.2 * at)) : 0;

  /* rottura: chiudere fuori dal canale delle ultime venti, meglio se con piu'
     volumi del solito. Dentro il canale conta dove si sta, ma la meta'. */
  var al = ser.alto20[t], ba = ser.basso20[t], rv = ser.rapportoVol[t];
  var spintaVol = finito(rv) ? limita(rv - 1, 0, 1) : 0;
  if (finito(al) && c > al) p.rottura = 0.7 + 0.3 * spintaVol;
  else if (finito(ba) && c < ba) p.rottura = -(0.7 + 0.3 * spintaVol);
  else if (finito(al) && finito(ba) && al > ba) p.rottura = 0.5 * limita((c - (al + ba) / 2) / ((al - ba) / 2), -1, 1);
  else p.rottura = 0;

  /* estensione: contro. Un titolo con RSI 80 a tre ATR dalla media a 20 puo'
     salire ancora, ma comprarlo li' vuol dire mettere lo stop dove fa male. */
  var r = ser.rsi[t], e = 0;
  if (finito(r)) { if (r > 75) e -= (r - 75) / 25; else if (r < 25) e += (25 - r) / 25; }
  var dist = (c - ser.ema20[t]) / at;
  if (Math.abs(dist) > 2) e -= (dist > 0 ? 1 : -1) * tanh(Math.abs(dist) - 2);
  p.estensione = limita(e, -1, 1);

  /* forza relativa e regime: come va il titolo rispetto al mercato, e com'e'
     il mercato. Comprare il titolo forte in un mercato forte e' il vento in
     poppa; comprarlo mentre l'indice crolla e' nuotare controcorrente. */
  if (ser.rif && ser.rifIdx) {
    var j = ser.rifIdx[t], R = ser.rif;
    if (j >= 60 && finito(R.ema50[j]) && finito(sg) && sg > 0) {
      var tj = t >= 20 ? ser.rifIdx[t - 20] : -1;
      if (tj >= 0) {
        var rs = Math.log(c / k.c[t - 20]) - Math.log(R.k.c[j] / R.k.c[tj]);
        p.forzaRel = tanh(rs / (sg * Math.sqrt(20)));
      }
      p.regime = 0.5 * (R.k.c[j] > R.ema50[j] ? 1 : -1) + 0.5 * (R.ema20[j] > R.ema50[j] ? 1 : -1);
    }
  }

  /* l'ADX come manopola su trend e momento */
  var forza = finito(ser.adx[t]) ? limita((ser.adx[t] - 15) / 20, 0, 1) : 0.5;
  p.trend *= 0.55 + 0.45 * forza;
  p.momento *= 0.55 + 0.45 * forza;
  return p;
}

/* La folla di Capital.com: quanti clienti sono lunghi su questo mercato. Si
   legge AL CONTRARIO, e non per partito preso: i clienti al dettaglio
   comprano quello che scende e vendono quello che sale, e questo e' uno dei
   pochi fatti che i broker stessi pubblicano. Pesa poco, e solo dal vivo:
   la storia del sentiment non esiste, quindi non entra nel backtest. */
function letturaFolla(percLunghi) {
  if (!finito(percLunghi)) return null;
  return -limita((percLunghi - 50) / 30, -1, 1);
}

function punteggio(ser, t, extra) {
  var p = parti(ser, t);
  if (!p) return null;
  if (extra && finito(extra.folla)) p.folla = extra.folla;
  var somma = 0, pesi = 0, chiave;
  for (chiave in p) {
    if (!p.hasOwnProperty(chiave) || !finito(p[chiave])) continue;
    somma += PESI[chiave] * p[chiave]; pesi += PESI[chiave];
  }
  var tot = pesi > 0 ? Math.round(limita(100 * somma / pesi, -100, 100)) : 0;
  return { punti: tot, dir: tot > 0 ? 1 : (tot < 0 ? -1 : 0), grado: gradoDi(tot), parti: p };
}

/* ─────────────────────────── stili e profili ─────────────────────────── */

/* Due modi di giocare. Le regole sono le stesse, cambia la scala dei tempi:
   lo SWING legge le candele giornaliere e cerca il momento sulle orarie, e
   tiene da qualche giorno a tre settimane; l'INTRADAY legge le orarie, cerca
   il momento sui quarti d'ora e chiude prima di sera, cosi' non paga notti. */
var STILI = {
  swing:    { nome: 'Swing', segnale: 'DAY', tempo: 'HOUR', candele: 1000, candeleTempo: 300,
              barMs: 86400000, maxBarre: 20, orizzonte: 5, unita: 'giorni' },
  intraday: { nome: 'Intraday', segnale: 'HOUR', tempo: 'MINUTE_15', candele: 1000, candeleTempo: 300,
              barMs: 3600000, maxBarre: 7, orizzonte: 6, unita: 'ore', chiudiASera: true }
};

/* Le regole d'uscita. Una sola tabella, usata dal piano, dal consiglio e dal
   backtest: se il backtest misurasse regole diverse da quelle che l'app poi
   consiglia, le sue probabilita' non varrebbero niente. */
var REGOLE = {
  stopAtr: 1.5,       /* stop iniziale: 1.5 volte l'ATR della scala del segnale */
  tp1: 1.5,           /* primo incasso, in R: si chiude meta' e lo stop va a pareggio */
  tp2: 3.5,           /* secondo incasso, in R: si chiude il resto */
  trailAtr: 2.5,      /* dopo il primo incasso lo stop insegue a 2.5 ATR dal massimo */
  pareggioDa: 1.0,    /* da +1R lo stop va a pareggio anche senza incasso */
  rinforzaDa: 1.0,    /* da +1R, con il segnale ancora in A, si puo' aggiungere meta' */
  vicinoStop: 0.35    /* a meno di 0.35R dallo stop scatta l'attenzione */
};

/* Medio-alto e' il predefinito: lo hai chiesto tu. Il rischio e' la quota
   del budget che si perde se lo stop scatta; la leva non c'entra. */
var PROFILI = {
  deciso:     { nome: 'Deciso',     rischio: 0.025, margineMax: 0.50, gradi: 'A',   colpi: 3,
                frase: 'Solo i segnali A. 2.5% del budget a colpo.' },
  aggressivo: { nome: 'Aggressivo', rischio: 0.040, margineMax: 0.65, gradi: 'AB',  colpi: 3,
                frase: 'Segnali A e B. 4% del budget a colpo. Medio-alto.' },
  spinto:     { nome: 'Spinto',     rischio: 0.060, margineMax: 0.85, gradi: 'ABC', colpi: 4,
                frase: 'Anche i C. 6% del budget a colpo. Due stop di fila e sei a -12%.' }
};
/* Il colpo si dimensiona sulla convinzione: un B rischia tre quarti di un A. */
var PESO_GRADO = { A: 1, B: 0.75, C: 0.5 };

/* Le notti a leva costano. Se Capital.com non manda il suo tasso si usa
   questo: circa il riferimento USA piu' 2.5% l'anno, diviso 360, sul valore
   intero della posizione (non sul margine: e' li' che la leva morde). */
var NOTTE_PREDEFINITA = { lungo: 0.00018, corto: 0.00004 };

/* ─────────────────────────── orari di mercato ─────────────────────────── */

var GIORNI = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function scartoFuso(zona, ms) {
  if (!zona || zona === 'UTC' || zona === 'GMT') return 0;
  try {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var x = {};
    f.formatToParts(new Date(ms)).forEach(function (q) { x[q.type] = q.value; });
    var locale = Date.UTC(+x.year, +x.month - 1, +x.day, +x.hour % 24, +x.minute, +x.second);
    return locale - Math.floor(ms / 1000) * 1000;
  } catch (e) { return 0; }
}

/* Gli orari di Capital.com: {mon: ["13:30 - 20:00"], ..., zone: "UTC"}.
   Ritorna se adesso si puo' trattare, quando chiude e quando riapre. */
function orari(oh, ora) {
  if (!oh) return null;
  var zona = oh.zone || 'UTC', intervalli = [], d, i;
  for (d = -1; d <= 8; d++) {
    var rif = ora + d * 86400000;
    var off = scartoFuso(zona, rif);
    var loc = new Date(rif + off);
    var inizioGiorno = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate()) - off;
    var lista = oh[GIORNI[loc.getUTCDay()]] || [];
    for (i = 0; i < lista.length; i++) {
      var m = /(\d\d?):(\d\d)\s*-\s*(\d\d?):(\d\d)/.exec(lista[i]);
      if (!m) continue;
      var a = (+m[1]) * 60 + (+m[2]), b = (+m[3]) * 60 + (+m[4]);
      if (b <= a) b += 1440;
      intervalli.push([inizioGiorno + a * 60000, inizioGiorno + b * 60000]);
    }
  }
  intervalli.sort(function (x, y) { return x[0] - y[0]; });
  /* "22:00 - 00:00" e poi "00:00 - 21:00" sono una sessione sola */
  var unite = [];
  for (i = 0; i < intervalli.length; i++) {
    var u = unite[unite.length - 1];
    if (u && intervalli[i][0] <= u[1] + 60000) u[1] = Math.max(u[1], intervalli[i][1]);
    else unite.push(intervalli[i].slice());
  }
  for (i = 0; i < unite.length; i++) {
    if (ora >= unite[i][0] && ora < unite[i][1]) return { aperto: true, chiude: unite[i][1], apre: null };
    if (unite[i][0] > ora) return { aperto: false, chiude: null, apre: unite[i][0] };
  }
  return { aperto: false, chiude: null, apre: null };
}

/* ─────────────────────────── l'analisi ─────────────────────────── */

/* Tutto quello che si sa di un mercato adesso. cs sono le candele della scala
   del segnale, ct quelle della scala del tempismo; rif l'indice di
   riferimento gia' passato da indicatori(). */
function analizza(cs, ct, opz) {
  opz = opz || {};
  if (!cs || cs.length < CALDO) return { ok: false, motivo: 'Storia troppo corta: ' + (cs ? cs.length : 0) + ' candele' };
  var ser = indicatori(cs, opz.rif || null);
  var t = cs.length - 1;
  var folla = letturaFolla(opz.percLunghi);
  var sc = punteggio(ser, t, { folla: folla });
  if (!sc) return { ok: false, motivo: 'Indicatori non pronti' };
  var prima = punteggio(ser, t - 1, { folla: folla });
  var u = cs[t];
  var an = {
    ok: true, ser: ser, t: t,
    punti: sc.punti, dir: sc.dir, grado: sc.grado, parti: sc.parti,
    puntiPrima: prima ? prima.punti : null,
    prezzo: u.c, spread: u.s, atr: ser.atr[t], sigma: ser.sigma[t], rsi: ser.rsi[t], adx: ser.adx[t],
    alto20: ser.alto20[t], basso20: ser.basso20[t], ema20: ser.ema20[t], ema50: ser.ema50[t],
    percLunghi: finito(opz.percLunghi) ? opz.percLunghi : null,
    variazione20: t >= 20 ? u.c / cs[t - 20].c - 1 : null
  };
  an.tempismo = tempismo(an, ct, opz.prezzo);
  return an;
}

/* QUANDO entrare. La direzione la dice il segnale; il momento lo dice la
   scala sotto. Tre risposte possibili:

     mercato  adesso, al prezzo che c'e'
     limite   il prezzo e' scappato: si aspetta che torni verso la media
     stop     e' a un passo dalla rottura: si entra solo se rompe davvero

   Per uno che gioca a leva il limite conta piu' di quanto sembri: entrare
   un ATR orario piu' in basso vuol dire uno stop piu' lontano a parita' di
   rischio, o una taglia piu' grande a parita' di stop. */
function tempismo(an, ct, prezzoVivo) {
  var dir = an.dir || 1;
  var bid = prezzoVivo && finito(prezzoVivo.bid) ? prezzoVivo.bid : an.prezzo - an.spread / 2;
  var ask = prezzoVivo && finito(prezzoVivo.ask) ? prezzoVivo.ask : an.prezzo + an.spread / 2;
  var mid = (bid + ask) / 2, entrataMercato = dir > 0 ? ask : bid;
  var out = { tipo: 'mercato', livello: entrataMercato, motivo: '', ext: null, rsiT: null };
  var chiusuraSegnale = an.prezzo, at = an.atr;

  /* la rottura si guarda sulla scala del segnale */
  var limiteRottura = dir > 0 ? an.alto20 : an.basso20;
  if (finito(limiteRottura) && finito(at)) {
    var manca = dir > 0 ? limiteRottura - chiusuraSegnale : chiusuraSegnale - limiteRottura;
    if (manca > 0 && manca < 0.6 * at && Math.abs(an.parti.rottura || 0) < 0.7) {
      out.tipo = 'stop';
      out.livello = limiteRottura + dir * 0.05 * at;
      out.motivo = 'A un passo dal ' + (dir > 0 ? 'massimo' : 'minimo') + ' delle ultime 20 candele: entra solo se ' +
        (dir > 0 ? 'rompe sopra' : 'sfonda sotto') + '.';
    }
  }

  if (ct && ct.length >= 30) {
    var k = colonne(ct), e20 = ema(k.c, 20), r = rsi(k.c, 14), a = atr(k.h, k.l, k.c, 14), n = k.n - 1;
    if (finito(e20[n]) && finito(a[n]) && a[n] > 0) {
      var ext = (mid - e20[n]) / a[n];
      out.ext = ext; out.rsiT = r[n];
      var tirato = dir > 0 ? (ext > 1.6 || r[n] > 72) : (ext < -1.6 || r[n] < 28);
      if (out.tipo !== 'stop' && tirato) {
        out.tipo = 'limite';
        out.livello = e20[n] + dir * 0.25 * a[n];
        out.motivo = 'Il prezzo e\' scappato (RSI ' + Math.round(r[n]) + ' sulla scala corta): aspetta che ' +
          (dir > 0 ? 'ritorni giu\'' : 'rimbalzi su') + ' verso la media.';
      } else if (out.tipo === 'mercato') {
        var giraGiusto = n >= 1 && (dir > 0 ? r[n] > r[n - 1] : r[n] < r[n - 1]);
        var ritracciato = dir > 0 ? (r[n] < 55 && ext < 0.6) : (r[n] > 45 && ext > -0.6);
        out.motivo = ritracciato && giraGiusto
          ? 'Ha appena finito di ritracciare e sta ripartendo: e\' il punto buono.'
          : (ritracciato ? 'E\' in ritracciamento: entri a buon prezzo, lo stop e\' vicino.'
                         : 'Spinge e non e\' ancora tirato: il momento e\' adesso.');
      }
    }
  }
  if (out.tipo === 'mercato') out.livello = entrataMercato;
  if (!out.motivo) out.motivo = 'Il momento e\' adesso.';
  return out;
}

/* ─────────────────────────── il piano ─────────────────────────── */

/* Quanto mettere e come. in:
     an          l'analisi
     budget      quanto vuoi mettere in gioco, nella valuta del conto
     profilo     deciso | aggressivo | spinto
     stile       swing | intraday
     strumento   { valuta, fattoreMargine (%), leva, leve[], dimMin, passo, tipo }
     cambio      quanti soldi del conto vale 1 unita' di valuta dello strumento
     calib       la calibrazione dal backtest (vedi calibra)
     notte       { lungo, corto } costo per notte, frazione del valore
     dir         per forzare una direzione (di solito quella del segnale) */
function piano(inp) {
  var an = inp.an, prof = PROFILI[inp.profilo] || PROFILI.aggressivo, stile = STILI[inp.stile] || STILI.swing;
  var str = inp.strumento || {}, cambio = finito(inp.cambio) && inp.cambio > 0 ? inp.cambio : 1;
  var budget = Math.max(0, +inp.budget || 0);
  var dir = inp.dir || an.dir || 1;
  var grado = an.grado || '';
  var tm = inp.tempismo || an.tempismo || { tipo: 'mercato', livello: an.prezzo + dir * an.spread / 2 };
  var entrata = tm.livello;
  var R = REGOLE.stopAtr * an.atr;
  var avvisi = [];

  /* la distanza minima dello stop la decide Capital.com */
  if (str.distMinStopPerc && R < entrata * str.distMinStopPerc / 100) {
    R = entrata * str.distMinStopPerc / 100;
    avvisi.push('Capital.com vuole lo stop ad almeno ' + str.distMinStopPerc + '% dal prezzo: allargato.');
  }
  var stop = entrata - dir * R;
  var tp1 = entrata + dir * REGOLE.tp1 * R, tp2 = entrata + dir * REGOLE.tp2 * R;

  var ammesso = grado && prof.gradi.indexOf(grado) >= 0 && dir === an.dir;
  var moltGrado = PESO_GRADO[grado] || 0.5;
  var rischioSoldi = budget * prof.rischio * moltGrado;
  var rischioStrum = rischioSoldi / cambio;

  var dimMin = str.dimMin > 0 ? str.dimMin : 0;
  var passo = str.passo > 0 ? str.passo : (dimMin > 0 && dimMin < 1 ? dimMin : (dimMin >= 1 ? 1 : 0.01));
  var dim = R > 0 ? giuAlPasso(rischioStrum / R, passo) : 0;

  /* la leva: quella che hai impostato su Capital.com per questo tipo di
     strumento; se non si sa, la massima che lo strumento concede */
  var levaMax = str.fattoreMargine > 0 ? 100 / str.fattoreMargine : (str.leve && str.leve.length ? Math.max.apply(null, str.leve) : 5);
  var leva = str.leva > 0 ? Math.min(str.leva, levaMax) : levaMax;

  var margineDi = function (d) { return d * entrata * cambio / leva; };
  var tetto = budget * prof.margineMax;
  if (dim > 0 && margineDi(dim) > tetto) {
    var dimTetto = giuAlPasso(tetto * leva / (entrata * cambio), passo);
    avvisi.push('Con leva ' + fmtLeva(leva) + ' il margine supererebbe il ' + Math.round(prof.margineMax * 100) +
      '% del budget: taglia ridotta da ' + dim + ' a ' + dimTetto + '.' +
      (leva < levaMax ? ' Con leva ' + fmtLeva(levaMax) + ' ci starebbe.' : ''));
    dim = dimTetto;
  }
  var sottoMinimo = false;
  if (dimMin > 0 && dim < dimMin) {
    sottoMinimo = true;
    avvisi.push('La taglia minima su Capital.com e\' ' + dimMin + ': con questo budget il rischio vero sarebbe ' +
      fmtNum(dimMin * R * cambio, 2) + ' invece di ' + fmtNum(rischioSoldi, 2) + '.');
  }

  var valore = dim * entrata * cambio;
  var margine = margineDi(dim);
  var perdita = dim * R * cambio;
  var guadagnoTp1 = dim * REGOLE.tp1 * R * cambio;
  var guadagnoPiano = dim * (0.5 * REGOLE.tp1 + 0.5 * REGOLE.tp2) * R * cambio;
  var notte = inp.notte || NOTTE_PREDEFINITA;
  var costoNotte = valore * (dir > 0 ? notte.lungo : notte.corto);

  /* Senza stop, dove ti chiude Capital.com: quando il patrimonio scende sotto
     il 50% del margine richiesto. Calcolato come se il budget fosse tutto
     il conto: se sul conto c'e' di piu', il margine di manovra e' maggiore. */
  var liquidazione = null;
  if (dim > 0) {
    var perditaMax = budget - 0.5 * margine;
    var mossa = perditaMax / (dim * cambio);
    liquidazione = { prezzo: entrata - dir * mossa, perc: mossa / entrata };
  }

  var cal = inp.calib && grado ? inp.calib.perGrado[grado] : null;
  var prob = null;
  if (cal && cal.n > 0) {
    prob = { n: cal.n, vince: cal.pVinceStima, rMedio: cal.rMedioStima, tp1: cal.pTp1Stima,
             attesoSoldi: cal.rMedioStima * perdita };
  }

  return {
    ok: dim > 0, ammesso: ammesso, dir: dir, grado: grado, profilo: prof, stile: stile,
    tipo: tm.tipo, motivoTempo: tm.motivo,
    entrata: entrata, stop: stop, tp1: tp1, tp2: tp2, R: R,
    dim: dim, passo: passo, dimMin: dimMin, sottoMinimo: sottoMinimo,
    leva: leva, levaMax: levaMax, valore: valore, margine: margine,
    levaEffettiva: budget > 0 ? valore / budget : 0,
    rischioSoldi: rischioSoldi, perdita: perdita, guadagnoTp1: guadagnoTp1, guadagnoPiano: guadagnoPiano,
    costoNotte: costoNotte, liquidazione: liquidazione, prob: prob, avvisi: avvisi,
    budget: budget, cambio: cambio, valuta: str.valuta || ''
  };
}

/* Il budget diviso sui colpi migliori. Ogni colpo prende il suo rischio
   pieno finche' il rischio totale resta sotto 2.5 volte quello di un colpo
   singolo, e il margine totale sotto il tetto del profilo. Se i primi due
   sono lo stesso mercato visto due volte (due titoli dei chip, l'indice e il
   suo titolo piu' grosso) si rischia doppio senza saperlo: per questo il
   terzo colpo si prende solo se va in direzione diversa o in un altro
   settore — qui, in mancanza di settori, se non e' lo stesso tipo. */
function ripartisci(piani, budget, profilo) {
  var prof = PROFILI[profilo] || PROFILI.aggressivo;
  var scelti = [], rischio = 0, margine = 0, tettoRischio = budget * prof.rischio * 2.5;
  for (var i = 0; i < piani.length && scelti.length < prof.colpi; i++) {
    var p = piani[i];
    if (!p.ok || !p.ammesso || p.sottoMinimo) continue;
    if (rischio + p.perdita > tettoRischio + 1e-9) continue;
    if (margine + p.margine > budget * prof.margineMax + 1e-9) continue;
    scelti.push(p); rischio += p.perdita; margine += p.margine;
  }
  return { scelti: scelti, rischio: rischio, margine: margine, libero: budget - margine };
}

/* ─────────────────────────── il consiglio ───────────────────────────

   Su una posizione aperta. in:
     pos     { dir, entrata, dim, aperta (ms), stop?, obiettivo?, R?, parziale?, rinforzata?, puntiEntrata? }
     prezzo  { bid, ask }
     ct      candele della scala del tempismo (per il massimo dall'entrata)
     an      l'analisi di adesso sulla scala del segnale
     stile, ora, orari, cambio */

var VERDETTI = {
  esci:     { titolo: 'Esci',             tono: 'rosso',  ordine: 1 },
  incassa:  { titolo: 'Incassa',          tono: 'verde',  ordine: 2 },
  meta:     { titolo: 'Prendi meta\'',    tono: 'verde',  ordine: 3 },
  stop:     { titolo: 'Sposta lo stop',   tono: 'blu',    ordine: 4 },
  rinforza: { titolo: 'Rinforza',         tono: 'blu',    ordine: 5 },
  attento:  { titolo: 'Attento',          tono: 'ambra',  ordine: 6 },
  tieni:    { titolo: 'Tieni',            tono: 'neutro', ordine: 7 }
};

function consiglio(inp) {
  var pos = inp.pos, an = inp.an, stile = STILI[inp.stile] || STILI.swing;
  var dir = pos.dir, entrata = pos.entrata, ora = inp.ora || Date.now();
  var bid = inp.prezzo && finito(inp.prezzo.bid) ? inp.prezzo.bid : (an ? an.prezzo : entrata);
  var ask = inp.prezzo && finito(inp.prezzo.ask) ? inp.prezzo.ask : bid;
  var uscita = dir > 0 ? bid : ask;            /* a quanto chiuderesti adesso */
  var cambio = finito(inp.cambio) && inp.cambio > 0 ? inp.cambio : 1;
  var atrS = an && finito(an.atr) ? an.atr : Math.abs(entrata) * 0.02;

  /* R: il rischio iniziale. Dal piano se c'e', altrimenti dallo stop messo
     su Capital.com, altrimenti dalla regola (1.5 ATR). */
  var R = pos.R > 0 ? pos.R
        : (finito(pos.stopIniziale) ? Math.abs(entrata - pos.stopIniziale)
        : (finito(pos.stop) && (pos.stop - entrata) * dir < 0 ? Math.abs(entrata - pos.stop) : REGOLE.stopAtr * atrS));
  if (!(R > 0)) R = REGOLE.stopAtr * atrS;
  var stopIniziale = entrata - dir * R;

  /* il meglio visto dall'entrata: dalle candele, piu' il prezzo di adesso */
  var meglio = uscita, i, durata = barraMs(inp.ct);
  if (inp.ct) {
    for (i = 0; i < inp.ct.length; i++) {
      var cd = inp.ct[i];
      if (cd.t + durata <= pos.aperta) continue;
      var b = dir > 0 ? cd.h - cd.s / 2 : cd.l + cd.s / 2;
      if (dir > 0 ? b > meglio : b < meglio) meglio = b;
    }
  }
  var rOra = (uscita - entrata) * dir / R;
  var rMax = Math.max(rOra, (meglio - entrata) * dir / R);

  /* lo stop che si dovrebbe avere adesso: sale e non scende mai, perche'
     dipende solo dal massimo raggiunto, che non scende mai */
  var stopRegola = stopIniziale, faseStop = 'iniziale';
  if (rMax >= REGOLE.pareggioDa) { stopRegola = entrata + dir * 0.05 * R; faseStop = 'pareggio'; }
  if (rMax >= REGOLE.tp1) {
    var insegue = meglio - dir * REGOLE.trailAtr * atrS;
    if ((insegue - stopRegola) * dir > 0) { stopRegola = insegue; faseStop = 'insegue'; }
  }
  var stopAttuale = finito(pos.stop) ? pos.stop : null;
  var stopEff = stopAttuale != null && (stopAttuale - stopRegola) * dir > 0 ? stopAttuale : stopRegola;

  var tp1 = entrata + dir * REGOLE.tp1 * R, tp2 = entrata + dir * REGOLE.tp2 * R;
  var pnl = (uscita - entrata) * dir * pos.dim;
  var punti = an && an.ok ? an.punti : null;
  var conDir = punti != null ? punti * dir : null;
  var motivi = [], verdetto = null, frase = '';
  var orario = inp.orari || null;

  function decidi(v, f) { if (!verdetto) { verdetto = v; frase = f; } }

  /* 1. lo stop */
  if ((uscita - stopEff) * dir <= 0) {
    decidi('esci', 'Il prezzo e\' oltre lo stop (' + fmtPrezzo(stopEff) + '). Se Capital.com non ti ha gia\' chiuso, chiudi tu.');
  }
  /* 2. il segnale girato */
  if (conDir != null && conDir <= -SOGLIA_GIRO) {
    decidi('esci', 'Il segnale si e\' girato contro di te: punteggio ' + segno(punti) + '. La ragione per cui eri dentro non c\'e\' piu\'.');
  }
  /* 3. la candela di crollo sulla scala corta */
  if (inp.ct && inp.ct.length > 20 && rOra < 0) {
    var kc = colonne(inp.ct), ac = atr(kc.h, kc.l, kc.c, 14), u = kc.n - 1;
    var corpo = (kc.c[u] - kc.o[u]) * dir;
    if (finito(ac[u]) && corpo < -2.5 * ac[u]) {
      decidi('esci', 'Candela violenta contro di te (' + fmtNum(-corpo / ac[u], 1) + ' volte il movimento normale). Non aspettare lo stop.');
    }
  }
  /* 4. intraday: fuori prima di sera */
  if (stile.chiudiASera && orario && orario.aperto && orario.chiude && orario.chiude - ora < 20 * 60000) {
    decidi('esci', 'Chiude fra ' + Math.max(1, Math.round((orario.chiude - ora) / 60000)) + ' minuti: in intraday non si dorme dentro.');
  }
  /* 5. secondo incasso */
  if (rOra >= REGOLE.tp2) {
    decidi('incassa', 'Obiettivo pieno raggiunto: +' + fmtNum(rOra, 1) + 'R. Chiudi il resto, oppure lascia una coda con lo stop a ' +
      fmtPrezzo(stopRegola) + '.');
  }
  /* 6. primo incasso */
  if (rMax >= REGOLE.tp1 && !pos.parziale) {
    decidi('meta', 'Toccato il primo obiettivo (' + fmtPrezzo(tp1) + '). Chiudi meta\' e porta lo stop a ' + fmtPrezzo(stopRegola) +
      ': da qui in poi il colpo non puo\' piu\' perdere.');
  }
  /* 7. lo stop da spostare */
  var guadagnoStop = stopAttuale == null ? Infinity : (stopRegola - stopAttuale) * dir / R;
  if (rMax >= REGOLE.pareggioDa && guadagnoStop >= 0.25) {
    decidi('stop', 'Porta lo stop a ' + fmtPrezzo(stopRegola) +
      (faseStop === 'pareggio' ? ' (pareggio): il peggio che puo\' succedere adesso e\' uscire pari.'
                               : ': insegue il prezzo a ' + REGOLE.trailAtr + ' ATR dal massimo.'));
  }
  /* 8. rinforzare: solo PRIMA del primo incasso. Dopo, la posizione si
     alleggerisce; prendere meta' e ricomprarla nello stesso giro vuol dire
     pagare due volte lo spread per restare dove si era. */
  if (rOra >= REGOLE.rinforzaDa && rMax < REGOLE.tp1 && !pos.parziale && conDir != null && conDir >= 55 && !pos.rinforzata) {
    decidi('rinforza', 'Sei a +' + fmtNum(rOra, 1) + 'R e il segnale e\' ancora A (' + segno(punti) + '). Aggiungi meta\' della taglia (' +
      fmtNum(giuAlPasso(pos.dim / 2, pos.passo || 0.01), 2) + ') con lo stop di tutto a ' + fmtPrezzo(stopRegola) + '.');
  }

  /* l'attenzione: non cambia il verdetto se ce n'e' gia' uno, ma si scrive */
  var distStopR = (uscita - stopEff) * dir / R;
  if (distStopR > 0 && distStopR < REGOLE.vicinoStop) motivi.push('A ' + fmtNum(distStopR, 2) + 'R dallo stop.');
  if (conDir != null && conDir < 15 && conDir > -SOGLIA_GIRO) motivi.push('La spinta si sta spegnendo: punteggio ' + segno(punti) + '.');
  var barre = Math.max(0, (ora - pos.aperta) / stile.barMs);
  if (barre > stile.maxBarre) motivi.push('Dentro da ' + Math.round(barre) + ' ' + stile.unita + ': oltre il tempo massimo del piano (' + stile.maxBarre + ').');
  var dataOra = new Date(ora);
  if (!stile.chiudiASera && dataOra.getUTCDay() === 5 && dataOra.getUTCHours() >= 17 && rOra < REGOLE.pareggioDa) {
    motivi.push('Venerdi\' sera: il weekend puo\' aprire lunedi\' con un buco oltre lo stop.');
  }
  if (motivi.length) decidi('attento', motivi[0]);
  decidi('tieni', rOra >= 0
    ? 'Tutto secondo il piano. Prossimo passo a ' + fmtPrezzo(rMax >= REGOLE.tp1 ? tp2 : tp1) + '.'
    : 'Sotto, ma dentro il rischio previsto. Lo stop sta a ' + fmtPrezzo(stopEff) + '.');

  /* sempre: la situazione in chiaro */
  var info = [];
  if (punti != null) info.push('Punteggio adesso ' + segno(punti) + (finito(pos.puntiEntrata) ? ' (all\'entrata ' + segno(pos.puntiEntrata) + ')' : '') + '.');
  info.push('Massimo dall\'entrata: ' + (rMax >= 0 ? '+' : '') + fmtNum(rMax, 2) + 'R.');

  return {
    verdetto: verdetto, titolo: VERDETTI[verdetto].titolo, tono: VERDETTI[verdetto].tono, frase: frase,
    motivi: motivi, info: info,
    rOra: rOra, rMax: rMax, R: R, uscita: uscita, pnl: pnl, pnlConto: pnl * cambio,
    stopRegola: stopRegola, stopEff: stopEff, stopIniziale: stopIniziale, faseStop: faseStop,
    tp1: tp1, tp2: tp2, punti: punti, barre: barre
  };
}

/* Il rischio iniziale di una posizione presa senza piano e senza stop: la
   regola (1.5 ATR) con l'ATR dell'ultima candela CHIUSA prima dell'entrata.
   Quella del giorno stesso conterrebbe gia' il dopo. */
function rischioIniziale(cs, ser, aperta) {
  var d = barraMs(cs), t = cs.length - 1;
  while (t > 0 && cs[t].t + d > aperta) t--;
  var a = ser.atr[t];
  return finito(a) && a > 0 ? REGOLE.stopAtr * a : null;
}

function barraMs(cs) {
  if (!cs || cs.length < 2) return 0;
  var d = [], i;
  for (i = Math.max(1, cs.length - 30); i < cs.length; i++) d.push(cs[i].t - cs[i - 1].t);
  d.sort(function (a, b) { return a - b; });
  return d[0];
}

/* ─────────────────────────── il backtest ───────────────────────────

   Le stesse regole del piano e del consiglio, rigiocate candela per candela:

     - il segnale si legge sulla candela CHIUSA t;
     - si entra all'apertura della t+1, pagando l'ask (o incassando il bid);
     - in ogni candela si controlla PRIMA lo stop e POI gli obiettivi: se
       nella stessa candela li tocca entrambi, si assume il peggio;
     - se apre gia' oltre lo stop (il buco del mattino), si esce all'apertura,
       non allo stop: e' quello che succede davvero;
     - le notti si pagano sul valore intero.

   Una posizione alla volta per mercato. Il risultato e' in R: +1R vuol dire
   aver guadagnato quanto si rischiava. */
function backtest(cs, opz) {
  opz = opz || {};
  var stile = STILI[opz.stile] || STILI.swing;
  var ser = opz.ser || indicatori(cs, opz.rif || null);
  var k = ser.k, n = k.n;
  var soglia = finito(opz.soglia) ? opz.soglia : 40;
  var notte = opz.notte || NOTTE_PREDEFINITA;
  var senzaCosti = !!opz.senzaCosti;
  var inizio = Math.max(CALDO, opz.da || 0);
  var colpi = [], punti = vuoto(n), t, aperto = null;

  for (t = inizio; t < n; t++) {
    var sc = punteggio(ser, t, null);
    punti[t] = sc ? sc.punti : NaN;
  }

  for (t = inizio; t < n - 1; t++) {
    if (aperto) continue;
    var p = punti[t];
    if (!finito(p) || Math.abs(p) < soglia) continue;
    var dir = p > 0 ? 1 : -1;
    var mezzoSp = senzaCosti ? 0 : k.s[t + 1] / 2;
    var entrata = k.o[t + 1] + dir * mezzoSp;
    var R = REGOLE.stopAtr * ser.atr[t];
    if (!(R > 0)) continue;
    aperto = { t: t + 1, dir: dir, entrata: entrata, R: R, stop: entrata - dir * R,
               tp1: entrata + dir * REGOLE.tp1 * R, tp2: entrata + dir * REGOLE.tp2 * R,
               meta: false, uscitaMeta: null, meglio: entrata, punti: p, grado: gradoDi(p), tp1Toccato: false };
    var j, esito = null, prezzoUscita = null, notti = 0;
    for (j = t + 1; j < n; j++) {
      var ms = senzaCosti ? 0 : k.s[j] / 2;
      /* prezzi a cui si esce: chi e' lungo esce sul bid, chi e' corto sull'ask */
      var oE = k.o[j] - dir * ms, hE = k.h[j] - dir * ms, lE = k.l[j] - dir * ms, cE = k.c[j] - dir * ms;
      var favorevole = dir > 0 ? hE : lE, contrario = dir > 0 ? lE : hE;
      /* le notti si contano a giorni di calendario: dal venerdi' al lunedi'
         Capital.com ne fa pagare tre, e una candela giornaliera sola */
      if (j > aperto.t && !senzaCosti) notti += Math.floor(k.t[j] / 86400000) - Math.floor(k.t[j - 1] / 86400000);
      /* il buco: apre gia' oltre lo stop */
      if ((oE - aperto.stop) * dir <= 0) { esito = 'stop'; prezzoUscita = oE; break; }
      if ((contrario - aperto.stop) * dir <= 0) { esito = 'stop'; prezzoUscita = aperto.stop; break; }
      if (!aperto.meta && (favorevole - aperto.tp1) * dir >= 0) {
        aperto.meta = true; aperto.tp1Toccato = true;
        aperto.uscitaMeta = (oE - aperto.tp1) * dir >= 0 ? oE : aperto.tp1;
        if ((entrata - aperto.stop) * dir > 0) aperto.stop = entrata + dir * 0.05 * R;
      }
      if ((favorevole - aperto.tp2) * dir >= 0) { esito = 'tp2'; prezzoUscita = (oE - aperto.tp2) * dir >= 0 ? oE : aperto.tp2; break; }
      /* fine candela: il meglio visto, lo stop che insegue, il segnale, il tempo */
      if ((favorevole - aperto.meglio) * dir > 0) aperto.meglio = favorevole;
      var rMax = (aperto.meglio - entrata) * dir / R;
      if (rMax >= REGOLE.pareggioDa && (entrata + dir * 0.05 * R - aperto.stop) * dir > 0) aperto.stop = entrata + dir * 0.05 * R;
      if (rMax >= REGOLE.tp1) {
        var ins = aperto.meglio - dir * REGOLE.trailAtr * ser.atr[j];
        if ((ins - aperto.stop) * dir > 0) aperto.stop = ins;
      }
      if (finito(punti[j]) && punti[j] * dir <= -SOGLIA_GIRO && j + 1 < n) {
        esito = 'giro'; prezzoUscita = k.o[j + 1] - dir * (senzaCosti ? 0 : k.s[j + 1] / 2); j++; break;
      }
      if (j - aperto.t + 1 >= stile.maxBarre) { esito = 'tempo'; prezzoUscita = cE; break; }
      /* intraday: l'ultima candela della giornata chiude tutto */
      if (stile.chiudiASera && (j + 1 >= n || Math.floor(k.t[j + 1] / 86400000) !== Math.floor(k.t[j] / 86400000))) {
        if (j + 1 >= n) break;
        esito = 'sera'; prezzoUscita = cE; break;
      }
    }
    if (!esito) { aperto = null; break; }   /* ancora aperto alla fine della storia: non conta */
    var mossaMeta = aperto.meta ? (aperto.uscitaMeta - entrata) * dir : (prezzoUscita - entrata) * dir;
    var mossaResto = (prezzoUscita - entrata) * dir;
    var costoNotti = notti * entrata * (dir > 0 ? notte.lungo : notte.corto);
    var r = (0.5 * mossaMeta + 0.5 * mossaResto - costoNotti) / R;
    colpi.push({ t: k.t[aperto.t], dir: dir, punti: aperto.punti, grado: aperto.grado, r: r, esito: esito,
                 barre: j - aperto.t + 1, tp1: aperto.tp1Toccato,
                 iEntrata: aperto.t, iUscita: j, tUscita: k.t[Math.min(j, n - 1)], entrata: entrata, uscita: prezzoUscita });
    t = j - 1;          /* si puo' rientrare dalla candela dopo l'uscita */
    aperto = null;
  }
  return { colpi: colpi, punti: punti, ser: ser };
}

function riassumi(colpi) {
  var n = colpi.length, vinte = 0, somma = 0, lordoSu = 0, lordoGiu = 0, picco = 0, cum = 0, dd = 0, barre = 0, tp1 = 0, i;
  var curva = [];
  for (i = 0; i < n; i++) {
    var r = colpi[i].r;
    if (r > 0) { vinte++; lordoSu += r; } else lordoGiu -= r;
    somma += r; cum += r; barre += colpi[i].barre;
    if (colpi[i].tp1) tp1++;
    if (cum > picco) picco = cum;
    if (picco - cum > dd) dd = picco - cum;
    curva.push(cum);
  }
  var rs = colpi.map(function (c) { return c.r; });
  var sd = devStd(rs);
  return {
    n: n, vinte: vinte, pVince: n ? vinte / n : 0, rMedio: n ? somma / n : 0, rTot: somma,
    fattore: lordoGiu > 0 ? lordoSu / lordoGiu : (lordoSu > 0 ? Infinity : 0),
    maxDD: dd, barreMedie: n ? barre / n : 0, pTp1: n ? tp1 / n : 0,
    tStat: n > 1 && sd > 0 ? (somma / n) / (sd / Math.sqrt(n)) : 0, curva: curva
  };
}

/* Il backtest di ogni mercato e' fatto da solo; tu no. Il profilo tiene al
   massimo N colpi aperti insieme: quando sono tutti occupati, i segnali nuovi
   si saltano. Sommare i colpi di venti mercati come se li avessi giocati
   tutti vorrebbe dire contare un rischio che non correrai mai — e un
   periodo peggiore che non e' il tuo. */
function portafoglio(colpi, maxAperti) {
  var ordinati = colpi.slice().sort(function (a, b) { return a.t - b.t; }), aperti = [], presi = [], i;
  for (i = 0; i < ordinati.length; i++) {
    var c = ordinati[i];
    aperti = aperti.filter(function (x) { return x.tUscita > c.t; });
    if (aperti.length >= maxAperti) continue;
    presi.push(c); aperti.push(c);
  }
  return presi;
}

/* Le probabilita' che l'app mostra vengono da qui: tutti i colpi del
   backtest, di tutti i mercati, divisi per grado. Con pochi colpi la stima
   viene tirata verso il "non so" (50% e 0R): dieci colpi vinti su dieci
   non vogliono dire che vince sempre. */
function calibra(tuttiColpi) {
  var perGrado = {}, g;
  ['A', 'B', 'C'].forEach(function (gr) {
    var sel = tuttiColpi.filter(function (c) { return c.grado === gr; });
    var r = riassumi(sel);
    var a = 6, b = 6;   /* prior: 50%, pesa come 12 colpi */
    r.pVinceStima = (r.vinte + a) / (r.n + a + b);
    r.pTp1Stima = (r.pTp1 * r.n + a) / (r.n + a + b);
    r.rMedioStima = r.n ? r.rMedio * r.n / (r.n + 20) : 0;
    perGrado[gr] = r;
  });
  var tutti = riassumi(tuttiColpi);
  var lunghi = riassumi(tuttiColpi.filter(function (c) { return c.dir > 0; }));
  var corti = riassumi(tuttiColpi.filter(function (c) { return c.dir < 0; }));
  for (g in perGrado) if (perGrado.hasOwnProperty(g)) delete perGrado[g].curva;
  return { perGrado: perGrado, tutti: tutti, lunghi: lunghi, corti: corti };
}

/* ─────────────────────────── la previsione ───────────────────────────

   Dove puo' stare il prezzo fra H candele. Il centro non e' un'opinione:
   e' quanto si e' mosso, in passato, il prezzo dopo segnali dello stesso
   grado, misurato in "volatilita'" (cosi' si possono sommare titoli calmi e
   titoli matti). Se lo storico dice che dopo un A il prezzo si e' mosso di
   zero, il centro sta sul prezzo di oggi, e l'app lo dice. */
function derive(ser, punti, H) {
  var k = ser.k, out = [], t;
  for (t = CALDO; t + H < k.n; t++) {
    var p = punti[t], sg = ser.sigma[t];
    if (!finito(p) || !finito(sg) || sg <= 0) continue;
    var g = gradoDi(p);
    if (!g) continue;
    var dir = p > 0 ? 1 : -1;
    out.push({ grado: g, z: dir * Math.log(k.c[t + H] / k.c[t]) / (sg * Math.sqrt(H)) });
  }
  return out;
}
function calibraDerive(tutte) {
  var res = {};
  ['A', 'B', 'C'].forEach(function (g) {
    var z = tutte.filter(function (d) { return d.grado === g; }).map(function (d) { return d.z; });
    var m = media(z), n = z.length;
    /* i campioni si sovrappongono (H candele in avanti da ogni candela):
       l'errore vero e' piu' largo di quello ingenuo, e la stima viene tirata
       verso zero di piu' */
    res[g] = { n: n, z: n ? m * n / (n + 200) : 0, sd: devStd(z) };
  });
  return res;
}
function previsione(an, deriveCal, H) {
  var sg = an.sigma, p = an.prezzo, dir = an.dir || 1;
  var cal = deriveCal && an.grado ? deriveCal[an.grado] : null;
  var z = cal ? cal.z : 0;
  var passi = [], h;
  for (h = 0; h <= H; h++) {
    var s = sg * Math.sqrt(h), centro = p * Math.exp(dir * z * s);
    passi.push({ h: h, centro: centro, lo68: centro * Math.exp(-s), hi68: centro * Math.exp(s),
                 lo90: centro * Math.exp(-1.645 * s), hi90: centro * Math.exp(1.645 * s) });
  }
  var fine = passi[H];
  return { H: H, z: z, n: cal ? cal.n : 0, centro: fine.centro, b68: [fine.lo68, fine.hi68], b90: [fine.lo90, fine.hi90],
           mossaAttesa: fine.centro / p - 1, passi: passi };
}

/* ─────────────────────────── formati ─────────────────────────── */

function fmtNum(x, dec) {
  if (!finito(x)) return '—';
  return x.toFixed(dec == null ? 2 : dec);
}
function decimaliPer(x) {
  var a = Math.abs(x);
  return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 2 : a >= 0.1 ? 4 : 5;
}
function fmtPrezzo(x) { return finito(x) ? x.toFixed(decimaliPer(x)) : '—'; }
function fmtLeva(l) { return (Math.round(l * 10) / 10) + ':1'; }
function segno(x) { return finito(x) ? (x > 0 ? '+' : '') + Math.round(x) : '—'; }

/* ─────────────────────────── esporta ─────────────────────────── */

var API = {
  candele: candele, colonne: colonne, indicatori: indicatori, allineaRiferimento: allineaRiferimento,
  ema: ema, sma: sma, rma: rma, rsi: rsi, atr: atr, adx: adx, macd: macd, donchianPrima: donchianPrima,
  volatilita: volatilita, veroRange: veroRange,
  parti: parti, punteggio: punteggio, gradoDi: gradoDi, letturaFolla: letturaFolla,
  analizza: analizza, tempismo: tempismo, piano: piano, ripartisci: ripartisci, consiglio: consiglio,
  backtest: backtest, riassumi: riassumi, calibra: calibra, portafoglio: portafoglio,
  derive: derive, calibraDerive: calibraDerive, previsione: previsione,
  orari: orari, barraMs: barraMs, giuAlPasso: giuAlPasso, rischioIniziale: rischioIniziale,
  fmtNum: fmtNum, fmtPrezzo: fmtPrezzo, fmtLeva: fmtLeva, segno: segno, decimaliPer: decimaliPer,
  PESI: PESI, GRADI: GRADI, SOGLIA_GIRO: SOGLIA_GIRO, STILI: STILI, REGOLE: REGOLE, PROFILI: PROFILI,
  PESO_GRADO: PESO_GRADO, NOTTE_PREDEFINITA: NOTTE_PREDEFINITA, VERDETTI: VERDETTI, CALDO: CALDO
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
radice.Motore = API;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
