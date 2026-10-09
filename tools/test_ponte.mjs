/*
  Il ponte fa solo quello che deve?

  Si fa girare server/worker.js (quello vero, cucito) sotto node, con un
  Capital.com finto al posto di quello vero — lo stesso esempio.js dell'app —
  e un Telegram finto. Si controlla soprattutto quello che NON deve fare:
  passare percorsi non ammessi, rispondere senza codice, parlare con siti
  che non sono l'app, e mandare a Capital.com qualcosa che non sia una
  lettura.

      node tools/test_ponte.mjs
*/
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const E = require(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'esempio.js'));
const cuci = require(path.join(path.dirname(new URL(import.meta.url).pathname), 'cuci_worker.js'));
const Mot = require(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'motore.js'));

const esiti = [];
function prova(nome, ok, dettaglio) { esiti.push([nome, !!ok, dettaglio == null ? '' : String(dettaglio)]); }

const dest = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'worker.js');
prova('server/worker.js e\' cucito dall\'ultimo motore e dall\'ultimo ponte', fs.readFileSync(dest, 'utf8') === cuci(),
      'lancia  node tools/cuci_worker.js');

/* ── Capital.com e Telegram finti ── */
const chiamate = [];
let sessioniAperte = 0, rifiutaProssima = false, senzaConto = false;
const DEMO = 'https://demo-api-capital.backend-capital.com';
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const metodo = (init.method || 'GET').toUpperCase();
  chiamate.push({ url, metodo, headers: init.headers || {} });
  if (url.startsWith('https://api.telegram.org/')) {
    telegrammi.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (!url.startsWith(DEMO + '/api/v1/')) return new Response('no', { status: 599 });
  const u = new URL(url), percorso = u.pathname.replace('/api/v1/', '');
  if (percorso === 'session' && metodo === 'POST') {
    const b = JSON.parse(init.body);
    if (init.headers['X-CAP-API-KEY'] !== 'chiave-api' || b.identifier !== 'io@esempio.ch' || b.password !== 'pw') {
      return new Response(JSON.stringify({ errorCode: 'error.invalid.details' }), { status: 401 });
    }
    sessioniAperte++;
    return new Response('{}', { status: 200, headers: { CST: 'cst' + sessioniAperte, 'X-SECURITY-TOKEN': 'tok' + sessioniAperte } });
  }
  if (rifiutaProssima) { rifiutaProssima = false; return new Response(JSON.stringify({ errorCode: 'error.invalid.session.token' }), { status: 401 }); }
  if (senzaConto) return new Response(JSON.stringify({ errorCode: 'error.null.accountId' }), { status: 401 });
  if (!init.headers || !init.headers.CST || !init.headers['X-SECURITY-TOKEN']) return new Response('{}', { status: 401 });
  const q = Object.fromEntries(u.searchParams.entries());
  const b = await brokerFinto(percorso, metodo, init);
  if (b) return b;
  const r = E.risposta(percorso, q, Date.UTC(2026, 9, 7, 16, 0));
  if (r.errore) return new Response(JSON.stringify({ errorCode: r.errorCode }), { status: r.errore });
  return new Response(JSON.stringify(r), { status: 200 });
};
const telegrammi = [];

/* Il broker finto: accetta ordini, modifiche e chiusure come Capital.com
   (riferimento subito, esito su /confirms), e li mette nelle posizioni. Il
   conto scende col margine usato; il risultato aperto si comanda da qui. */
const ORA_DATI = Date.UTC(2026, 9, 7, 16, 0);
const broker = { pos: [], conferme: {}, n: 0, prezzi: {}, ordini: [], modifiche: [], chiusure: [], rifiutati: [], leveCambi: [], ora: ORA_DATI };
const contoFinto = { pnl: 0, disponibile: 59 };
const rispondi = (dati, stato = 200) => new Response(JSON.stringify(dati), { status: stato });
function mercatoFinto(epic) {
  const d = E.risposta('markets/' + epic, {}, ORA_DATI);
  const m = { epic, instrumentName: d.instrument.name, instrumentType: d.instrument.type, marketStatus: d.snapshot.marketStatus,
              bid: d.snapshot.bid, offer: d.snapshot.offer };
  if (broker.prezzi[epic]) Object.assign(m, broker.prezzi[epic]);
  return m;
}
async function brokerFinto(percorso, metodo, init) {
  if (percorso === 'positions' && metodo === 'POST') {
    if (broker.rifiuta) {
      const ref = 'r_' + (++broker.n);
      broker.rifiutati.push(JSON.parse(init.body));
      broker.conferme[ref] = { dealStatus: 'REJECTED', reason: 'RISK_CHECK' };
      return rispondi({ dealReference: ref });
    }
    const b = JSON.parse(init.body), m = mercatoFinto(b.epic), n = ++broker.n;
    const id = 'robot-' + n, ref = 'o_' + n, livello = b.direction === 'BUY' ? m.offer : m.bid;
    broker.ordini.push(b);
    broker.pos.push({ epic: b.epic, position: { dealId: id, direction: b.direction, size: b.size, level: livello, stopLevel: b.stopLevel,
      profitLevel: b.profitLevel, createdDateUTC: new Date(broker.ora).toISOString().slice(0, 19), currency: 'USD' } });
    broker.conferme[ref] = { dealStatus: 'ACCEPTED', dealId: 'x' + n, affectedDeals: [{ dealId: id, status: 'OPENED' }], level: livello, size: b.size };
    return rispondi({ dealReference: ref });
  }
  const mp = /^positions\/(.+)$/.exec(percorso);
  if (mp && (metodo === 'PUT' || metodo === 'DELETE')) {
    const id = decodeURIComponent(mp[1]), x = broker.pos.find(q => q.position.dealId === id), ref = 'p_' + (++broker.n);
    if (!x) return rispondi({ errorCode: 'error.not-found.dealId' }, 404);
    if (metodo === 'PUT') {
      const b = JSON.parse(init.body);
      if (b.stopLevel != null) x.position.stopLevel = b.stopLevel;
      if (b.profitLevel != null) x.position.profitLevel = b.profitLevel;
      broker.modifiche.push({ id, ...b });
      broker.conferme[ref] = { dealStatus: 'ACCEPTED', affectedDeals: [{ dealId: id, status: 'AMENDED' }] };
    } else {
      broker.pos = broker.pos.filter(q => q !== x);
      broker.chiusure.push(id);
      broker.conferme[ref] = { dealStatus: 'ACCEPTED', profit: -1.5, profitCurrency: 'USD', affectedDeals: [{ dealId: id, status: 'FULLY_CLOSED' }] };
    }
    return rispondi({ dealReference: ref });
  }
  const mc = /^confirms\/(.+)$/.exec(percorso);
  if (mc && broker.confermeRotte) return rispondi({ errorCode: 'error.service.unavailable' }, 500);
  if (mc) { const c = broker.conferme[decodeURIComponent(mc[1])]; return c ? rispondi(c) : rispondi({ errorCode: 'error.not-found.dealReference' }, 404); }
  if (percorso === 'accounts/preferences') {
    if (!broker.leve) broker.leve = E.risposta('accounts/preferences', {}, ORA_DATI);
    if (metodo === 'PUT') {
      const b = JSON.parse(init.body);
      for (const [t, v] of Object.entries(b.leverages || {})) broker.leve.leverages[t].current = v;
      broker.leveCambi.push(b);
      return rispondi({ status: 'SUCCESS' });
    }
    return rispondi(broker.leve);
  }
  if (percorso === 'positions' && metodo === 'GET' && broker.posizioniRotte) return rispondi({ errorCode: 'error.service.unavailable' }, 503);
  if (percorso === 'positions' && metodo === 'GET') {
    const base = E.risposta('positions', {}, ORA_DATI);
    base.positions = base.positions.concat(broker.pos.map(x => ({ position: x.position, market: mercatoFinto(x.epic) })));
    return rispondi(base);
  }
  if (percorso === 'accounts' && metodo === 'GET') {
    const a = E.risposta('accounts', {}, ORA_DATI), usato = broker.pos.reduce((t, x) => t + x.position.size * x.position.level * 0.8 / 5, 0);
    a.accounts[0].balance.profitLoss = contoFinto.pnl;
    a.accounts[0].balance.available = contoFinto.disponibile - usato;
    return rispondi(a);
  }
  return null;
}

