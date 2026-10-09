/*
  Il motore fa quello che dice?

  Un backtest che sbaglia e' peggio di nessun backtest: da' fiducia che non
  c'e'. Qui si controllano le cose che, se sbagliate, non si vedono:

    - gli indicatori contro un'implementazione ingenua scritta a parte;
    - nessuno sguardo nel futuro: il punteggio alla candela t e' identico
      tagliando la storia a t;
    - su un mercato che e' una passeggiata a caso, senza costi, il guadagno
      medio deve essere zero. Se fosse positivo il motore starebbe barando;
    - aggiungere i costi non migliora mai il risultato;
    - il piano rischia quello che dice, il consiglio dice quello che deve.

      node tools/test_motore.js
*/
'use strict';
var path = require('path');
var M = require(path.join(__dirname, '..', 'motore.js'));
var E = require(path.join(__dirname, '..', 'esempio.js'));

var esiti = [];
function prova(nome, ok, dettaglio) { esiti.push([nome, !!ok, dettaglio == null ? '' : String(dettaglio)]); }
function vicino(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-9) * Math.max(1, Math.abs(b)); }

/* caso ripetibile */
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

/* Una passeggiata a caso con candele vere: dentro ogni candela il prezzo fa
   venti passi, e apertura, massimo, minimo e chiusura vengono da li'. La
   chiusura di una e' l'apertura della successiva: niente buchi, quindi niente
   regali e niente furti al momento dell'uscita. */
/* I passi dentro la candela contano: con pochi passi il prezzo salta oltre lo
   stop di un pezzo, e un backtest che esce sul livello esatto ci guadagna
   sopra (succedeva: +0.04R a colpo su 9'000 colpi). Per il test dello zero
   servono candele fatte di molti passi piccoli, quasi continue; il backtest
   vero quello slittamento lo paga (REGOLE.slittamentoAtr). */
function passeggiata(n, seme, vol, spreadRel, passi, ms) {
  passi = passi || 20; ms = ms || 86400000;
  var rnd = generatore(seme), p = 100, out = [], i, j;
  for (i = 0; i < n; i++) {
    var o = p, h = p, l = p;
    for (j = 0; j < passi; j++) {
      p *= Math.exp(vol / Math.sqrt(passi) * normale(rnd) - 0.5 * vol * vol / passi);
      if (p > h) h = p; if (p < l) l = p;
    }
    out.push({ t: Date.UTC(2020, 0, 1) + i * ms, o: o, h: h, l: l, c: p, s: p * (spreadRel || 0), v: 1000 });
  }
  return out;
}

/* ── candele da Capital.com ─────────────────────────────────────────────── */
var esempioDoc = { prices: [
  { snapshotTime: '2022-04-06T15:18:00', snapshotTimeUTC: '2022-04-06T13:18:00',
    openPrice: { bid: 24.356, ask: 24.376 }, closePrice: { bid: 24.378, ask: 24.398 },
    highPrice: { bid: 24.378, ask: 24.398 }, lowPrice: { bid: 24.355, ask: 24.375 }, lastTradedVolume: 187 },
  { snapshotTime: '2022-04-06T15:19:00', snapshotTimeUTC: '2022-04-06T13:19:00',
    openPrice: { bid: 24.379, ask: 24.399 }, closePrice: { bid: 24.379, ask: 24.399 },
    highPrice: { bid: 24.389, ask: 24.409 }, lowPrice: { bid: 24.373, ask: 24.393 }, lastTradedVolume: 168 },
  { snapshotTime: '2022-04-06T15:19:00', snapshotTimeUTC: '2022-04-06T13:19:00',
    openPrice: { bid: 24.379, ask: 24.399 }, closePrice: { bid: 24.38, ask: 24.4 },
    highPrice: { bid: 24.389, ask: 24.409 }, lowPrice: { bid: 24.373, ask: 24.393 }, lastTradedVolume: 170 },
  { snapshotTime: '2022-04-06T15:20:00', snapshotTimeUTC: '2022-04-06T13:20:00',
    openPrice: { bid: null, ask: null }, closePrice: {}, highPrice: {}, lowPrice: {} }
] };
var cs0 = M.candele(esempioDoc);
prova('candele: doppioni e candele vuote spariscono', cs0.length === 2, cs0.length);
prova('candele: l\'orario e\' UTC', cs0[0].t === Date.UTC(2022, 3, 6, 13, 18), new Date(cs0[0].t).toISOString());
prova('candele: prezzo medio fra bid e ask', vicino(cs0[0].c, 24.388, 1e-12), cs0[0].c);
prova('candele: lo spread e\' quello vero', vicino(cs0[0].s, 0.02, 1e-9), cs0[0].s);
prova('candele: dei doppioni resta l\'ultimo', vicino(cs0[1].c, 24.39, 1e-12), cs0[1].c);

