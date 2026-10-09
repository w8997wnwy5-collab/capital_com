/*
  Cuce il Worker: motore.js + server/ponte.js = server/worker.js.

  Il ponte deve dare gli stessi consigli dell'app, quindi deve usare lo
  stesso motore — non una copia riscritta a mano che col tempo diverge. Ma
  il pannello di Cloudflare vuole UN file da incollare. Questo script li
  mette insieme; il test controlla che server/worker.js sia aggiornato.

      node tools/cuci_worker.js           riscrive server/worker.js
      node tools/cuci_worker.js --verifica  esce con errore se non e' aggiornato
*/
'use strict';
var fs = require('fs');
var path = require('path');

var radice = path.join(__dirname, '..');
function cuci() {
  var motore = fs.readFileSync(path.join(radice, 'motore.js'), 'utf8');
  var ponte = fs.readFileSync(path.join(radice, 'server', 'ponte.js'), 'utf8');
  return '/* ==========================================================================\n' +
         '   NON MODIFICARE QUESTO FILE: e\' cucito da tools/cuci_worker.js.\n' +
         '   Si cambiano motore.js e server/ponte.js, poi:  node tools/cuci_worker.js\n' +
         '   E\' il file da incollare nel pannello di Cloudflare (vedi COME-SI-ACCENDE.md).\n' +
         '   ========================================================================== */\n\n' +
         motore.trim() + '\n\nconst Motore = globalThis.Motore;\n\n' + ponte.trim() + '\n';
}
module.exports = cuci;

if (require.main === module) {
  var dest = path.join(radice, 'server', 'worker.js');
  var nuovo = cuci();
  if (process.argv.indexOf('--verifica') >= 0) {
    var attuale = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
    if (attuale !== nuovo) { console.error('server/worker.js non e\' aggiornato: lancia  node tools/cuci_worker.js'); process.exit(1); }
    console.log('server/worker.js e\' aggiornato');
  } else {
    fs.writeFileSync(dest, nuovo);
    console.log('scritto server/worker.js (' + Math.round(nuovo.length / 1024) + ' KB)');
  }
}
