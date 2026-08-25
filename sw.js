/* Modo sin internet — guarda la app para que abra aunque no haya señal */
const CACHE = "via-publica-v1";
const BASE = ["/", "/index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Librerías y tipografías: primero lo guardado (son siempre iguales y pesan)
const ESTABLES = ["esm.sh", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "unpkg.com"];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Nunca guardar en caché las llamadas al servidor ni a la base
  if (url.pathname.startsWith("/api/") || url.hostname.endsWith("supabase.co")) return;

  if (ESTABLES.some((h) => url.hostname.includes(h))) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // La app: intentar internet y, si no hay, servir lo guardado
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("index.html")) {
    e.respondWith(
      fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put("/index.html", copia)).catch(() => {});
        return res;
      }).catch(() => caches.match("/index.html").then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // Fotos de los carteles y demás: lo guardado si existe, si no internet
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === "basic") {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});