/* ── indicatori contro un'implementazione ingenua ───────────────────────── */
var rw = passeggiata(600, 7, 0.02, 0.001), K = M.colonne(rw);
(function () {
  /* EMA: seme = media semplice delle prime n, poi la ricorsione */
  var n = 20, a = 2 / (n + 1), ref = [], i, s = 0;
  for (i = 0; i < n; i++) s += K.c[i];
  ref[n - 1] = s / n;
  for (i = n; i < K.n; i++) ref[i] = ref[i - 1] + a * (K.c[i] - ref[i - 1]);
  var e = M.ema(K.c, n), peggio = 0;
  for (i = n - 1; i < K.n; i++) peggio = Math.max(peggio, Math.abs(e[i] - ref[i]));
  prova('EMA come da definizione', peggio < 1e-9 && isNaN(e[n - 2]), peggio);

  /* RSI di Wilder scritto per esteso */
  var gs = 0, ls = 0;
  for (i = 1; i <= 14; i++) { var d = K.c[i] - K.c[i - 1]; gs += Math.max(d, 0); ls += Math.max(-d, 0); }
  var ag = gs / 14, al = ls / 14, refR = [];
  refR[14] = 100 - 100 / (1 + ag / al);
  for (i = 15; i < K.n; i++) {
    var dd = K.c[i] - K.c[i - 1];
    ag = (ag * 13 + Math.max(dd, 0)) / 14; al = (al * 13 + Math.max(-dd, 0)) / 14;
    refR[i] = 100 - 100 / (1 + ag / al);
  }
  var r = M.rsi(K.c, 14); peggio = 0;
  for (i = 14; i < K.n; i++) peggio = Math.max(peggio, Math.abs(r[i] - refR[i]));
  prova('RSI di Wilder', peggio < 1e-9, peggio);

  /* ATR */
  var tr = [], refA = [];
  for (i = 0; i < K.n; i++) tr[i] = i ? Math.max(K.h[i] - K.l[i], Math.abs(K.h[i] - K.c[i - 1]), Math.abs(K.l[i] - K.c[i - 1])) : K.h[i] - K.l[i];
  s = 0; for (i = 0; i < 14; i++) s += tr[i];
  refA[13] = s / 14;
  for (i = 14; i < K.n; i++) refA[i] = (refA[i - 1] * 13 + tr[i]) / 14;
  var at = M.atr(K.h, K.l, K.c, 14); peggio = 0;
  for (i = 13; i < K.n; i++) peggio = Math.max(peggio, Math.abs(at[i] - refA[i]));
  prova('ATR di Wilder', peggio < 1e-9, peggio);

  /* Donchian: il massimo delle venti PRIMA, mai la candela stessa */
  var d20 = M.donchianPrima(K.h, K.l, 20), ok = true;
  for (i = 20; i < K.n; i++) {
    var mx = Math.max.apply(null, K.h.slice(i - 20, i));
    if (d20.alto[i] !== mx) ok = false;
  }
  prova('Donchian guarda solo le candele precedenti', ok);

  var ax = M.adx(K.h, K.l, K.c, 14), dentro = true;
  for (i = 40; i < K.n; i++) if (!(ax.adx[i] >= 0 && ax.adx[i] <= 100)) dentro = false;
  prova('ADX fra 0 e 100', dentro);
})();

/* ── nessuno sguardo nel futuro ─────────────────────────────────────────── */
(function () {
  var cs = passeggiata(700, 11, 0.02, 0.0005), rif = M.indicatori(passeggiata(700, 12, 0.012, 0));
  var intera = M.indicatori(cs, rif), diversi = 0, provati = 0, t;
  for (t = 150; t < cs.length; t += 37) {
    var tagliate = M.indicatori(cs.slice(0, t + 1), rif);
    var a = M.punteggio(intera, t, null), b = M.punteggio(tagliate, t, null);
    provati++;
    if (!a || !b || a.punti !== b.punti || JSON.stringify(a.parti) !== JSON.stringify(b.parti)) diversi++;
  }
  prova('il punteggio a t non cambia tagliando la storia a t', diversi === 0, provati + ' punti provati, diversi ' + diversi);

  /* e il riferimento? tagliare l'INDICE dopo t non deve cambiare niente */
  var rifCs = passeggiata(700, 12, 0.012, 0), diversiRif = 0;
  for (t = 200; t < cs.length; t += 61) {
    var rifTagliato = M.indicatori(rifCs.slice(0, t + 1));
    var c = M.punteggio(M.indicatori(cs, rifTagliato), t, null), d = M.punteggio(intera, t, null);
    if (!c || !d || c.punti !== d.punti) diversiRif++;
  }
  prova('anche l\'indice di riferimento e\' letto solo fino a t', diversiRif === 0, diversiRif);
})();