/* KV finto */
function kv() {
  const m = new Map();
  return {
    m, scritture: 0,
    gancio: null,
    async get(k, tipo) {
      if (this.gancio && this.gancio(k)) this.gancio = null;
      const v = m.get(k); return v == null ? null : (tipo === 'json' ? JSON.parse(v) : v);
    },
    async put(k, v) { this.scritture++; m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

const { default: ponte } = await import(dest);
async function cron(ora) {
  const attese = [];
  await ponte.scheduled({ scheduledTime: ora }, ENV, { waitUntil(p) { attese.push(p); } });
  await Promise.all(attese);
}
const ENV = { CAPITAL_API_KEY: 'chiave-api', CAPITAL_LOGIN: 'io@esempio.ch', CAPITAL_PASSWORD: 'pw', CHIAVE: 'segreto-lungo',
              ORIGINI: 'https://w8997wnwy5-collab.github.io', MEMORIA: kv(), TELEGRAM_TOKEN: 't', TELEGRAM_CHAT: '42' };
const APP = 'https://w8997wnwy5-collab.github.io';
async function chiedi(percorso, opz = {}) {
  const h = { Origin: opz.origine || APP };
  if (opz.chiave !== null) h.Authorization = 'Bearer ' + (opz.chiave || 'segreto-lungo');
  if (opz.ip) h['CF-Connecting-IP'] = opz.ip;
  const req = new Request('https://mirino.esempio.workers.dev' + percorso, { method: opz.metodo || 'GET', headers: h, body: opz.corpo ? JSON.stringify(opz.corpo) : undefined });
  const r = await ponte.fetch(req, opz.env || ENV, { waitUntil() {} });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = await r.text(); }
  return { stato: r.status, d, h: r.headers };
}

/* ── le porte ── */
let r = await chiedi('/', { chiave: null });
prova('la radice dice che il ponte e\' acceso, senza codice', r.stato === 200 && /acceso/.test(r.d), r.d);
r = await chiedi('/api/stato', { chiave: null });
prova('senza codice: 401', r.stato === 401, r.stato);
r = await chiedi('/api/stato', { chiave: 'sbagliato' });
prova('codice sbagliato: 401', r.stato === 401, r.stato);
r = await chiedi('/api/stato');
prova('codice giusto: lo stato col conto', r.stato === 200 && r.d.ok && r.d.conto && r.d.conto.valuta === 'CHF' && r.d.demo === true, JSON.stringify(r.d));
prova('CORS: solo l\'origine dell\'app', r.h.get('access-control-allow-origin') === APP);
r = await chiedi('/api/stato', { origine: 'https://cattivo.example' });
prova('CORS: un altro sito non riceve il permesso', !r.h.get('access-control-allow-origin'));
const pre = await ponte.fetch(new Request('https://x.workers.dev/api/stato', { method: 'OPTIONS', headers: { Origin: 'https://cattivo.example' } }), ENV, {});
prova('CORS: la richiesta preliminare da un altro sito viene respinta', pre.status === 403, pre.status);

/* ── i percorsi ── */
r = await chiedi('/api/cap/positions');
prova('le posizioni passano', r.stato === 200 && Array.isArray(r.d.positions), r.stato);
r = await chiedi('/api/cap/session');
prova('un percorso non in lista viene respinto', r.stato === 403, JSON.stringify(r.d));
r = await chiedi('/api/cap/positions/abc');
prova('nemmeno le singole posizioni (servono solo per chiudere)', r.stato === 403, r.stato);
r = await chiedi('/api/cap/positions', { metodo: 'POST', corpo: { epic: 'NVDA', direction: 'BUY', size: 1 } });
prova('aprire una posizione non e\' possibile', r.stato === 404, r.stato);
r = await chiedi('/api/cap/positions', { metodo: 'DELETE' });
prova('chiuderne nemmeno', r.stato === 404, r.stato);
r = await chiedi('/api/cap/prices/NVDA?resolution=DAY&max=5&malizia=1');
const ultima = chiamate.filter(c => c.url.includes('/prices/NVDA')).pop();
prova('i parametri non ammessi non arrivano a Capital.com', ultima && !/malizia/.test(ultima.url) && /resolution=DAY/.test(ultima.url), ultima && ultima.url);
prova('le candele arrivano', r.stato === 200 && r.d.prices.length === 5, r.d.prices && r.d.prices.length);
const prima = chiamate.length;
await chiedi('/api/cap/prices/NVDA?resolution=DAY&max=5');
prova('le stesse candele due volte costano un giro solo', chiamate.length === prima, chiamate.length - prima);
r = await chiedi('/api/cap/prices/NONESISTE?resolution=DAY&max=5');
prova('un mercato che non esiste: errore detto in italiano', r.stato === 404 && /Mercato non trovato/.test(r.d.errore), r.d.errore);

/* ── la sessione ── */
prova('una sola sessione per tante richieste', sessioniAperte === 1, sessioniAperte);
rifiutaProssima = true;
r = await chiedi('/api/cap/accounts');
prova('sessione scaduta: se ne apre un\'altra e si riprova da soli', r.stato === 200 && sessioniAperte === 2, sessioniAperte);
const sbagliata = { ...ENV, CAPITAL_PASSWORD: 'no' };
/* la sessione buona e' ancora in memoria: si forza la scadenza */
rifiutaProssima = true;
r = await chiedi('/api/cap/accounts', { env: sbagliata });
prova('credenziali sbagliate: errore chiaro', r.stato === 401 && /PASSWORD DELLA CHIAVE/.test(r.d.errore), r.d.errore);
senzaConto = true;
r = await chiedi('/api/stato');
senzaConto = false;
prova('credenziali giuste ma nessun conto demo: lo dice, e dice come uscirne',
      r.stato === 200 && r.d.ok === false && /conto demo/.test(r.d.problema) && /CAPITAL_DEMO = 0/.test(r.d.problema), r.d.problema);
prova('a Capital.com arrivano solo letture (e l\'apertura della sessione)',
      chiamate.filter(c => c.url.startsWith(DEMO)).every(c => c.metodo === 'GET' || (c.metodo === 'POST' && c.url.endsWith('/session'))));

/* ── la sorveglianza ── */
telegrammi.length = 0;
await ponte.scheduled({}, ENV, { waitUntil(p) { this.p = p; } });
await new Promise(ok => setTimeout(ok, 50));
const kvm = ENV.MEMORIA.m;
prova('alla prima ronda il ponte fissa il rischio iniziale della posizione', kvm.has('segui:esempio-0001') &&
      JSON.parse(kvm.get('segui:esempio-0001')).stopIniziale > 0, kvm.get('segui:esempio-0001'));
const avviso = kvm.get('avviso:esempio-0001');
prova('e si segna il consiglio', !!avviso, avviso);
const v = avviso && JSON.parse(avviso).verdetto;
prova('se il consiglio va detto, arriva su Telegram (e solo allora)',
      v === 'tieni' ? telegrammi.length === 0 : telegrammi.length === 1, v + ' · messaggi ' + telegrammi.length + (telegrammi[0] ? ' · ' + telegrammi[0].text.split('\n')[0] : ''));
const scrittePrima = ENV.MEMORIA.scritture, mandatiPrima = telegrammi.length;
await ponte.scheduled({}, ENV, { waitUntil() {} });
await new Promise(ok => setTimeout(ok, 50));
prova('alla ronda dopo, stesso consiglio: nessun messaggio, nessuna scrittura',
      telegrammi.length === mandatiPrima && ENV.MEMORIA.scritture === scrittePrima, (telegrammi.length - mandatiPrima) + ' messaggi, ' + (ENV.MEMORIA.scritture - scrittePrima) + ' scritture');

/* posizione presa a mano, fuori da Capital.com */
r = await chiedi('/api/segui', { metodo: 'POST', corpo: { id: 'mano-1', manuale: true, epic: 'TSLA', nome: 'Tesla', dir: -1, entrata: 900, dim: 2, aperta: Date.UTC(2026, 9, 5), stile: 'swing', R: 20 } });
prova('una posizione presa a mano si fa sorvegliare', r.stato === 200 && JSON.parse(kvm.get('manuali')).length === 1, r.stato);
telegrammi.length = 0;
const p = ponte.scheduled({}, ENV, { waitUntil(x) { this.x = x; } });
await new Promise(ok => setTimeout(ok, 80));
const avvisoMano = kvm.get('avviso:mano-1');
prova('e il ponte la sorveglia come le altre', avvisoMano && telegrammi.some(t => / · Tesla corto<\/b>/.test(t.text)),
      avvisoMano + ' · ' + (telegrammi[0] ? telegrammi[0].text.split('\n')[0] : 'nessun messaggio'));
r = await chiedi('/api/segui/mano-1', { metodo: 'DELETE' });
prova('e smette quando glielo dici', r.stato === 200 && JSON.parse(kvm.get('manuali')).length === 0 && !kvm.has('segui:mano-1'));

r = await chiedi('/api/telegram/prova', { metodo: 'POST' });
prova('il messaggio di prova parte', r.stato === 200 && telegrammi.some(t => /Gli avvisi arrivano qui/.test(t.text)));

/* ── gli avvisi d'ingresso ── */
const FISSO = Date.UTC(2026, 9, 7, 16, 0);          /* l'ora dei dati finti: mercoledi', Wall Street aperta */
const AZIONI = E.UNIVERSO.filter(u => u[2] === 'SHARES').map(u => u[0]);
r = await chiedi('/api/impostazioni', { metodo: 'POST', corpo: { lista: AZIONI.concat(['DE40', 'non valido!']), profilo: 'aggressivo',
  stile: 'swing', budget: 5000, riferimento: 'US500', valuta: 'CHF', ingressi: true } });
prova('l\'app manda le impostazioni al ponte (e quelle strane si scartano)', r.stato === 200 && r.d.impostazioni.lista.length === AZIONI.length + 1 &&
      r.d.impostazioni.budget === 5000, JSON.stringify(r.d.impostazioni && r.d.impostazioni.lista.slice(-2)));
r = await chiedi('/api/impostazioni');
prova('e le rilegge', r.stato === 200 && r.d.impostazioni && r.d.impostazioni.profilo === 'aggressivo');

/* quello che direbbe l'app, rifatto qui col motore: stesse 400 candele,
   stesso riferimento, stessa folla, stessa leva e stesso cambio */
const Sw = Mot.STILI.swing;
const candeleFinte = (ep, res, n) => Mot.candele(E.risposta('prices/' + ep, { resolution: res, max: n }, FISSO));
const rifVivo = Mot.indicatori(candeleFinte('US500', 'DAY', Sw.candeleVive));
const folla = Object.fromEntries(E.risposta('clientsentiment', { marketIds: AZIONI.join(',') }, FISSO).clientSentiments.map(x => [x.marketId, x.longPositionPercentage]));
const leve = E.risposta('accounts/preferences', {}, FISSO).leverages;
const usdchf = (s => (s.bid + s.offer) / 2)(E.risposta('markets/USDCHF', {}, FISSO).snapshot);
const attesi = {};
for (const ep of AZIONI) {
  const d = E.risposta('markets/' + ep, {}, FISSO);
  if (d.snapshot.marketStatus !== 'TRADEABLE') continue;
  const an = Mot.analizza(candeleFinte(ep, 'DAY', Sw.candeleVive), candeleFinte(ep, 'HOUR', Sw.candeleTempo),
                          { rif: rifVivo, percLunghi: folla[ep], prezzo: { bid: d.snapshot.bid, ask: d.snapshot.offer } });
  if (!Mot.pronto(an, 'aggressivo') || ep === 'NVDA') continue;
  const strumento = Mot.strumentoDa(d, leve);
  attesi[ep] = Mot.piano({ an, budget: 5000, profilo: 'aggressivo', stile: 'swing', strumento,
                           cambio: strumento.valuta === 'CHF' ? 1 : usdchf, notte: Mot.notteDa(d.instrument.overnightFee) });
}
const n = AZIONI.length + 1, base = Math.floor(FISSO / 60000 / n) * n * 60000;
async function giro(da) {
  telegrammi.length = 0;
  for (let i = 0; i < n; i++) await cron(base + (da + i) * 60000);
  return telegrammi.filter(t => /^<b>ENTRA/.test(t.text));
}
let entra = await giro(0);
const avvisati = entra.map(t => (AZIONI.find(ep => t.text.includes('#colpo/' + ep)) || '?'));
prova('un giro della lista: avvisa esattamente i mercati pronti per il profilo', Object.keys(attesi).length > 0 &&
      avvisati.slice().sort().join() === Object.keys(attesi).sort().join(), 'attesi ' + Object.keys(attesi).join(',') + ' · avvisati ' + avvisati.join(','));
prova('non avvisa l\'ingresso dove sei gia\' dentro (NVDA)', !avvisati.includes('NVDA'));
prova('e non avvisa i mercati chiusi (DE40 alle 16 UTC)', !entra.some(t => t.text.includes('#colpo/DE40')));
const uno = avvisati[0], pu = attesi[uno], testo = entra[0] && entra[0].text;
prova('l\'ordine nel messaggio e\' quello dell\'app: stessa taglia, stesso stop', !!testo && testo.includes(' ' + Mot.fmtNum(pu.dim, pu.passo < 1 ? 2 : 0) + ' ') &&
      testo.includes('Stop ' + Mot.fmtPrezzo(pu.stop)), testo && testo.split('\n').slice(0, 3).join(' | '));
const scrittePrimaGiro = ENV.MEMORIA.scritture;
entra = await giro(n);
prova('il giro dopo, stessi segnali: nessun secondo avviso, nessuna scrittura', entra.length === 0 && ENV.MEMORIA.scritture === scrittePrimaGiro,
      entra.length + ' avvisi, ' + (ENV.MEMORIA.scritture - scrittePrimaGiro) + ' scritture');
for (const k of [...kvm.keys()]) if (k.startsWith('ingresso:')) kvm.delete(k);
await chiedi('/api/impostazioni', { metodo: 'POST', corpo: { lista: AZIONI, profilo: 'aggressivo', stile: 'swing', budget: 5000, valuta: 'CHF', ingressi: false } });
entra = await giro(2 * n);
prova('con "solo uscite" nessun avviso d\'ingresso', entra.length === 0, entra.length);
await chiedi('/api/impostazioni', { metodo: 'POST', corpo: { lista: AZIONI, profilo: 'aggressivo', stile: 'swing', budget: 1, valuta: 'CHF', ingressi: true } });
entra = await giro(3 * n);
prova('con un budget sotto la taglia minima nessun avviso', entra.length === 0, entra.length);

/* ── il robot ── */
const AZ = AZIONI, nAz = AZ.length;
const robotKV = () => JSON.parse(kvm.get('robot') || 'null');
const comandoKV = () => JSON.parse(kvm.get('robot:comando') || 'null');
/* un giro alla volta, aspettando che finisca (cron, sopra): come su
   Cloudflare, dove i giri partono a un minuto l'uno dall'altro */
async function giroRobot(inizio, minuti) {
  for (let i = 0; i < minuti; i++) { broker.ora = inizio + i * 60000; await cron(broker.ora); }
}
const ciclo = k => (Math.floor(ORA_DATI / 60000 / nAz) + k) * nAz * 60000;
/* un'ora precisa, Wall Street aperta (13:30-20:00 UTC, lunedi'-venerdi') */
const alle = (giorno, ore, minuti = 0) => Date.UTC(2026, 9, giorno, ore, minuti);
const nonGetPrimaRobot = chiamate.filter(c => c.url.startsWith(DEMO) && c.metodo !== 'GET' && !c.url.endsWith('/session')).length;
prova('prima di accendere il robot, nessuna scrittura verso Capital.com', nonGetPrimaRobot === 0, nonGetPrimaRobot);

telegrammi.length = 0;
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ, riferimento: 'US500' } });
prova('Avvia scrive il comando, non lo stato (lo stato lo scrive solo il giro)', r.stato === 200 && r.d.comando && r.d.comando.azione === 'avvia' && !kvm.has('robot') &&
      comandoKV().capitaleIniziale === 10000 && comandoKV().impostazioni.perditaMax === 50, JSON.stringify(r.d));
