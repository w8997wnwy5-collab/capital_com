/* ==========================================================================
   NON MODIFICARE QUESTO FILE: e' cucito da tools/cuci_worker.js.
   Si cambiano motore.js e server/ponte.js, poi:  node tools/cuci_worker.js
   E' il file da incollare nel pannello di Cloudflare (vedi COME-SI-ACCENDE.md).
   ========================================================================== */

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
/* candele: quante se ne chiedono per il backtest. candeleVive: quante ne
   usa il segnale di ADESSO, nell'app e nel ponte. Devono essere le stesse
   in tutti e due: le medie lunghe partono da un seme, e una storia di 1000
   candele e una di 400 possono dare punteggi diversi di qualche punto.
   Quattrocento bastano per la media a 200 e costano al ponte un terzo del
   calcolo: su Cloudflare gratis ogni giro ha dieci millisecondi. */
var STILI = {
  swing:    { nome: 'Swing', segnale: 'DAY', tempo: 'HOUR', candele: 1000, candeleVive: 400, candeleTempo: 300,
              barMs: 86400000, maxBarre: 20, orizzonte: 5, unita: 'giorni' },
  intraday: { nome: 'Intraday', segnale: 'HOUR', tempo: 'MINUTE_15', candele: 1000, candeleVive: 400, candeleTempo: 300,
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
  vicinoStop: 0.35,   /* a meno di 0.35R dallo stop scatta l'attenzione */
  /* Lo stop e' un ordine a mercato: quando scatta esce al prezzo che c'e',
     di solito un po' peggio del livello. Il backtest lo faceva uscire
     esattamente sul livello, e su una passeggiata a caso questo bastava a
     inventare +0.03/+0.06R a colpo: un vantaggio che non esiste. Adesso
     ogni stop preso dentro la candela paga 0.05 ATR di slittamento (i buchi
     d'apertura escono gia' all'apertura, peggio). */
  slittamentoAtr: 0.05
};

/* Medio-alto e' il predefinito: lo hai chiesto tu. Il rischio e' la quota
   del budget che si perde se lo stop scatta; la leva non c'entra. */
var PROFILI = {
  deciso:     { nome: 'Deciso',     rischio: 0.025, margineMax: 0.50, gradi: 'A',   colpi: 3,
                frase: 'Solo i segnali A. 2.5% del budget a colpo.' },
  aggressivo: { nome: 'Aggressivo', rischio: 0.040, margineMax: 0.65, gradi: 'AB',  colpi: 3,
                frase: 'Segnali A e B. 4% del budget a colpo. Medio-alto.' },
  spinto:     { nome: 'Spinto',     rischio: 0.060, margineMax: 0.85, gradi: 'ABC', colpi: 4,
                frase: 'Anche i C. 6% del budget a colpo. Due stop di fila e sei a -12%.' },
  /* il profilo del robot: non si sceglie a mano, lo usa il robot */
  estremo:    { nome: 'Estremo',    rischio: 0.100, margineMax: 0.95, gradi: 'ABC', colpi: 10, robot: true,
                frase: 'Il robot. Segnali A, B e C, 10% del budget a colpo, fino a 10 posizioni. Il freno e\' la perdita massima che scegli tu.' }
};
/* Il colpo si dimensiona sulla convinzione: un B rischia tre quarti di un A. */
var PESO_GRADO = { A: 1, B: 0.75, C: 0.5 };

/* Le notti a leva costano. Se Capital.com non manda il suo tasso si usa
   questo: circa il riferimento USA piu' 2.5% l'anno, diviso 360, sul valore
   intero della posizione (non sul margine: e' li' che la leva morde). */
var NOTTE_PREDEFINITA = { lungo: 0.00018, corto: 0.00004 };

/* Il profilo giocherebbe questo segnale? Una riga, ma la usano il radar
   dell'app e gli avvisi d'ingresso del ponte: deve essere la stessa. */
function pronto(an, profilo) {
  var prof = PROFILI[profilo];
  return !!(an && an.ok && an.grado && prof && prof.gradi.indexOf(an.grado) >= 0);
}
function sogliaProfilo(profilo) {
  var g = (PROFILI[profilo] || PROFILI.aggressivo).gradi;
  return g.indexOf('C') >= 0 ? 28 : g.indexOf('B') >= 0 ? 40 : 55;
}

/* Da un mercato di Capital.com (/markets/{epic} o una voce di marketDetails)
   allo strumento che serve al piano. Anche questa e' condivisa: il piano
   dell'app e quello dell'avviso su Telegram devono dare la stessa taglia. */
function strumentoDa(d, leve) {
  d = d || {};
  var ins = d.instrument || {}, dr = d.dealingRules || {};
  var lv = leve && ins.type && leve[ins.type] ? leve[ins.type] : null;
  var dist = dr.minNormalStopOrLimitDistance;
  return {
    valuta: ins.currency, tipo: ins.type,
    fattoreMargine: ins.marginFactorUnit === 'PERCENTAGE' ? ins.marginFactor : null,
    leva: lv ? lv.current : null, leve: lv ? lv.available : null,
    dimMin: dr.minDealSize ? dr.minDealSize.value : null,
    passo: dr.minSizeIncrement ? dr.minSizeIncrement.value : null,
    distMinStopPerc: dist && dist.unit === 'PERCENTAGE' ? dist.value : null
  };
}

/* Capital.com da' il costo della notte in percento (negativo = paghi). Se
   arriva un numero grande e' un tasso annuo: si divide per 360. */
function notteDa(of) {
  if (!of || typeof of.longRate !== 'number') return null;
  var conv = function (r) { var d = Math.abs(r) > 0.2 ? r / 360 : r; return -d / 100; };
  return { lungo: conv(of.longRate), corto: conv(typeof of.shortRate === 'number' ? of.shortRate : of.longRate) };
}

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
  /* ser gia' calcolato: il ponte lo tiene da parte finche' le candele sono
     le stesse, perche' il tempo di calcolo su Cloudflare e' contato. Chi lo
     passa garantisce che sia di queste candele e di questo riferimento. */
  var ser = opz.ser || indicatori(cs, opz.rif || null);
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

/* ─────────────────────────── il robot ───────────────────────────

   Le decisioni del robot, separate da chi le esegue. Il ponte le chiama a
   ogni giro e fa quello che dicono; i test le chiamano con situazioni
   inventate e controllano che dicano la cosa giusta. Qui non si parla con
   Capital.com: si decide e basta.

   Il robot gioca il profilo Estremo, una posizione sola per colpo. Stop e
   take profit (al secondo obiettivo) stanno su Capital.com dal primo
   secondo: se il ponte si ferma, la posizione resta protetta. Il resto —
   stop a pareggio, stop che insegue, uscita se il segnale si gira — lo fa il
   ponte, con le stesse regole del consiglio e del backtest (unaSola).

   Il tetto: il robot non mette mai a rischio piu' di quanto resta della
   perdita massima che hai scelto. Se scattassero tutti gli stop insieme
   arriveresti al tetto, non oltre — salvo i buchi di prezzo, che nessuno
   stop puo' fermare. */

var ROBOT = {
  profilo: 'estremo',
  margineUsabile: 0.9,            /* del margine disponibile sul conto: il resto e' cuscinetto */
  minutiPrimaChiusura: 45,        /* in intraday non si entra a meno di 45 minuti dalla chiusura */
  pausaDopoChiusura: { swing: 20 * 3600000, intraday: 3600000 },  /* stesso mercato, stessa direzione */
  minimoFinoA: 2,                 /* la taglia minima si accetta se rischia al massimo il doppio del previsto */
  stopMinimo: 0.2                 /* lo stop si sposta solo se migliora di almeno 0.2R */
};

function robotEntrata(inp) {
  var an = inp.an, p = inp.piano, st = inp.stato || {}, ora = inp.ora || Date.now();
  var stile = STILI[inp.stile] ? inp.stile : 'swing';
  var no = function (m) { return { apri: false, motivo: m }; };
  if (!an || !an.ok) return no((an && an.motivo) || 'nessuna analisi');
  if (!pronto(an, ROBOT.profilo)) return no('nessun segnale (' + segno(an.punti) + ')');
  if (!p || !(p.R > 0) || !(p.entrata > 0)) return no('piano non calcolabile');
  if (p.tipo !== 'mercato') return no(p.tipo === 'limite' ? 'prezzo scappato: aspetta che torni' : 'aspetta la rottura');
  if (inp.giaDentro) return no('gia\' dentro su questo mercato');
  var rec = inp.chiusaDiRecente;
  if (rec && rec.dir === an.dir && ora - rec.quando < ROBOT.pausaDopoChiusura[stile]) return no('chiusa da poco nella stessa direzione');
  if ((st.aperte || 0) >= (st.maxPosizioni || 10)) return no('posti pieni');
  if (inp.orario) {
    if (!inp.orario.aperto) return no('mercato chiuso');
    if (STILI[stile].chiudiASera && inp.orario.chiude && inp.orario.chiude - ora < ROBOT.minutiPrimaChiusura * 60000) return no('chiude fra poco');
  }
  var passo = p.passo > 0 ? p.passo : 0.01, dimMin = p.dimMin > 0 ? p.dimMin : 0;
  var cambio = p.cambio > 0 ? p.cambio : 1;
  var rischioUnita = p.R * cambio, margineUnita = p.entrata * cambio / (p.leva > 0 ? p.leva : 1);
  var dim = p.dim;
  if (!(dim > 0) || dim < dimMin) {
    /* sotto la taglia minima: la minima va bene solo se non rischia troppo */
    if (dimMin > 0 && dimMin * rischioUnita <= ROBOT.minimoFinoA * p.rischioSoldi) dim = dimMin;
    else return no('taglia minima troppo grossa per il budget');
  }
  var spazio = (st.residuo || 0) - (st.rischioAperto || 0);
  if (dim * rischioUnita > spazio) dim = giuAlPasso(Math.max(0, spazio) / rischioUnita, passo);
  if (!(dim > 0) || dim < dimMin) return no('tetto di perdita: restano ' + fmtNum(Math.max(0, spazio), 2) + ' da rischiare');
  var usabile = (st.disponibile || 0) * ROBOT.margineUsabile;
  if (dim * margineUnita > usabile) dim = giuAlPasso(Math.max(0, usabile) / margineUnita, passo);
  if (!(dim > 0) || dim < dimMin) return no('margine finito sul conto');
  return { apri: true, dim: dim, dir: an.dir, stop: p.stop, tp: p.tp2, R: p.R, entrata: p.entrata,
           rischio: dim * rischioUnita, margine: dim * margineUnita, motivo: p.motivoTempo || '' };
}

/* Su una posizione del robot: chiudere, spostare lo stop su Capital.com, o
   niente. c e' il consiglio (calcolato con parziale = true: il robot non
   prende meta'), pos.stop lo stop che c'e' adesso su Capital.com. */
function robotUscita(c, pos, stile) {
  if (!c) return { azione: null, motivo: 'nessun consiglio' };
  var S = STILI[stile] || STILI.swing;
  if (c.verdetto === 'esci' || c.verdetto === 'incassa') return { azione: 'chiudi', motivo: c.frase };
  if (c.barre > S.maxBarre) return { azione: 'chiudi', motivo: 'Tempo massimo del piano: ' + S.maxBarre + ' ' + S.unita + '.' };
  var migliora = pos.stop == null ? Infinity : (c.stopRegola - pos.stop) * pos.dir / c.R;
  if (migliora >= ROBOT.stopMinimo && (c.uscita - c.stopRegola) * pos.dir > 0) {
    return { azione: 'stop', livello: c.stopRegola, motivo: c.faseStop === 'pareggio' ? 'Stop a pareggio.' : 'Lo stop insegue il prezzo.' };
  }
  return { azione: null, motivo: c.frase };
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
  var senzaCosti = !!opz.senzaCosti, unaSola = !!opz.unaSola;
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
      if ((contrario - aperto.stop) * dir <= 0) {
        var slip = senzaCosti ? 0 : REGOLE.slittamentoAtr * (finito(ser.atr[j]) ? ser.atr[j] : 0);
        esito = 'stop';
        prezzoUscita = dir > 0 ? Math.max(aperto.stop - slip, lE) : Math.min(aperto.stop + slip, hE);
        break;
      }
      if (!aperto.tp1Toccato && (favorevole - aperto.tp1) * dir >= 0) {
        aperto.tp1Toccato = true;
        /* il robot (unaSola) non chiude meta': tiene tutto e lascia correre */
        if (!unaSola) { aperto.meta = true; aperto.uscitaMeta = (oE - aperto.tp1) * dir >= 0 ? oE : aperto.tp1; }
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
  pronto: pronto, sogliaProfilo: sogliaProfilo, strumentoDa: strumentoDa, notteDa: notteDa,
  robotEntrata: robotEntrata, robotUscita: robotUscita, ROBOT: ROBOT,
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

const Motore = globalThis.Motore;

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