/* ── il backtest su una passeggiata a caso ──────────────────────────────── */
(function () {
  var tutti = [], conCosti = [], fuori = 0, s;
  for (s = 1; s <= 120; s++) {
    var cs = passeggiata(900, 1000 + s, 0.02, 0, 400);
    var bt = M.backtest(cs, { soglia: 28, senzaCosti: true });
    bt.colpi.forEach(function (c) {
      tutti.push(c);
      /* ogni prezzo di entrata e di uscita sta dentro la sua candela */
      var e = cs[c.iEntrata], u = cs[c.iUscita];
      if (c.entrata < e.l - 1e-9 || c.entrata > e.h + 1e-9) fuori++;
      if (c.uscita < u.l - 1e-9 || c.uscita > u.h + 1e-9) fuori++;
    });
    var cs2 = cs.map(function (x) { return { t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, s: x.c * 0.001, v: x.v }; });
    conCosti = conCosti.concat(M.backtest(cs2, { soglia: 28 }).colpi);
  }
  var r = M.riassumi(tutti), rc = M.riassumi(conCosti);
  prova('passeggiata a caso senza costi: guadagno medio compatibile con zero',
        Math.abs(r.tStat) < 2.6 && r.n > 300, 'colpi ' + r.n + ', R medio ' + r.rMedio.toFixed(4) + ', t ' + r.tStat.toFixed(2));
  prova('ogni prezzo d\'entrata e d\'uscita sta dentro la sua candela', fuori === 0, fuori + ' fuori su ' + (2 * tutti.length));
  prova('con lo spread si guadagna meno, mai di piu\'', rc.rMedio < r.rMedio, rc.rMedio.toFixed(4) + ' < ' + r.rMedio.toFixed(4));
  var peggio = Math.min.apply(null, tutti.filter(function (c) { return c.esito !== 'stop'; }).map(function (c) { return c.r; }));
  prova('senza buchi, nessuna uscita perde piu\' di 1R oltre lo stop', peggio > -1.6, peggio.toFixed(3));
  var d1 = M.backtest(passeggiata(900, 5, 0.02, 0.001), { soglia: 40 });
  var d2 = M.backtest(passeggiata(900, 5, 0.02, 0.001), { soglia: 40 });
  prova('stesso ingresso, stesso risultato', JSON.stringify(d1.colpi) === JSON.stringify(d2.colpi));
})();

/* ── il portafoglio: al massimo N colpi aperti insieme ─────────────────── */
(function () {
  var g = 86400000;
  var colpi = [
    { t: 0, tUscita: 10 * g, r: 1 }, { t: 1 * g, tUscita: 5 * g, r: 1 }, { t: 2 * g, tUscita: 3 * g, r: 1 },
    { t: 2.5 * g, tUscita: 4 * g, r: -1 }, { t: 6 * g, tUscita: 8 * g, r: 1 }, { t: 11 * g, tUscita: 12 * g, r: 1 }
  ];
  var p = M.portafoglio(colpi, 2);
  prova('portafoglio: con due posti, il terzo segnale contemporaneo si salta', p.length === 4 && p.indexOf(colpi[2]) < 0 && p.indexOf(colpi[3]) < 0,
        p.map(function (c) { return c.t / g; }).join(','));
  prova('portafoglio: un posto che si libera si riusa', p.indexOf(colpi[4]) >= 0 && p.indexOf(colpi[5]) >= 0);
})();

/* ── il piano ───────────────────────────────────────────────────────────── */
(function () {
  var an = { ok: true, dir: 1, grado: 'A', punti: 62, prezzo: 100, spread: 0.1, atr: 2, sigma: 0.02,
             parti: { rottura: 0.9 }, tempismo: { tipo: 'mercato', livello: 100.05, motivo: '' } };
  var str = { valuta: 'USD', fattoreMargine: 20, leva: 5, dimMin: 1, passo: 1 };
  var p = M.piano({ an: an, budget: 5000, profilo: 'aggressivo', stile: 'swing', strumento: str, cambio: 0.8 });
  /* rischio: 5000 * 4% = 200 CHF = 250 USD; R = 3 USD -> 83 azioni */
  prova('piano: R = 1.5 ATR', vicino(p.R, 3), p.R);
  prova('piano: la taglia viene dal rischio e si arrotonda in giu\'', p.dim === 83, p.dim);
  prova('piano: allo stop si perde al massimo il rischio scelto', p.perdita <= 200 + 1e-9 && p.perdita > 195, p.perdita.toFixed(2));
  prova('piano: margine = valore / leva', vicino(p.margine, 83 * 100.05 * 0.8 / 5, 1e-12), p.margine.toFixed(2));
  prova('piano: stop sotto, obiettivi sopra', p.stop < p.entrata && p.tp1 > p.entrata && p.tp2 > p.tp1);
  prova('piano: un A e\' ammesso per l\'aggressivo', p.ammesso);

  var pB = M.piano({ an: Object.assign({}, an, { grado: 'B' }), budget: 5000, profilo: 'aggressivo', strumento: str, cambio: 0.8 });
  prova('piano: un B rischia tre quarti di un A', vicino(pB.rischioSoldi, 150), pB.rischioSoldi);
  var pC = M.piano({ an: Object.assign({}, an, { grado: 'C' }), budget: 5000, profilo: 'deciso', strumento: str, cambio: 0.8 });
  prova('piano: un C non e\' ammesso per il deciso', !pC.ammesso);

  var stretto = M.piano({ an: Object.assign({}, an, { atr: 0.05 }), budget: 5000, profilo: 'spinto', strumento: { valuta: 'USD', fattoreMargine: 50, leva: 2, dimMin: 1, passo: 1 }, cambio: 1 });
  prova('piano: il margine non supera il tetto del profilo', stretto.margine <= 5000 * 0.85 + 1e-9 && stretto.avvisi.length > 0,
        stretto.margine.toFixed(0) + ' — ' + (stretto.avvisi[0] || ''));

  var piccolo = M.piano({ an: an, budget: 50, profilo: 'aggressivo', strumento: str, cambio: 1 });
  prova('piano: sotto la taglia minima lo dice', piccolo.dim === 0 && piccolo.sottoMinimo && !piccolo.ok, piccolo.avvisi.join(' '));

  var corto = M.piano({ an: Object.assign({}, an, { dir: -1, punti: -60, tempismo: { tipo: 'mercato', livello: 99.95 } }), budget: 5000, profilo: 'aggressivo', strumento: str, cambio: 1 });
  prova('piano corto: stop sopra, obiettivi sotto', corto.stop > corto.entrata && corto.tp1 < corto.entrata);
  prova('piano: la liquidazione sta oltre lo stop', (p.liquidazione.prezzo < p.stop), M.fmtPrezzo(p.liquidazione.prezzo) + ' < ' + M.fmtPrezzo(p.stop));

  var rip = M.ripartisci([p, pB, corto, p], 5000, 'aggressivo');
  prova('ripartizione: il rischio totale resta sotto 2.5 colpi', rip.rischio <= 5000 * 0.04 * 2.5 + 1e-9, rip.rischio.toFixed(0));
})();

/* ── il consiglio ───────────────────────────────────────────────────────── */
(function () {
  var base = Date.UTC(2026, 9, 6, 15, 0);   /* martedi' */
  var an = { ok: true, punti: 45, atr: 2, prezzo: 100 };
  var pos = { dir: 1, entrata: 100, dim: 10, aperta: base, R: 3 };
  function c(bid, extra, ct, anX) {
    return M.consiglio(Object.assign({ pos: Object.assign({}, pos, extra || {}), prezzo: { bid: bid, ask: bid + 0.1 },
      an: anX || an, ct: ct || null, stile: 'swing', ora: base + 3600000 }));
  }
  function barra(h, l, dt) { return { t: base + (dt || 0), o: (h + l) / 2, h: h, l: l, c: (h + l) / 2, s: 0 }; }

  prova('consiglio: sotto lo stop si esce', c(96.9).verdetto === 'esci', c(96.9).frase);
  prova('consiglio: appena entrato si tiene', c(100.5).verdetto === 'tieni', c(100.5).frase);
  var girato = c(101, null, null, { ok: true, punti: -35, atr: 2, prezzo: 101 });
  prova('consiglio: segnale girato, si esce anche in guadagno', girato.verdetto === 'esci', girato.frase);
  prova('consiglio: al primo obiettivo si prende meta\'', c(104.6).verdetto === 'meta', c(104.6).frase);
  var dopo = c(104.6, { parziale: true, stop: 100.15 });
  prova('consiglio: dopo meta\' e stop a pareggio, si tiene', dopo.verdetto === 'tieni', dopo.verdetto + ': ' + dopo.frase);
  prova('consiglio: a +3.5R si incassa', c(110.6).verdetto === 'incassa', c(110.6).frase);
  var daSpostare = c(103.2, { stop: 97 });
  prova('consiglio: da +1R lo stop va a pareggio', daSpostare.verdetto === 'stop' && daSpostare.stopRegola > 100, daSpostare.frase);
  /* massimo a +2R visto nelle candele, poi tornato a +0.2R senza parziale:
     lo stop a pareggio e' gia' stato superato al ritorno? no, +0.2R > +0.05R */
  var ct = [barra(106.1, 101, 0), barra(103, 100.4, 3600000)];
  var tornato = c(100.6, { parziale: true, stop: 100.15 }, ct);
  prova('consiglio: il massimo si legge dalle candele dopo l\'entrata', tornato.rMax > 1.9, tornato.rMax.toFixed(2));
  var sotto = c(100.1, { parziale: true, stop: 100.15 }, ct);
  prova('consiglio: tornato sotto il pareggio dopo +2R, si esce', sotto.verdetto === 'esci', sotto.frase);
  var vecchie = [barra(130, 90, -86400000 * 3)];
  prova('consiglio: le candele di prima dell\'entrata non contano', c(100.5, null, vecchie).rMax < 0.5, c(100.5, null, vecchie).rMax.toFixed(2));
  var forte = c(103.5, { stop: 100.15 }, null, { ok: true, punti: 70, atr: 2, prezzo: 103.5 });
  prova('consiglio: a +1R con segnale A si rinforza', forte.verdetto === 'rinforza', forte.frase);
  var dopoMeta = c(103.5, { stop: 100.15, parziale: true }, [barra(105, 100, 0)], { ok: true, punti: 70, atr: 2, prezzo: 103.5 });
  prova('consiglio: dopo aver preso meta\' non si rinforza', dopoMeta.verdetto !== 'rinforza', dopoMeta.verdetto);

  /* lo stop che insegue non scende mai: si alza il massimo, lo stop sale */
  var s1 = c(105, { parziale: true }, [barra(107, 100, 0)]).stopRegola;
  var s2 = c(105, { parziale: true }, [barra(107, 100, 0), barra(109, 104, 3600000)]).stopRegola;
  prova('consiglio: lo stop che insegue sale col massimo', s2 > s1, s1.toFixed(2) + ' -> ' + s2.toFixed(2));

  var corto = M.consiglio({ pos: { dir: -1, entrata: 100, dim: 5, aperta: base, R: 3 }, prezzo: { bid: 95.4, ask: 95.5 },
                            an: { ok: true, punti: -50, atr: 2, prezzo: 95.5 }, stile: 'swing', ora: base + 3600000 });
  prova('consiglio corto: guadagno quando scende', corto.rOra > 1.4 && corto.verdetto === 'meta' && corto.pnl > 0, corto.verdetto + ' ' + corto.rOra.toFixed(2));

  var venerdi = M.consiglio({ pos: pos, prezzo: { bid: 100.4, ask: 100.5 }, an: an, stile: 'swing', ora: Date.UTC(2026, 9, 9, 18, 30) });
  prova('consiglio: venerdi\' sera avvisa del weekend', venerdi.verdetto === 'attento', venerdi.frase);
  var sera = M.consiglio({ pos: pos, prezzo: { bid: 100.4, ask: 100.5 }, an: an, stile: 'intraday', ora: base,
                           orari: { aperto: true, chiude: base + 10 * 60000 } });
  prova('consiglio intraday: a dieci minuti dalla chiusura si esce', sera.verdetto === 'esci', sera.frase);
})();

/* ── le traduzioni condivise fra app e ponte ────────────────────────────── */
(function () {
  var d = { instrument: { epic: 'NVDA', type: 'SHARES', currency: 'USD', marginFactor: 20, marginFactorUnit: 'PERCENTAGE',
                          overnightFee: { longRate: -0.0178, shortRate: 0.0042 } },
            dealingRules: { minDealSize: { unit: 'POINTS', value: 1 }, minSizeIncrement: { unit: 'POINTS', value: 0.5 },
                            minNormalStopOrLimitDistance: { unit: 'PERCENTAGE', value: 0.1 } } };
  var st = M.strumentoDa(d, { SHARES: { current: 3, available: [1, 2, 3, 5] } });
  prova('strumento: leva dal conto, margine e regole da Capital.com', st.leva === 3 && st.fattoreMargine === 20 && st.dimMin === 1 &&
        st.passo === 0.5 && st.distMinStopPerc === 0.1 && st.valuta === 'USD', JSON.stringify(st));
  prova('strumento: senza leve del conto, leva vuota (il piano usa quella massima)', M.strumentoDa(d, null).leva === null);
  var nt = M.notteDa(d.instrument.overnightFee);
  prova('notti: tasso negativo = si paga, positivo = si incassa', vicino(nt.lungo, 0.000178) && vicino(nt.corto, -0.000042), JSON.stringify(nt));
  prova('notti: un tasso annuo si riporta a una notte', vicino(M.notteDa({ longRate: -6.4, shortRate: -1 }).lungo, 6.4 / 360 / 100));
  prova('pronto: un B si gioca da aggressivo, non da deciso', M.pronto({ ok: true, grado: 'B' }, 'aggressivo') && !M.pronto({ ok: true, grado: 'B' }, 'deciso'));
  prova('soglie dei profili', M.sogliaProfilo('deciso') === 55 && M.sogliaProfilo('aggressivo') === 40 && M.sogliaProfilo('spinto') === 28);
})();

