    // --- Web Push ---
    let pushSubscription = null;

    // Why push can't work here, or '' if it can. Every one of these is a dead end the browser
    // reports as a bare failure — an iOS home screen that was added from Chrome, or a page opened
    // over http on the LAN, both surface as "subscribe failed" with nothing to act on.
    function pushBlocker() {
      if (!window.isSecureContext) return 'Push needs https — open the app over the tunnel or Pages URL.';
      // iOS defines navigator.standalone and sets it false in a Safari tab. There, push is
      // delivered only to a web app on the Home Screen, so a tab is not an error, it is a step.
      if (navigator.standalone === false) return 'Add to Home Screen first (Safari ▸ Share ▸ Add to Home Screen), then enable push from there.';
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        return 'Push is not supported in this browser.';
      }
      return '';
    }

    async function initPush() {
      const blocked = pushBlocker();
      if (blocked) {
        document.getElementById('pushStatus').textContent = blocked;
        document.getElementById('pushToggle').style.display = 'none';
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).pathname);
        pushSubscription = await reg.pushManager.getSubscription();
        updatePushUI();
      } catch (e) {
        document.getElementById('pushStatus').textContent = 'Service worker error: ' + e.message;
      }
    }

    function updatePushUI() {
      const btn = document.getElementById('pushToggle');
      const status = document.getElementById('pushStatus');
      if (pushSubscription) {
        btn.textContent = 'Disable Push';
        btn.style.background = 'var(--red)';
        status.innerHTML = '<span style="color:var(--green)">● Enabled</span>';
      } else if (window.Notification && Notification.permission === 'denied') {
        // The prompt is one-shot per install: once denied, subscribe() fails forever and the only
        // way back is the OS. Saying so beats a button that silently does nothing.
        btn.style.display = 'none';
        status.innerHTML = '<span style="color:var(--red)">● Blocked</span> — allow notifications for this app in iOS Settings ▸ Notifications.';
      } else {
        btn.style.display = '';
        btn.textContent = 'Enable Push';
        btn.style.background = 'var(--green)';
        status.innerHTML = '<span style="color:var(--muted)">○ Disabled</span>';
      }
    }

    // Tell the relay about this device's subscription. Returns whether it went out — the caller
    // decides what to say about a socket that was not up. Idempotent by design: the relay keeps a
    // set, so re-announcing on every connect is what heals a subscription made while offline, and
    // repopulates a relay that lost its push_subs.json.
    function announceSubscription() {
      if (!pushSubscription || !ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify({ type: 'push_subscribe', subscription: pushSubscription.toJSON() }));
      return true;
    }

    async function togglePush() {
      if (pushSubscription) {
        // Unsubscribe
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'push_unsubscribe', subscription: pushSubscription.toJSON() }));
        }
        await pushSubscription.unsubscribe();
        pushSubscription = null;
        updatePushUI();
      } else {
        // Subscribe
        try {
          // Chrome prompts for permission from inside subscribe(); Safari does not, and returns a
          // bare NotAllowedError instead. This call is what makes iOS ask at all — and it has to
          // stay on the click path, because Safari only honours it during a user gesture.
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            updatePushUI();
            if (permission !== 'denied') {
              document.getElementById('pushStatus').textContent = 'Notifications were not allowed.';
            }
            return;
          }
          const relayUrl = localStorage.getItem('herdr_relay_url') || '';
          const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://');
          // The token gates the relay's whole HTTP surface, not only the socket upgrade, so this
          // has to carry it exactly as the WebSocket URL does. Without it the tunnel listener
          // answers 401 and push can never be enabled from a hosted copy of this app.
          const pushToken = localStorage.getItem('herdr_relay_token');
          const keyUrl = httpUrl + '/api/vapid-public-key' +
            (pushToken ? '?token=' + encodeURIComponent(pushToken) : '');
          const resp = await fetch(keyUrl);
          if (!resp.ok) {
            document.getElementById('pushStatus').textContent =
              resp.status === 401 ? 'Relay rejected the token' : `Relay returned ${resp.status}`;
            return;
          }
          const { publicKey } = await resp.json();
          if (!publicKey) {
            document.getElementById('pushStatus').textContent = 'VAPID key not configured on relay';
            return;
          }
          const reg = await navigator.serviceWorker.ready;
          pushSubscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
          });
          // Subscribing in the browser is only half of it — the relay cannot push to a device it
          // has never been told about. This used to be attempted once and dropped silently if the
          // socket happened to be down, which left the button reading "Enabled" for a device the
          // relay had no record of, and no notification would ever arrive.
          updatePushUI();
          if (!announceSubscription()) {
            document.getElementById('pushStatus').innerHTML =
              '<span style="color:var(--orange)">● Pending</span> — allowed on this device, telling the relay when it reconnects.';
          }
        } catch (e) {
          document.getElementById('pushStatus').textContent = 'Error: ' + e.message;
        }
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }
