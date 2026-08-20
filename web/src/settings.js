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
    // Autocorrect, autocapitalisation and spellcheck, as one switch, because a phone keyboard does
    // all three or none. Off by default: this composer types into an agent's prompt, where a flag
    // is not a typo, a path is not a sentence, and a capital letter the keyboard added to the front
    // of one is a different path. It was on once, and what that cost was every command typed on a
    // phone being quietly rewritten. Prose to an agent is the case for turning it back on, and
    // that is what the setting is for.
    const AUTOCORRECT_KEY = 'herdr_autocorrect';

    function autocorrectOn() {
      try { return localStorage.getItem(AUTOCORRECT_KEY) === 'on'; } catch (e) { return false; }
    }

    // One field, whatever the answer is for it. A shell's composer never gets it whatever the
    // setting says — see syncComposerMode.
    function applyAutocorrect(input, on) {
      if (!input) return;
      input.setAttribute('autocorrect', on ? 'on' : 'off');
      input.setAttribute('autocapitalize', on ? 'sentences' : 'none');
      input.spellcheck = !!on;
    }

    function setAutocorrect(on) {
      try { localStorage.setItem(AUTOCORRECT_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: session-only */ }
      const box = document.getElementById('autocorrectOn');
      if (box) box.checked = !!on;
      // Both composers, because both write to an agent and a setting that only reached one of them
      // would be a setting nobody could trust.
      syncComposerMode();
      applyAutocorrect(document.getElementById('convInput'), on);
    }

    function setUserHighlight(on) { setHighlight(USER_HIGHLIGHT_KEY, 'userHighlight', on); }
    function setSummaryHighlight(on) { setHighlight(SUMMARY_HIGHLIGHT_KEY, 'summaryHighlight', on); }
    document.getElementById('userHighlight').checked = highlightOn(USER_HIGHLIGHT_KEY);
    document.getElementById('summaryHighlight').checked = highlightOn(SUMMARY_HIGHLIGHT_KEY);

    // What is running, and where each part of the answer comes from. The page knows its own build
    // because the build stamped it into a meta tag; the relay and the herdr binary under it are
    // only knowable from the relay, which sends both when a client connects. Two separately
    // deployed halves, and a mismatch between them is the explanation for a whole class of "the
    // app does not do that" — so it is said out loud rather than left to be worked out.
    const appVersion = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
    const appBuilt = (document.querySelector('meta[name="app-built"]') || {}).content || '';
    let relayVersions = {};

    function setRelayVersions(msg) {
      relayVersions = msg || {};
      renderVersions();
    }

    function renderVersions() {
      const app = document.getElementById('verApp');
      if (!app) return;
      // "dev" is what the page is when it was served from the working copy rather than built:
      // there is no version to name, and naming the last release would be a lie about what is
      // on screen.
      app.textContent = appVersion + (appBuilt ? ` · ${appBuilt}` : '');
      // Em dash, not "unknown": nothing has been asked yet. A relay too old to answer leaves it
      // at that too, which is itself the answer — that relay predates this message.
      document.getElementById('verRelay').textContent = relayVersions.relay || '—';
      document.getElementById('verHerdr').textContent = relayVersions.herdr || '—';
      const hint = document.getElementById('versionHint');
      if (!hint) return;
      const mismatch = !!relayVersions.relay && appVersion !== 'dev' &&
        appVersion !== relayVersions.relay;
      if (!relayVersions.relay) {
        hint.textContent = 'Relay and herdr versions arrive when the relay connects.';
      } else if (appVersion === 'dev') {
        hint.textContent = 'This page is being served unbuilt from the working copy, so it has no ' +
          'version of its own. Run make build to stamp one.';
      } else if (mismatch) {
        hint.textContent = `This page is ${appVersion} and the relay is ${relayVersions.relay}. ` +
          'Rebuild and redeploy the app, or restart the relay, so the two match.';
      } else {
        hint.textContent = 'The app is built from the same version the relay reports.';
      }
      // The one case worth a colour: everything else here is a statement of fact, and this is the
      // one that explains a bug the reader is probably already looking at.
      hint.style.color = mismatch ? 'var(--orange)' : '';
    }

    renderVersions();
