/* Rete prima, cache come riserva. La pagina e gli script vengono chiesti alla
   rete SALTANDO la cache del browser: GitHub Pages dice ai browser di tenersi
   index.html per dieci minuti, e senza questo si finisce a guardare la versione
   di ieri chiedendosi perche' non e' cambiato niente.

   Le domande al ponte non passano di qui: sono di un altro dominio, e un
   prezzo di dieci minuti fa in cache sarebbe peggio di nessun prezzo. */
var CACHE = 'mirino-v3';
var ASSETS = ['./', './index.html', './motore.js', './esempio.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); })
    .then(function(){ return self.skipWaiting(); }).catch(function(){}));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k !== CACHE; })
      .map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  if(new URL(e.request.url).origin !== self.location.origin) return;
  var richiesta = new Request(e.request, { cache: 'reload' });
  e.respondWith(
    fetch(richiesta).then(function(resp){
      var copia = resp.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copia); }).catch(function(){});
      return resp;
    }).catch(function(){
      return caches.match(e.request).then(function(hit){ return hit || caches.match('./index.html'); });
    })
  );
});
/* toccare una notifica riapre l'app sulle posizioni */
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function(lista){
    for (var i = 0; i < lista.length; i++) { if ('focus' in lista[i]) return lista[i].focus(); }
    return self.clients.openWindow('./#gioco');
  }));
});
