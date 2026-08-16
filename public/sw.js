// Deliberately does no caching. It exists so the browser treats sketchdex as
// installable, which is what frees ⌘K from the address bar.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
