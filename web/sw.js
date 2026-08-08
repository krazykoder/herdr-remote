// herdr-remote service worker — Web Push notifications
const APP_SCOPE = self.registration.scope;
const logoUrl = new URL('logo.svg', APP_SCOPE).href;
const appUrl = (url = '') => new URL(url.replace(/^\//, ''), APP_SCOPE).href;

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = { title: '🐑 herdr', body: 'Agent needs attention', url: APP_SCOPE };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {}
  data.url = appUrl(data.url);
  // Clear notification (sent when agent unblocks)
  if (data.type === 'clear') {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag || 'herdr-blocked' }).then((notes) => {
        notes.forEach((n) => n.close());
      })
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: logoUrl,
      badge: logoUrl,
      tag: 'herdr-blocked',
      renotify: true,
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || APP_SCOPE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'navigate', url });
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
