/**
 * Push notification event handlers for Florrie's service worker.
 *
 * VitePWA generates the main service worker via Workbox.
 * This file is imported via importScripts in the Workbox config
 * to add push notification support.
 *
 * Notifications are styled as team updates from specific agents:
 *   💬 Front Desk — "Sarah booked a Cut & Colour for 3pm"
 *   🎨 Content Creator — "Drafted a new post for approval"
 *   🔮 Client Intel — "Sent a rebook nudge to Daisy"
 */

// Handle incoming push messages
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // Plain text fallback
    payload = {
      title: 'florrie.ai',
      body: event.data.text(),
      icon: '/favicon-192.png',
      badge: '/favicon-192.png',
      url: '/',
    };
  }

  const options = {
    body: payload.body || '',
    icon: payload.icon || '/favicon-192.png',
    badge: payload.badge || '/favicon-192.png',
    tag: payload.tag || 'florrie-default',
    data: {
      url: payload.url || '/',
      ...(payload.data || {}),
    },
    // Vibrate pattern: short-short (feels like a tap from a friend)
    vibrate: [100, 50, 100],
    // Show timestamp
    timestamp: Date.now(),
    // Renotify on same tag so updated notifications are visible
    renotify: true,
    // Keep notification until user interacts
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'florrie.ai', options)
  );
});

// Handle notification click — navigate to the relevant page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if one is open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});