const hook = telegrammi.find(t => t.url && t.secret_token);
prova('il webhook di Telegram punta a un percorso segreto, con intestazione segreta', !!hook && hook.url.startsWith('https://mirino.esempio.workers.dev/tg/') &&
      hook.url.length > 60 && hook.secret_token.length >= 32, hook && hook.url);
r = await chiedi('/api/robot', {});
prova('senza giri (cron spento) l\'app vede il comando in attesa: e\' cosi\' che si scopre il cron mancante', r.stato === 200 && r.d.comando && r.d.comando.azione === 'avvia' &&
      !r.d.robot && r.d.ora > 0, JSON.stringify({ comando: r.d.comando, robot: r.d.robot }));
prova('ROBOT ACCESO non parte dall\'app: lo manda il primo giro', !telegrammi.some(t => /ROBOT ACCESO/.test(t.text || '')));

telegrammi.length = 0;
await giroRobot(ciclo(10), nAz);
let st = robotKV();
const ordini = broker.ordini.slice();
prova('il primo giro applica il comando: acceso, punto di partenza 10000, ROBOT ACCESO su Telegram', st && st.acceso && st.capitaleIniziale === 10000 && st.perditaMax === 50 &&
      telegrammi.some(t => /ROBOT ACCESO/.test(t.text || '') && /\/chiudi/.test(t.text) && /giro completo/.test(t.text)), JSON.stringify(st && { acceso: st.acceso, cap: st.capitaleIniziale }));