/* ── il robot ───────────────────────────────────────────────────────────── */
(function () {
  var ora = Date.UTC(2026, 9, 7, 16, 0);
  var an = { ok: true, dir: 1, grado: 'B', punti: 45 };
  /* piano di base: R = 3 USD, cambio 0.8 (2.40 CHF per unita'), leva 5. Il
     tetto e' 50: un B rischia 50 x 0.2 x 0.75 = 7.50 CHF, cioe' 3.1 unita'. */
  function piano(x) {
    return Object.assign({ R: 3, entrata: 100, stop: 97, tp2: 110.5, tipo: 'mercato', dim: 3, passo: 0.1, dimMin: 0.1,
                           cambio: 0.8, leva: 5, rischioSoldi: 7.5, motivoTempo: 'adesso' }, x || {});
  }
  var stato = { aperte: 2, maxPosizioni: 10, tetto: 50, residuo: 50, rischioAperto: 10, disponibile: 59 };
  function e(x) { return M.robotEntrata(Object.assign({ an: an, piano: piano(), stato: stato, ora: ora, stile: 'swing' }, x || {})); }

  prova('robot: il rischio a colpo si ragiona sul tetto (A 20%, B 15%, C 10%)',
        M.rischioRobot(50, 'A') === 10 && M.rischioRobot(50, 'B') === 7.5 && M.rischioRobot(50, 'C') === 5);
  var ok = e();
  prova('robot: segnale pronto, a mercato, spazio e margine: apre', ok.apri && ok.dim === 3.1 && ok.stop === 97 && ok.tp === 110.5 && ok.rischio <= 7.5 + 1e-9, JSON.stringify(ok));
  prova('robot: il budget del Colpo non conta (la taglia viene dal tetto)', e({ piano: piano({ dim: 0.2, rischioSoldi: 0.5 }) }).dim === 3.1);
  prova('robot: senza segnale non apre', !e({ an: { ok: true, dir: 1, grado: '', punti: 12 } }).apri);
  prova('robot: prezzo scappato (limite) non apre: aspetta', !e({ piano: piano({ tipo: 'limite' }) }).apri);
  prova('robot: gia\' dentro su quel mercato non apre', !e({ giaDentro: true }).apri);
  prova('robot: posti pieni non apre', !e({ stato: Object.assign({}, stato, { aperte: 10 }) }).apri);
  prova('robot: chiusa da poco nella stessa direzione non riapre', !e({ chiusaDiRecente: { dir: 1, quando: ora - 3600000 } }).apri &&
        e({ chiusaDiRecente: { dir: -1, quando: ora - 3600000 } }).apri && e({ chiusaDiRecente: { dir: 1, quando: ora - 30 * 3600000 } }).apri);
  var orarioAperto = { aperto: true, chiude: ora + 3 * 3600000 };
  prova('robot: in rapido rientra dopo un quarto d\'ora (entra, incassa, rientra)',
        !e({ stile: 'rapido', orario: orarioAperto, chiusaDiRecente: { dir: 1, quando: ora - 10 * 60000 } }).apri &&
        e({ stile: 'rapido', orario: orarioAperto, chiusaDiRecente: { dir: 1, quando: ora - 16 * 60000 } }).apri);
  var stretto = e({ stato: Object.assign({}, stato, { residuo: 12, rischioAperto: 10 }) });
  prova('robot: il tetto di perdita taglia la taglia (restano 2 CHF: 0.8 unita\')', stretto.apri && stretto.dim === 0.8 && stretto.rischio <= 2 + 1e-9,
        JSON.stringify(stretto));
  prova('robot: tetto esaurito non apre', !e({ stato: Object.assign({}, stato, { residuo: 50, rischioAperto: 50 }) }).apri);
  var poco = e({ stato: Object.assign({}, stato, { disponibile: 20 }) });
  prova('robot: il margine disponibile taglia la taglia', poco.apri && poco.margine <= 20 * 0.9 + 1e-9 && poco.dim === 1.1, JSON.stringify(poco));
  prova('robot: senza margine non apre, e dice quanto serve', !e({ stato: Object.assign({}, stato, { disponibile: 1 }) }).apri &&
        /servono/.test(e({ stato: Object.assign({}, stato, { disponibile: 1 }) }).motivo));
  var piccolo = { aperte: 0, maxPosizioni: 10, tetto: 10, residuo: 10, rischioAperto: 0, disponibile: 59 };
  var minimo = e({ piano: piano({ dimMin: 1, passo: 1 }), stato: piccolo });
  prova('robot: taglia minima accettata se rischia fino a meta\' del tetto', minimo.apri && minimo.dim === 1 && Math.abs(minimo.rischio - 2.4) < 1e-9, JSON.stringify(minimo));
  var troppo = e({ piano: piano({ dimMin: 1, passo: 1 }), stato: Object.assign({}, piccolo, { tetto: 4, residuo: 4 }) });
  prova('robot: taglia minima rifiutata se rischia di piu\', e lo dice', !troppo.apri && /taglia minima/.test(troppo.motivo), troppo.motivo);
  prova('robot: intraday, a 30 minuti dalla chiusura non apre', !e({ stile: 'intraday', orario: { aperto: true, chiude: ora + 30 * 60000 } }).apri &&
        e({ stile: 'intraday', orario: orarioAperto }).apri);
  prova('robot: il motivo del "no" si legge', /serve almeno 28/.test(e({ an: { ok: true, dir: 1, grado: '', punti: 12 } }).motivo) &&
        /scappato/.test(e({ piano: piano({ tipo: 'limite' }) }).motivo));

  var pos = { dir: 1, stop: 97 };
  var c = function (x) { return Object.assign({ verdetto: 'tieni', frase: '', stopRegola: 97, faseStop: 'iniziale', R: 3, uscita: 101, barre: 2 }, x); };
  prova('robot: consiglio esci = chiude', M.robotUscita(c({ verdetto: 'esci', frase: 'girato' }), pos, 'swing').azione === 'chiudi');
  prova('robot: consiglio incassa = chiude', M.robotUscita(c({ verdetto: 'incassa' }), pos, 'swing').azione === 'chiudi');
  prova('robot: oltre il tempo massimo chiude', M.robotUscita(c({ barre: 21 }), pos, 'swing').azione === 'chiudi');
  var sp = M.robotUscita(c({ stopRegola: 100.15, faseStop: 'pareggio', uscita: 103.2 }), pos, 'swing');
  prova('robot: a +1R sposta lo stop a pareggio su Capital.com', sp.azione === 'stop' && sp.livello === 100.15, JSON.stringify(sp));
  prova('robot: uno spostamento piccolo non si fa (niente raffiche di modifiche)', M.robotUscita(c({ stopRegola: 97.3 }), pos, 'swing').azione === null);
  prova('robot: non mette lo stop oltre il prezzo', M.robotUscita(c({ stopRegola: 101.5, uscita: 101 }), pos, 'swing').azione === null);
  prova('robot: senza stop su Capital.com lo mette', M.robotUscita(c({ stopRegola: 97 }), { dir: 1, stop: null }, 'swing').azione === 'stop');

  /* il backtest del robot: una posizione sola, la passeggiata a caso resta a zero */
  var tutti = [];
  for (var sd = 1; sd <= 120; sd++) tutti = tutti.concat(M.backtest(passeggiata(900, 3000 + sd, 0.02, 0, 400), { soglia: 28, senzaCosti: true, unaSola: true }).colpi);
  var rr = M.riassumi(tutti);
  prova('backtest del robot (senza meta\'): passeggiata a caso compatibile con zero', Math.abs(rr.tStat) < 2.6 && rr.n > 200,
        'colpi ' + rr.n + ', R medio ' + rr.rMedio.toFixed(4) + ', t ' + rr.tStat.toFixed(2));
  /* una posizione sola: il risultato in R e' tutto nell'unica uscita, quindi
     (uscita - entrata) e R hanno lo stesso segno, colpo per colpo */
  var coerenti = tutti.every(function (k) { var m = (k.uscita - k.entrata) * k.dir; return k.r === 0 || m === 0 || (m > 0) === (k.r > 0); });
  prova('backtest del robot: ogni colpo ha un\'uscita sola', coerenti);
  /* lo stesso per il rapido: quarti d'ora, regole sue, fuori a sera */
  var rapidi = [];
  for (var sr = 1; sr <= 120; sr++) rapidi = rapidi.concat(M.backtest(passeggiata(900, 5000 + sr, 0.004, 0, 400, 900000), { soglia: 28, senzaCosti: true, unaSola: true, stile: 'rapido' }).colpi);
  var rq = M.riassumi(rapidi);
  prova('backtest del rapido: passeggiata a caso compatibile con zero', Math.abs(rq.tStat) < 2.6 && rq.n > 500,
        'colpi ' + rq.n + ', R medio ' + rq.rMedio.toFixed(4) + ', t ' + rq.tStat.toFixed(2));
  var Rr = M.regoleDi('rapido');
  prova('rapido: obiettivo corto, uscita in due ore', Rr.tp2 === 1.5 && Rr.stopAtr === 1.2 && Rr.slittamentoAtr === M.REGOLE.slittamentoAtr &&
        rapidi.every(function (k) { return k.barre <= M.STILI.rapido.maxBarre; }) && M.regoleDi('swing') === M.regoleDi(M.STILI.swing) && M.regoleDi('swing').tp2 === 3.5);
  var conSlip = M.riassumi(M.backtest(passeggiata(900, 77, 0.02, 0.0005), { soglia: 28 }).colpi);
  var senzaSlip = M.riassumi(M.backtest(passeggiata(900, 77, 0.02, 0.0005), { soglia: 28, senzaCosti: true }).colpi);
  prova('lo slittamento sugli stop costa, non regala', conSlip.rMedio < senzaSlip.rMedio, conSlip.rMedio.toFixed(4) + ' < ' + senzaSlip.rMedio.toFixed(4));
})();

