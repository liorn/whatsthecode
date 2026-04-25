// No-op service worker: exists only to satisfy Chrome's installability
// criteria so beforeinstallprompt fires. It does not cache anything —
// every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Pass-through: no respondWith() means the browser handles the request normally.
});