r = await chiedi('/api/robot', {});
prova('applicato il comando, l\'app non lo vede piu\' in attesa', !r.d.comando && r.d.robot.acceso);
prova('in un giro della lista il robot apre da solo', ordini.length >= 1 && st.aperte.length === broker.pos.length,
      ordini.map(o => o.epic + ' ' + o.direction + ' ' + o.size).join(', '));
prova('ogni ordine nasce con stop loss e take profit su Capital.com, dalla parte giusta', ordini.length > 0 && ordini.every(o => {
  const m = mercatoFinto(o.epic), px = o.direction === 'BUY' ? m.offer : m.bid;
  return o.stopLevel > 0 && o.profitLevel > 0 && (o.direction === 'BUY' ? o.stopLevel < px && o.profitLevel > px : o.stopLevel > px && o.profitLevel < px);
}));
prova('mai due posizioni sullo stesso mercato, mai su NVDA dove eri gia\' dentro', new Set(ordini.map(o => o.epic)).size === ordini.length && !ordini.some(o => o.epic === 'NVDA'));
const rischio = st.aperte.reduce((t, a) => t + Math.abs(a.entrata - a.stopIniziale) * a.dim * a.cambio, 0);
prova('il rischio di tutte le posizioni insieme sta sotto il tetto di 50', rischio <= 50 + 1e-6, rischio.toFixed(2));
prova('nessun colpo rischia piu\' di meta\' del tetto', st.aperte.every(a => Math.abs(a.entrata - a.stopIniziale) * a.dim * a.cambio <= 25 + 1e-6));
const margine = broker.pos.reduce((t, x) => t + x.position.size * x.position.level * 0.8 / 5, 0);
prova('e il margine sotto quello disponibile sul conto (59)', margine <= 59 + 1e-6, margine.toFixed(2));
prova('ogni apertura arriva su Telegram', telegrammi.filter(t => /^<b>APERTA/.test(t.text || '')).length === ordini.length);
prova('nel diario ci sono le aperture', st.diario.filter(d => d.tipo === 'aperta').length === ordini.length);
/* le occhiate vanno in KV al massimo ogni cinque minuti: un giro dopo, ci sono tutte */
await giroRobot(ciclo(10) + (nAz + 6) * 60000, 1);
st = robotKV();
prova('il battito dice quando ha girato l\'ultima volta', st.battito && st.battito.quando >= ciclo(10) && st.battito.disponibile != null, JSON.stringify(st.battito));