/* ── orari di mercato ───────────────────────────────────────────────────── */
(function () {
  var usa = { mon: ['13:30 - 20:00'], tue: ['13:30 - 20:00'], wed: ['13:30 - 20:00'], thu: ['13:30 - 20:00'],
              fri: ['13:30 - 20:00'], sat: [], sun: [], zone: 'UTC' };
  var mar = M.orari(usa, Date.UTC(2026, 9, 6, 15, 0));
  prova('orari: martedi\' alle 15 UTC Wall Street e\' aperta', mar.aperto && mar.chiude === Date.UTC(2026, 9, 6, 20, 0));
  var sab = M.orari(usa, Date.UTC(2026, 9, 10, 12, 0));
  prova('orari: sabato riapre lunedi\' alle 13:30', !sab.aperto && sab.apre === Date.UTC(2026, 9, 12, 13, 30), new Date(sab.apre).toISOString());
  var notte = { mon: ['00:00 - 22:00', '23:05 - 00:00'], tue: ['00:00 - 22:00', '23:05 - 00:00'], wed: [], thu: [], fri: [], sat: [], sun: [], zone: 'UTC' };
  var o = M.orari(notte, Date.UTC(2026, 9, 5, 23, 30));
  prova('orari: le sessioni a cavallo della mezzanotte si uniscono', o.aperto && o.chiude === Date.UTC(2026, 9, 6, 22, 0), new Date(o.chiude).toISOString());
  var ny = { mon: ['09:30 - 16:00'], tue: ['09:30 - 16:00'], wed: [], thu: [], fri: [], sat: [], sun: [], zone: 'America/New_York' };
  var oNy = M.orari(ny, Date.UTC(2026, 9, 5, 14, 0));
  prova('orari: un fuso diverso da UTC viene convertito', oNy.aperto && oNy.chiude === Date.UTC(2026, 9, 5, 20, 0), oNy.chiude && new Date(oNy.chiude).toISOString());
})();

