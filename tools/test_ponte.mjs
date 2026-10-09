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
  const r = E.risposta(percorso, q, Date.UTC(2026, 9, 7, 16, 0));
  if (r.errore) return new Response(JSON.stringify({ errorCode: r.errorCode }), { status: r.errore });
  return new Response(JSON.stringify(r), { status: 200 });
};
const telegrammi = [];

/* KV finto */
function kv() {
  const m = new Map();
  return {
    m, scritture: 0,
    async get(k, tipo) { const v = m.get(k); return v == null ? null : (tipo === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { this.scritture++; m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

const { default: ponte } = await import(dest);
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
  for (let i = 0; i < n; i++) await ponte.scheduled({ scheduledTime: base + (da + i) * 60000 }, ENV, { waitUntil() {} });
  await new Promise(ok => setTimeout(ok, 50));
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