prova('per ogni mercato della lista si legge l\'ultima occhiata e il perche\' (la risposta a "perche\' non apre?")', robotKV() &&
      AZ.every(ep => st.visti[ep] && typeof st.visti[ep].motivo === 'string' && st.visti[ep].motivo.length > 3),
      AZ.map(ep => ep + ': ' + (st.visti[ep] ? st.visti[ep].motivo : '—')).join(' | '));
await giroRobot(ciclo(11), nAz);
prova('il giro dopo non raddoppia niente', broker.ordini.length === ordini.length, broker.ordini.length - ordini.length);

/* +1.2R su una posizione: lo stop va a pareggio su Capital.com */
st = robotKV();
const a0 = st.aperte[0], R0 = a0.R, sp = (a0.entrata * 0.0008);
const px0 = a0.entrata + a0.dir * 1.2 * R0;
broker.prezzi[a0.epic] = a0.dir > 0 ? { bid: px0, offer: px0 + sp } : { offer: px0, bid: px0 - sp };
telegrammi.length = 0;
await giroRobot(ciclo(12), 3);
const mod = broker.modifiche.find(m => m.id === a0.id);
prova('a +1.2R il robot porta lo stop a pareggio su Capital.com', !!mod && Math.abs(mod.stopLevel - (a0.entrata + a0.dir * 0.05 * R0)) < R0 * 0.02 && mod.profitLevel === a0.tp,
      mod ? 'stop ' + mod.stopLevel + ' (entrata ' + a0.entrata + ')' : 'nessuna modifica');
prova('e lo scrive su Telegram', telegrammi.some(t => /STOP SPOSTATO/.test(t.text || '')));
const modifichePrima = broker.modifiche.length;
await giroRobot(ciclo(12) + 3 * 60000, 2);
prova('lo stop non si risposta a ogni giro', broker.modifiche.length === modifichePrima, broker.modifiche.length - modifichePrima);