/* ── tutto il giro sui dati d'esempio ───────────────────────────────────── */
(function () {
  var ora = Date.UTC(2026, 9, 7, 16, 0);
  var rif = M.indicatori(M.candele(E.risposta('prices/US500', { resolution: 'DAY', max: 1000 }, ora)));
  var ok = 0, piani = 0;
  E.UNIVERSO.forEach(function (u) {
    var cs = M.candele(E.risposta('prices/' + u[0], { resolution: 'DAY', max: 1000 }, ora));
    var ct = M.candele(E.risposta('prices/' + u[0], { resolution: 'HOUR', max: 300 }, ora));
    var an = M.analizza(cs, ct, { rif: u[0] === 'US500' ? null : rif, percLunghi: 55 });
    if (an.ok && an.punti >= -100 && an.punti <= 100) ok++;
    var p = M.piano({ an: an, budget: 10000, profilo: 'aggressivo', strumento: { fattoreMargine: u[2] === 'SHARES' ? 20 : 5, dimMin: 0.1, passo: 0.1 } });
    if (p.dim >= 0 && isFinite(p.margine)) piani++;
  });
  prova('dati d\'esempio: tutti i mercati si analizzano', ok === E.UNIVERSO.length, ok + '/' + E.UNIVERSO.length);
  /* il riferimento leggero del ponte da' lo stesso punteggio di quello intero dell'app */
  var rifCs = M.candele(E.risposta('prices/US500', { resolution: 'MINUTE_15', max: 400 }, ora));
  var pieno = M.indicatori(rifCs), leggero = M.riferimentoLeggero(rifCs), uguali = 0;
  E.UNIVERSO.forEach(function (u) {
    if (u[0] === 'US500') { uguali++; return; }
    var cs = M.candele(E.risposta('prices/' + u[0], { resolution: 'MINUTE_15', max: 400 }, ora));
    var a = M.analizza(cs, null, { rif: pieno }), b = M.analizza(cs, null, { rif: leggero });
    if (a.ok && b.ok && a.punti === b.punti && JSON.stringify(a.parti) === JSON.stringify(b.parti)) uguali++;
  });
  prova('il riferimento leggero da\' lo stesso punteggio di quello intero', uguali === E.UNIVERSO.length, uguali + '/' + E.UNIVERSO.length);
  prova('dati d\'esempio: tutti i piani tornano numeri', piani === E.UNIVERSO.length);
  var orarie = M.candele(E.risposta('prices/NVDA', { resolution: 'HOUR', max: 300 }, ora));
  prova('dati d\'esempio: nessuna candela nel futuro', orarie[orarie.length - 1].t <= ora, new Date(orarie[orarie.length - 1].t).toISOString());
})();

/* ── esito ── */
var falliti = esiti.filter(function (e) { return !e[1]; });
esiti.forEach(function (e) { console.log((e[1] ? '  ok   ' : '  NO   ') + e[0] + (e[2] ? '  · ' + e[2] : '')); });
console.log('\n' + (esiti.length - falliti.length) + ' su ' + esiti.length + ' passati');
process.exit(falliti.length ? 1 : 0);
