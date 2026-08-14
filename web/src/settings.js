    // Settings — auto-detect relay when served from same origin
    const autoRelayUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const isSelfRelay = !location.hostname.includes('pages.dev') && !location.hostname.includes('github.io');
    // A temp tunnel mints a new hostname on every restart, so the relay address is handed over as
    // a link rather than retyped on a phone. Scheme-checked: this writes the address the app will
    // connect to, so anything that is not a WebSocket URL is ignored.
    const q = new URLSearchParams(location.search);
    // A push carries its pane in the URL. Keep it until the relay snapshot proves that the pane
    // exists; opening immediately would race the initial websocket connection.
    let notificationPane = q.get('pane') || '';
    const urlRelay = q.get('relay');
    if (urlRelay && /^wss?:\/\/[^\s]+$/i.test(urlRelay)) localStorage.setItem('herdr_relay_url', urlRelay);
    const urlToken = q.get('token');
    if (urlToken) localStorage.setItem('herdr_relay_token', urlToken);
    // Both are credentials in a URL: they persist in the address bar, in history, and in any
    // screenshot of the phone. Stored, then stripped — everything downstream reads localStorage.
    if (urlRelay || urlToken) {
      q.delete('relay');
      q.delete('token');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
    const savedUrl = localStorage.getItem('herdr_relay_url') || (isSelfRelay ? autoRelayUrl : '');
    const savedToken = localStorage.getItem('herdr_relay_token') || '';
    document.getElementById('relayUrl').value = savedUrl;
    document.getElementById('relayToken').value = savedToken;

    // Theme. The head script already applied it before paint; this only keeps the control honest.
    const THEME_KEY = 'herdr_theme';

    function setTheme(name) {
      const light = name === 'light';
      if (light) document.documentElement.dataset.theme = 'light';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (e) { /* private mode: session-only */ }
      document.getElementById('themePick').value = light ? 'light' : 'dark';
      // The installed PWA paints its chrome from this, so it has to track the choice.
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = light ? '#e6e8ee' : '#1a1b26';
    }

    setTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');

    // Both defaults preserve the existing prompt treatment and make a detected summary useful the
    // first time a pane opens. The parser still runs when a colour is off; only row classes stop.
    const USER_HIGHLIGHT_KEY = 'herdr_highlight_user', SUMMARY_HIGHLIGHT_KEY = 'herdr_highlight_summary';
    function highlightOn(key) {
      try { return localStorage.getItem(key) !== 'off'; } catch (e) { return true; }
    }
    function repaintHighlights() {
      // The band is drawn against row geometry, so it is re-placed whether or not there are rows
      // to rebuild — a pane with no text still has a ruler to clear.
      if (paneRows.length) { renderPaneRows(); invalidateRows(); }
      drawSel();
    }
    function setHighlight(key, id, on) {
      try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (e) { /* session-only */ }
      document.getElementById(id).checked = on;
      repaintHighlights();
    }
    function setUserHighlight(on) { setHighlight(USER_HIGHLIGHT_KEY, 'userHighlight', on); }
    function setSummaryHighlight(on) { setHighlight(SUMMARY_HIGHLIGHT_KEY, 'summaryHighlight', on); }
    document.getElementById('userHighlight').checked = highlightOn(USER_HIGHLIGHT_KEY);
    document.getElementById('summaryHighlight').checked = highlightOn(SUMMARY_HIGHLIGHT_KEY);