/* Capital.com chiude una posizione (stop o take profit) */
broker.pos = broker.pos.filter(x => x.position.dealId !== a0.id);
delete broker.prezzi[a0.epic];
telegrammi.length = 0;
await giroRobot(ciclo(13), 1);
st = robotKV();
prova('il robot si accorge della chiusura fatta da Capital.com, e dice se e\' stop o take profit', !st.aperte.some(a => a.id === a0.id) &&
      telegrammi.some(t => /l'ha chiusa Capital\.com: (stop|take profit) a /i.test(t.text || '')) && st.colpi.n === 1,
      telegrammi.map(t => t.text.split('\n').slice(0, 2).join(' | ')).join(' || '));

/* il tetto: perdita dall'avvio oltre 50 */
contoFinto.pnl = -55;
telegrammi.length = 0;
await giroRobot(ciclo(14), 1);
st = robotKV();
prova('al tetto di perdita il robot si ferma e chiude tutto', !st.acceso && st.motivo === 'tetto' && st.aperte.length === 0 && broker.pos.length === 0 && !st.chiudiTutto,
      JSON.stringify({ acceso: st.acceso, aperte: st.aperte.length, broker: broker.pos.length }));
prova('e lo scrive su Telegram', telegrammi.some(t => /ROBOT FERMATO · tetto/.test(t.text || '')));
const ordiniDopoTetto = broker.ordini.length;
await giroRobot(ciclo(15), nAz);
prova('fermo dal tetto non apre piu\' niente', broker.ordini.length === ordiniDopoTetto);

/* riacceso (nuovo punto di partenza), poi "ferma e chiudi" dall'app */
contoFinto.pnl = 0;
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
await giroRobot(ciclo(100), nAz);
const aperteRiavvio = broker.pos.length;
r = await chiedi('/api/robot', {});
prova('lo stato del robot per l\'app: acceso, conto, posizioni con prezzo', r.stato === 200 && r.d.robot.acceso && r.d.conto && r.d.robot.aperte.every(a => a.presente) &&
      r.d.risultato === 0 && r.d.robot.colpi.n === 0, JSON.stringify({ aperte: r.d.robot.aperte.length, risultato: r.d.risultato }));
r = await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
prova('"ferma e chiudi" dall\'app chiude subito tutte le sue posizioni', aperteRiavvio > 0 && r.stato === 200 && broker.pos.length === 0 &&
      r.d.esiti.length === aperteRiavvio && r.d.esiti.every(e => e.ok), aperteRiavvio + ' aperte, ' + broker.pos.length + ' rimaste');
r = await chiedi('/api/robot', {});
prova('e fino al giro dopo l\'app vede il Ferma in arrivo', r.d.comando && r.d.comando.azione === 'ferma' && r.d.comando.chiudi);
await giroRobot(ciclo(101), 2);
st = robotKV();
prova('il giro dopo applica il Ferma: spento, niente da chiudere, nessun ordine nuovo', !st.acceso && st.aperte.length === 0 && !st.chiudiTutto &&
      broker.pos.length === 0, JSON.stringify({ acceso: st.acceso, aperte: st.aperte.length, chiudi: st.chiudiTutto }));

/* LA CORSA. Un Ferma che arriva mentre un giro sta lavorando: prima il giro
   riscriveva lo stato con "acceso" e il Ferma si perdeva. */
{ const q = robotKV(); q.chiuse = {}; kvm.set('robot', JSON.stringify(q)); }
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
await giroRobot(ciclo(200), 1);
prova('(riacceso)', robotKV().acceso === true);
/* il Ferma arriva DURANTE il giro: quando il giro legge lo stato del conto */
let fermaMandato = false;
const vecchioFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!fermaMandato && String(url).includes('/api/v1/accounts') && !String(url).includes('preferences')) {
    fermaMandato = true;
    globalThis.fetch = vecchioFetch;
    await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: false } });
  }
  return vecchioFetch(url, init);
};
const ordiniCorsa = broker.ordini.length;
await giroRobot(ciclo(200) + 60000, 1);
globalThis.fetch = vecchioFetch;
prova('un Ferma arrivato durante un giro non viene cancellato da quel giro', fermaMandato && comandoKV().azione === 'ferma');
await giroRobot(ciclo(200) + 2 * 60000, nAz);
prova('e il giro dopo lo applica: spento, e da li\' nessun ordine', robotKV().acceso === false && broker.ordini.length <= ordiniCorsa + 1,
      'ordini durante la corsa: ' + (broker.ordini.length - ordiniCorsa));
/* il Ferma arriva un attimo prima di un ordine: il robot lo vede e non ordina */
contoFinto.pnl = 0;
for (const x of broker.pos.slice()) await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(12, 13, 45), 1);
{ const q = robotKV(); q.chiuse = {}; kvm.set('robot', JSON.stringify(q)); }
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
await giroRobot(alle(12, 14), 1);
let gancioScattato = false;
ENV.MEMORIA.gancio = k => {
  if (k !== 'robot:comando' || !new Error().stack.includes('entrataRobot')) return false;
  kvm.set('robot:comando', JSON.stringify({ id: 'ferma-lampo', quando: Date.now(), azione: 'ferma', chiudi: false, chi: 'dall\'app' }));
  gancioScattato = true;
  return true;
};
const ordiniLampo = broker.ordini.length;
await giroRobot(alle(12, 14, 1), nAz);
ENV.MEMORIA.gancio = null;
prova('un Ferma arrivato un attimo prima dell\'ordine: l\'ordine non parte', gancioScattato && broker.ordini.length === ordiniLampo && robotKV().acceso === false,
      'ordini dopo il Ferma: ' + (broker.ordini.length - ordiniLampo));

/* Un ordine partito, ma la conferma non arriva (la rete): lo stato era gia'
   salvato prima dell'ordine, e il giro dopo adotta la posizione. */
