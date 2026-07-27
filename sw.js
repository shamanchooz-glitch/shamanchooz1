const CACHE_NAME = "proche-v5";
const CORE_ASSETS = ["./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// STRATEGIE RESEAU/CACHE (pour permettre un fonctionnement minimal hors-ligne) :
// - Coquille de l'app (HTML/JS) : reseau d'abord, cache en secours — pour que
//   les mises a jour arrivent vite, tout en pouvant charger l'app hors-ligne.
// - Lectures Firebase (GET) et tuiles de carte : reseau d'abord, mais on
//   garde une copie en cache pour pouvoir reafficher les dernieres donnees
//   et zones de carte deja vues, meme sans connexion.
// - Ecritures Firebase (PUT/PATCH/DELETE) : jamais mises en cache, elles
//   doivent echouer clairement si hors-ligne (l'app le signale a la personne).
self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  const isFirebaseData = url.includes("firebaseio.com");
  const isMapTile = url.includes("openstreetmap.org") || url.includes("arcgisonline.com") || url.includes("opentopomap.org");
  const isGoogleApi = url.includes("googleapis.com");

  if (isGoogleApi) return; // toujours en direct (auth, cartes Google...)

  if (isFirebaseData && e.request.method !== "GET") return; // ecritures : jamais de cache

  if (isFirebaseData || isMapTile) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
