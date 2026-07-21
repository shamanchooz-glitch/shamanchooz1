const CACHE_NAME = "proche-v4";
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

// IMPORTANT : reseau d'abord pour la coquille de l'app (HTML/JS), pour que
// chaque correction publiee arrive immediatement chez les utilisateurs deja
// installes. Le cache ne sert que de secours hors-ligne. Les donnees
// Firebase et les tuiles de carte restent toujours en direct.
self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  if (url.includes("firebaseio.com") || url.includes("openstreetmap.org") || url.includes("arcgisonline.com") || url.includes("opentopomap.org") || url.includes("googleapis.com")) return;
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