for (const x of broker.pos.slice()) await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(12, 15), 1);
{ const q = robotKV(); q.chiuse = {}; q.diario = []; kvm.set('robot', JSON.stringify(q)); }
/* due posti: uno e' gia' preso dalla tua NVDA (contano tutte le posizioni del conto) */
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 2, stile: 'swing', lista: AZ } });
broker.confermeRotte = true;
const ordiniRotti = broker.ordini.length;
for (let i = 0; i < nAz && broker.ordini.length === ordiniRotti; i++) { broker.ora = alle(12, 16) + i * 60000; await cron(broker.ora); }
broker.confermeRotte = false;
st = robotKV();
prova('ordine senza conferma: resta "in attesa", salvato', broker.ordini.length === ordiniRotti + 1 && st.inAttesa.length === 1 && st.aperte.length === 0,
      JSON.stringify({ ordini: broker.ordini.length - ordiniRotti, attesa: st.inAttesa.length }));
await cron(broker.ora + 60000);
st = robotKV();
prova('e al giro dopo la posizione e\' sua (adottata), senza un secondo ordine', st.inAttesa.length === 0 && st.aperte.length === 1 && broker.ordini.length === ordiniRotti + 1 &&
      st.diario.some(d => /confermato in ritardo/.test(d.testo)), JSON.stringify({ attesa: st.inAttesa.length, aperte: st.aperte.length }));

/* Capital.com rifiuta: l'errore si scrive una volta, non a ogni giro */
for (const x of broker.pos.slice()) await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(13, 13, 45), 1);
{ const q = robotKV(); q.chiuse = {}; q.diario = []; kvm.set('robot', JSON.stringify(q)); }
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
broker.rifiuta = true;
await giroRobot(alle(13, 14), nAz);
const rifiutatiPrimo = broker.rifiutati.length;
await giroRobot(alle(13, 14, 20), nAz);
broker.rifiuta = false;
st = robotKV();
const errori = st.diario.filter(d => d.tipo === 'errore');
prova('ordine rifiutato: niente in attesa, e ogni errore si scrive una volta sola', rifiutatiPrimo > 0 && st.inAttesa.length === 0 &&
      errori.length === rifiutatiPrimo && new Set(errori.map(d => d.testo)).size === errori.length && errori.every(d => /RISK_CHECK/.test(d.testo)),
      rifiutatiPrimo + ' rifiutati, ' + errori.length + ' errori nel diario');
prova('e quel mercato si lascia stare mezz\'ora: niente raffiche di ordini rifiutati', broker.rifiutati.length === rifiutatiPrimo,
      (broker.rifiutati.length - rifiutatiPrimo) + ' rifiuti in piu\'');
prova('e il motivo si vede anche fra i mercati guardati', Object.values(st.visti).some(v => /RISK_CHECK/.test(v.motivo)));

/* le scritture in KV: con niente da fare, una ogni cinque minuti al massimo */
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(13, 16), 1);
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { budget: 100, perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: ['DE40', 'IT40', 'UK100'] } });
await giroRobot(alle(13, 17), 1);
const scrittureQuiete = ENV.MEMORIA.scritture;
await giroRobot(alle(13, 17, 1), 4);
prova('mercati chiusi, niente da fare: in quattro minuti nessuna scrittura', ENV.MEMORIA.scritture === scrittureQuiete, ENV.MEMORIA.scritture - scrittureQuiete);
await giroRobot(alle(13, 17, 6), 1);
prova('dopo cinque minuti una, per il battito', ENV.MEMORIA.scritture === scrittureQuiete + 1 && robotKV().visti.DE40.motivo === 'mercato chiuso', ENV.MEMORIA.scritture - scrittureQuiete);
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: false } });
await giroRobot(alle(13, 18), 1);

/* il rapido: quarti d'ora, due mercati al minuto, obiettivo a 1.5R */
contoFinto.pnl = 0;
{ const q = robotKV(); q.chiuse = {}; q.diario = []; kvm.set('robot', JSON.stringify(q)); }
telegrammi.length = 0;
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { perditaMax: 50, maxPosizioni: 10, stile: 'rapido', lista: AZ } });
const ordiniRapido = broker.ordini.length;
await giroRobot(alle(14, 14), 1);
st = robotKV();
prova('rapido: guarda due mercati al minuto', st.stile === 'rapido' && Object.keys(st.visti).length === 2 && telegrammi.some(t => /Rapido/.test(t.text || '') && /2 al minuto/.test(t.text)),
      Object.keys(st.visti).join(','));
await giroRobot(alle(14, 14, 1), Math.ceil(nAz / 2));
st = robotKV();
const nuovi = broker.ordini.slice(ordiniRapido);
prova('rapido: apre, con il take profit a 1.5 volte la distanza dello stop', nuovi.length > 0 && nuovi.every(o => {
  const a = st.aperte.find(x => x.epic === o.epic);
  if (!a) return true;
  return Math.abs(Math.abs(o.profitLevel - a.entrata) / Math.abs(a.entrata - o.stopLevel) - 1.5) < 0.05;
}), nuovi.map(o => o.epic + ' stop ' + o.stopLevel + ' tp ' + o.profitLevel).join(', '));
prova('rapido: tutti i mercati della lista guardati in mezzo giro', AZ.every(ep => st.visti[ep]));

/* i comandi da Telegram */
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(15, 13, 45), 1);
{ const q = robotKV(); q.chiuse = {}; kvm.set('robot', JSON.stringify(q)); }
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
await giroRobot(alle(15, 14), nAz);
const percorsoTg = new URL(hook.url).pathname;
async function tg(percorso, testo, chat, intestazione) {
  const h = { 'content-type': 'application/json' };
  if (intestazione !== null) h['X-Telegram-Bot-Api-Secret-Token'] = intestazione || hook.secret_token;
  const res = await ponte.fetch(new Request('https://mirino.esempio.workers.dev' + percorso, { method: 'POST', headers: h,
    body: JSON.stringify({ message: { chat: { id: chat || 42 }, text: testo } }) }), ENV, { waitUntil() {} });
  return res.status;
}
prova('Telegram: percorso sbagliato = 404', await tg('/tg/indovino', '/stop') === 404);
prova('Telegram: senza intestazione segreta = 403', await tg(percorsoTg, '/stop', 42, null) === 403);
telegrammi.length = 0;
const comandoPrima = comandoKV().id;
await tg(percorsoTg, '/stop', 999);
prova('Telegram: da un\'altra chat non obbedisce', comandoKV().id === comandoPrima && telegrammi.length === 0);
await tg(percorsoTg, '/stato');
prova('Telegram: /stato risponde, con l\'ultimo giro e l\'occhiata ai mercati', telegrammi.some(t => /ROBOT ACCESO/.test(t.text || '') && /Ultimo giro/.test(t.text) && /Ultima occhiata/.test(t.text)),
      telegrammi.length + ' messaggi');
const primaStop = broker.pos.length;
await tg(percorsoTg, '/stop');
await giroRobot(alle(15, 14, 30), 1);
prova('Telegram: /stop ferma gli ingressi ma non chiude le posizioni', robotKV().acceso === false && broker.pos.length === primaStop && primaStop > 0,
      primaStop + ' posizioni');
await tg(percorsoTg, '/chiudi');
prova('Telegram: /chiudi chiude subito tutto', broker.pos.length === 0 && telegrammi.some(t => /POSIZIONI CHIUSE/.test(t.text || '')));
await giroRobot(alle(15, 14, 31), 1);
prova('e il giro dopo trova tutto chiuso', robotKV().aperte.length === 0 && !robotKV().chiudiTutto);

/* Capital.com non risponde durante il giro: il Ferma vale lo stesso, e
   l'errore arriva nell'app e su Telegram invece di un silenzio */
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ } });
await giroRobot(alle(16, 14), 1);
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: false } });
broker.posizioniRotte = true;
telegrammi.length = 0;
await giroRobot(alle(16, 14, 1), 1);
broker.posizioniRotte = false;
st = robotKV();
prova('Capital.com giu\' durante il giro: il Ferma si applica lo stesso', st.acceso === false && !comandoKV() || (st.acceso === false && st.comandoVisto === comandoKV().id),
      JSON.stringify({ acceso: st.acceso }));
prova('e l\'errore si vede: nello stato (per l\'app) e su Telegram', st.battito && /503/.test(st.battito.errore || '') && telegrammi.some(t => /il giro non parte/.test(t.text || '')),
      JSON.stringify(st.battito));
r = await chiedi('/api/sorveglia', { metodo: 'POST' });
prova('il giro a mano dall\'app risponde e dice com\'e\' andato', r.stato === 200 && r.d && (r.d.robot || r.d.saltato || r.d.posizioni != null), JSON.stringify(r.d).slice(0, 120));
r = await chiedi('/api/robot', {});
prova('passato l\'errore, il giro dopo lo toglie dal battito', r.d.robot.battito && !r.d.robot.battito.errore, JSON.stringify(r.d.robot.battito));

/* la leva al massimo: la chiedi all'avvio, il robot la mette una volta */
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(16, 15), 1);
broker.leve.leverages.SHARES.current = 2;
broker.leve.leverages.INDICES.current = 5;
telegrammi.length = 0;
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ, levaMassima: true } });
await giroRobot(alle(16, 15, 1), 2);
const cambio = broker.leveCambi[broker.leveCambi.length - 1];
prova('leva massima: il robot la mette su Capital.com, una volta sola', broker.leveCambi.length === 1 && cambio.leverages.SHARES === 5 && cambio.leverages.INDICES === 20 &&
      broker.leve.leverages.SHARES.current === 5, JSON.stringify(broker.leveCambi));
prova('e lo dice nel diario e su Telegram', robotKV().diario.some(d => /Leva al massimo: .*SHARES 2:1 → 5:1/.test(d.testo)) && telegrammi.some(t => /LEVA AL MASSIMO/.test(t.text || '')));
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(16, 16), 1);
broker.leve.leverages.SHARES.current = 2;
r = await chiedi('/api/robot/avvia', { metodo: 'POST', corpo: { perditaMax: 50, maxPosizioni: 10, stile: 'swing', lista: AZ, levaMassima: false } });
await giroRobot(alle(16, 16, 1), 1);
prova('senza la richiesta, la leva non si tocca', broker.leveCambi.length === 1 && broker.leve.leverages.SHARES.current === 2);
broker.leve.leverages.SHARES.current = 5;
await chiedi('/api/robot/ferma', { metodo: 'POST', corpo: { chiudi: true } });
await giroRobot(alle(16, 17), 1);

/* niente ordini scelti da fuori */
r = await chiedi('/api/cap/positions', { metodo: 'POST', corpo: { epic: 'TSLA', direction: 'BUY', size: 100 } });
prova('dall\'app non passa nessun ordine scelto da fuori', r.stato === 404 && !broker.ordini.some(o => o.size === 100));
const scritture = chiamate.filter(c => c.url.startsWith(DEMO) && c.metodo !== 'GET');
prova('le uniche scritture verso Capital.com: sessione, apri, sposta stop, chiudi, leva', scritture.every(c =>
  (c.metodo === 'POST' && /\/session$|\/positions$/.test(c.url)) || ((c.metodo === 'PUT' || c.metodo === 'DELETE') && /\/positions\/[^/]+$/.test(c.url)) ||
  (c.metodo === 'PUT' && /\/accounts\/preferences$/.test(c.url))),
  [...new Set(scritture.map(c => c.metodo + ' ' + c.url.replace(DEMO, '').replace(/robot-\d+/, ':id')))].join(', '));

/* ── il freno sui codici ── */
for (let i = 0; i < 12; i++) await chiedi('/api/stato', { chiave: 'x' + i, ip: '9.9.9.9' });
r = await chiedi('/api/stato', { ip: '9.9.9.9' });
prova('dopo dodici codici sbagliati, anche quello giusto aspetta un\'ora', r.stato === 429, r.stato);
r = await chiedi('/api/stato', { ip: '8.8.8.8' });
prova('ma solo per quell\'indirizzo', r.stato === 200, r.stato);

/* ── esito ── */
const falliti = esiti.filter(e => !e[1]);
esiti.forEach(e => console.log((e[1] ? '  ok   ' : '  NO   ') + e[0] + (e[2] ? '  · ' + e[2] : '')));
console.log('\n' + (esiti.length - falliti.length) + ' su ' + esiti.length + ' passati');
process.exit(falliti.length ? 1 : 0);
