    // --- Bottom status bar ---
    // One field: how long ago the open pane last changed. What the pane is *doing* used to sit at
    // the other end with an Esc chip beside it, and both are on the thread now — a bar has one of
    // everything and can only speak for the open pane, while a conversation has as many panes
    // working at once as it has members. See syncConvBadge.
    //
    // Left: how long ago the open pane last changed. Stamping every poll would read "now" forever
    // and mean nothing, so the stamp is taken only when the text differs — and, for the same
    // reason, the first paint after opening a pane does not count. That paint always "differs"
    // (the element was empty), which is what used to make this field read the current time on
    // every switch and say nothing at all.
    //
    // Relative, not a clock time: the question this answers is "is what I am looking at stale",
    // and "4m ago" answers it without the reader doing arithmetic. Past a day it falls back to
    // the date, where the arithmetic stops being worth it.
    let paneStampAt = null;
    // False until the pane's first content arrives. Per-pane, reset by openPane.
    let paneTextPrimed = false;

    function fmtStamp(d) {
      const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${t} · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    }

    function fmtAgo(d) {
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return fmtStamp(d);
    }

    // The words herdr itself reports, which the landing page already groups by. Anything outside
    // this set — 'unknown', or no status at all — falls through to recency rather than inventing a
    // label for it. The old code collapsed all five into active/idle, which is why a finished agent
    // read the same as one that had never started.
    const AGENT_WORDS = ['blocked', 'working', 'done', 'idle'];

    // What the bottom right says about the open pane, and whether that reads as good news.
    // Returns [word, tone] where tone is '' | 'on' | 'alert'.
    function paneStatusWord() {
      const agent = activePane ? agents.find(x => x.pane_id === activePane) : null;
      if (agent && AGENT_WORDS.includes(agent.status)) {
        return [agent.status, agent.status === 'blocked' ? 'alert'
          : agent.status === 'working' ? 'on' : ''];
      }
      // A shell has no status to report, so the only evidence is whether its text has moved
      // lately. Blank when there is none: this device has never seen the pane change, which is
      // not the same as knowing it is quiet.
      if (!paneStampAt) return ['', ''];
      return Date.now() - paneStampAt.getTime() < LIVE_MS ? ['live', 'on'] : ['idle', ''];
    }

    // The dot beside the open pane's name in the terminal header. Same rules as the tab strip's,
    // because it is the same pane — a header saying one thing while its own tab says another is
    // worse than either alone.
    function paintPaneDot() {
      const el = document.getElementById('paneDot');
      const pane = activePane ? paneOf(activePane) : null;
      el.style.background = !pane ? 'var(--muted)'
        : isShell(activePane) ? shellColor(activePane) : statusColor(pane);
      el.classList.toggle('pulse', !!pane && pane.status === 'working');
      el.title = pane ? paneStatusWord()[0] : '';
    }

    function renderStatusBar() {
      const pane = activePane ? paneOf(activePane) : null;
      paintPaneDot();
      // The arrows sit in this row and their reach depends on which panes are still alive, which is
      // a fact the snapshot changes without anybody navigating.
      syncNavBtns();
      document.getElementById('statusBarLeft').textContent =
        pane && paneStampAt ? `changed ${fmtAgo(paneStampAt)}` : '';
    }

    // Both halves go stale on their own — the left label by the minute, a shell's live/idle at the
    // 5-minute mark — so they are repainted on a timer rather than from every path that could have
    // carried the clock past a boundary. 15s is finer than the smallest step either can take.
    setInterval(() => { if (activePane && paneStampAt) renderStatusBar(); }, 15000);

    // With the scrollbar hidden, nothing else says there are more tabs off-screen.
    function syncTabFades() {
      const el = document.getElementById('agentTabs');
      const max = el.scrollWidth - el.clientWidth;
      el.classList.toggle('fade-left', el.scrollLeft > 1);
      el.classList.toggle('fade-right', el.scrollLeft < max - 1);
    }

    {
      const el = document.getElementById('agentTabs');
      el.addEventListener('scroll', syncTabFades, { passive: true });
      // Fit width is solved against the viewport, so a rotation has to re-solve it.
      addEventListener('resize', () => { syncTabFades(); applyWrapMode(); });
      // A mouse has no horizontal fling and there is no scrollbar to drag, so vertical wheel over
      // the strip moves it sideways. Without this, tabs past the edge are unreachable on desktop.
      el.addEventListener('wheel', e => {
        const max = el.scrollWidth - el.clientWidth;
        if (max <= 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        // behavior:'auto' overrides the CSS `scroll-behavior: smooth`, which would otherwise
        // animate every wheel notch and make the strip feel like it is lagging the hand.
        el.scrollBy({ left: e.deltaY, behavior: 'auto' });
      }, { passive: false });
    }

    // A jump is a destination, so the panel the user was in is left behind rather than closed back
    // into — openTerminal pushes the pane onto the walk, and the panel stays where it was on it.
    function jumpToPane(paneId) {
      hidePanels();
      openTerminal(paneId);
    }

    function toggleSettings() {
      if (document.getElementById('settingsView').style.display === 'block') { closePanel(); return; }
      openPanel('settingsView');
      document.getElementById('settingsStatus').innerHTML = ws && ws.readyState === 1
        ? `<span style="color:var(--green)">● Connected</span> · ${agents.length} agents`
        : `<span style="color:var(--red)">● Disconnected</span>`;
    }

    function toggleTimeline() {
      // Against being on screen, not against a display mode: PANELS decides that, and this view is
      // a flex column since it grew a scrolling log with the data panel pinned under it.
      if (document.getElementById('timelineView').style.display !== 'none') { closePanel(); return; }
      openPanel('timelineView');
      renderTimeline();
    }

    function renderTimeline() {
      const el = document.getElementById('timelineList');
      if (!timeline.length) {
        el.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px">No activity yet. Status changes appear here.</p>';
      } else {
        el.innerHTML = timeline.map(e => {
          const t = e.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const color = e.status === 'blocked' ? 'var(--red)' : e.status === 'working' ? 'var(--green)' : 'var(--muted)';
          return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--muted)">${t}</span><span style="flex:1">${e.project} (${e.agent})</span><span style="color:${color}">${e.status}</span></div>`;
        }).join('');
      }
      renderBandwidth();
      renderConvAnalytics();
    }

    function formatBandwidth(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function renderBandwidth() {
      const panel = document.getElementById('bandwidth');
      const rows = document.getElementById('bandwidthRows');
      if (!panel || !rows) return;
      panel.hidden = !bandwidthOn();
      if (panel.hidden) return;
      // Called from every snapshot, update and approval so the numbers keep up with the socket —
      // which means most calls arrive with Activity off screen, where drawing is work nobody sees
      // and an innerHTML rebuild of rows a reader is not looking at.
      const view = document.getElementById('timelineView');
      if (view && view.style.display === 'none') return;
      const buckets = bandwidthBuckets();
      const size = bandwidthBucketMs();
      const liveAt = bandwidthLiveAt();
      const title = document.getElementById('bandwidthTitle');
      if (title) {
        title.textContent = `Data exchange · ${bandwidthStepMin()} min buckets · ` +
          `latest ${bandwidthCount()}`;
      }
      const total = document.getElementById('bandwidthTotal');
      if (total) {
        // The same scale the chips under it use. Fixed MB read "0.00 MB" for an hour of a quiet
        // relay, which is a panel reporting that it is not measuring anything.
        total.textContent = `Total: ${formatBandwidth(
          buckets.reduce((n, b) => n + b.sent + b.received, 0))}`;
        total.title = `Every interval drawn below, added up`;
        // Green is what this panel uses for "still moving". A sum that includes an interval still
        // being filled is; one over a stack that stopped an hour ago is not.
        total.classList.toggle('now', !!liveAt);
      }
      const kinds = [
        ['total', 'Total', b => b.sent + b.received],
        ['sent', 'Sent', b => b.sent],
        ['received', 'Received', b => b.received],
      ];
      const metric = bandwidthMetric();
      const paneKind = kinds.find(([key]) => key === metric) || kinds[0];
      const panesOn = bandwidthPanesOn();
      document.querySelectorAll('[data-bandwidth-metric]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.bandwidthMetric === metric)));
      const paneToggle = document.getElementById('bandwidthPanes');
      if (paneToggle) paneToggle.setAttribute('aria-pressed', String(panesOn));
      // The rows are built when the *window* moves — once a bucket — and never for a number
      // changing. The chips overflow a phone, so they scroll, and this is redrawn on every message
      // that lands, which with the poll is three times a minute. An innerHTML rebuild there would
      // send a reader who had scrolled back to an earlier bucket to the left edge again, three
      // times a minute. Same rule the dock's chip row follows.
      // By name, because a reader looking for one pane's row scans for its name and the snapshot's
      // own order is whatever herdr listed. Shared stays under them all: it is what the named rows
      // did not account for, which only reads as that when it comes last.
      const panes = panesOn
        ? agents.filter(a => a.agent)
          .sort((x, y) => String(paneLabel(x)).localeCompare(String(paneLabel(y)),
            undefined, {sensitivity: 'base', numeric: true}))
        : [];
      // What the pane rows cannot account for: snapshots and pushes name no pane, and a pane that
      // has exited keeps its bytes but loses its row. Without this the split silently fails to add
      // up to the total above it, which reads as one of the two numbers being wrong.
      const other = panes.length
        ? `<div class="bandwidth-row" id="otherBandwidthRow">` +
          `<span class="bandwidth-label">Shared</span>` +
          `<div class="bandwidth-chips">${buckets.map(b => {
            const range = b.empty ? 'No data' : '';
            return `<span class="bandwidth-chip${b.at && b.at === liveAt ? ' now' : ''}" ` +
              `title="${paneKind[1]}, not attributable to one pane${range ? ` — ${range}` : ''}">` +
              `</span>`;
          }).join('')}</div></div>`
        : '';
      const sig = buckets.map(b => b.at || 'empty').concat(liveAt ? 'live' : [], metric,
        panes.map(a => a.pane_id)).join(',');
      if (rows.dataset.sig !== sig) {
        // One grid for the header and all three rows, so the columns line up and the whole table
        // scrolls as one — three scrollers of their own would let a reader compare Sent at 3:05
        // against Received at 2:40 and never see that they had.
        // The name column takes exactly what the longest name and its badge need — a pane called
        // "Architect 1 [claude]" is not worth abbreviating, and the buckets are the half that can
        // afford to scroll under it.
        rows.style.gridTemplateColumns = `max-content repeat(${buckets.length}, minmax(46px, 1fr))`;
        const at = b => {
          if (b.empty) return {range: 'No data', live: false, clock: '—'};
          const start = new Date(b.at), end = new Date(b.at + size);
          const day = start.toDateString() === new Date().toDateString() ? '' :
            start.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' ';
          const range = day + `${start.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}–` +
            end.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
          // Live is the interval still being filled, which only the collector knows: a record starts
          // at the message that opened it, not on a clock boundary, so its time cannot be compared
          // against one. The stack survives a reload and can hold days, so a column outside today
          // says which day — HH:MM alone would read as this morning.
          return {range: range, live: b.at === liveAt,
            clock: day + `${String(start.getHours()).padStart(2, '0')}:` +
              `${String(start.getMinutes()).padStart(2, '0')}`};
        };
        rows.innerHTML =
          `<div class="bandwidth-head"><span class="bandwidth-label"></span>` +
          buckets.map(b => { const t = at(b);
            return `<span class="bandwidth-time${t.live ? ' now' : ''}" title="${t.range}">` +
              `${t.live ? 'now' : t.clock}</span>`; }).join('') + `</div>` +
          kinds.map(([, label]) =>
            `<div class="bandwidth-row"><span class="bandwidth-label">${label}</span>` +
            `<div class="bandwidth-chips">${buckets.map(b => { const t = at(b);
              return `<span class="bandwidth-chip${t.live ? ' now' : ''}" ` +
                `title="${label}, ${t.range}${t.live ? ' (in progress)' : ''}"></span>`;
            }).join('')}</div></div>`).join('') +
          panes.map(a => `<div class="bandwidth-row pane-bandwidth-row" data-pane="${escapeHtml(a.pane_id)}">` +
            `<span class="bandwidth-label pane-bandwidth-name"><span class="dot"></span>` +
            `${escapeHtml(paneLabel(a))}${agentBadge(a.agent)}<small class="pane-bandwidth-ping"></small></span>` +
            `<div class="bandwidth-chips">${buckets.map(b => { const t = at(b);
              return `<span class="bandwidth-chip${t.live ? ' now' : ''}" ` +
                `title="${paneKind[1]}, ${t.range}${t.live ? ' (in progress)' : ''}"></span>`;
            }).join('')}</div></div>`).join('') + other;
        rows.dataset.sig = sig;
      }
      // The numbers, written into the chips that are already there.
      const bars = rows.querySelectorAll('.bandwidth-row');
      kinds.forEach(([, , value], r) => {
        const chips = bars[r].querySelectorAll('.bandwidth-chip');
        buckets.forEach((b, i) => { chips[i].textContent = b.empty ? '' : formatBandwidth(value(b)); });
      });
      // Filled as the pane rows are read, so what is left over is exactly what they did not claim.
      const claimed = buckets.map(() => 0);
      panes.forEach((a, i) => {
        const row = bars[i + kinds.length];
        const b = paneBandwidth[a.pane_id];
        const dot = row.querySelector('.dot');
        dot.style.background = statusColor(a);
        dot.classList.toggle('pulse', a.status === 'working');
        row.querySelector('.pane-bandwidth-ping').textContent = b && b.ping ? ` · ${fmtAgo(new Date(b.ping))}` : '';
        const byAt = Object.fromEntries((b ? b.buckets : []).map(entry => [entry.at, entry]));
        const chips = row.querySelectorAll('.bandwidth-chip');
        buckets.forEach((bucket, j) => { const entry = byAt[bucket.at];
          if (entry) claimed[j] += paneKind[2](entry);
          chips[j].textContent = entry ? formatBandwidth(paneKind[2](entry)) : ''; });
      });
      const otherRow = panes.length ? bars[kinds.length + panes.length] : null;
      if (otherRow) {
        const chips = otherRow.querySelectorAll('.bandwidth-chip');
        // Clamped: a pane row is written from its own record and the total from another, and a
        // number below zero would be the panel reporting a rounding difference as traffic.
        buckets.forEach((b, j) => { chips[j].textContent = b.empty ? '' :
          formatBandwidth(Math.max(0, paneKind[2](b) - claimed[j])); });
      }
    }

    // --- Conversation storage analytics ---
    let convAnalyticsSort = { col: 'size', dir: 'desc' };
    let convAnalyticsData = [];

    async function fetchConvAnalytics() {
      const convs = typeof loadConvIndex === 'function' ? loadConvIndex() : [];
      if (!convs.length) return [];
      const recordsMap = new Map();
      if (typeof openConvDB === 'function') {
        const db = await openConvDB();
        if (db) {
          try {
            const read = db.transaction(CONV_DB_STORE, 'readonly').objectStore(CONV_DB_STORE);
            const all = await idbReq(read.getAll());
            for (const r of all) if (r && r.key) recordsMap.set(r.key, r);
          } catch (e) { /* use fallbacks */ }
        }
      }
      if (typeof convFallbackAll === 'function') {
        const fallback = convFallbackAll();
        for (const [k, r] of Object.entries(fallback)) {
          if (!recordsMap.has(k) && r) recordsMap.set(k, r);
        }
      }
      if (typeof convHeld !== 'undefined' && convHeld instanceof Map) {
        for (const [k, r] of convHeld.entries()) {
          if (r) recordsMap.set(k, r);
        }
      }
      return typeof calcConvAnalytics === 'function' ? calcConvAnalytics(convs, recordsMap) : [];
    }

    async function renderConvAnalytics() {
      const section = document.getElementById('convAnalytics');
      const tableWrap = document.getElementById('convAnalyticsWrap');
      if (!section || !tableWrap) return;

      const view = document.getElementById('timelineView');
      if (view && view.style.display === 'none') return;

      convAnalyticsData = await fetchConvAnalytics();
      drawConvAnalyticsTable();
    }

    function sortConvAnalytics(col) {
      if (convAnalyticsSort.col === col) {
        convAnalyticsSort.dir = convAnalyticsSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        convAnalyticsSort.col = col;
        convAnalyticsSort.dir = (col === 'name' ? 'asc' : 'desc');
      }
      drawConvAnalyticsTable();
    }

    function drawConvAnalyticsTable() {
      const tableWrap = document.getElementById('convAnalyticsWrap');
      const totalEl = document.getElementById('convAnalyticsTotal');
      if (!tableWrap) return;

      const totalBytes = convAnalyticsData.reduce((acc, c) => acc + (c.totalBytes || 0), 0);
      if (totalEl) {
        const n = convAnalyticsData.length;
        totalEl.textContent = `Total: ${n} ${n === 1 ? 'conversation' : 'conversations'} · ` +
          formatConvSize(totalBytes);
        totalEl.title = `${totalBytes.toLocaleString()} bytes on this device`;
      }

      if (!convAnalyticsData.length) {
        tableWrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px;font-size:0.75rem;">No conversations stored yet</div>';
        return;
      }

      const sorted = typeof sortConvAnalyticsRows === 'function'
        ? sortConvAnalyticsRows(convAnalyticsData, convAnalyticsSort.col, convAnalyticsSort.dir)
        : convAnalyticsData.slice();

      const arrow = col => convAnalyticsSort.col === col ? `<span class="sort-arrow">${convAnalyticsSort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
      const ariaSort = col => convAnalyticsSort.col === col ? (convAnalyticsSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

      const th = (col, label, alignRight) =>
        `<th scope="col" aria-sort="${ariaSort(col)}" onclick="sortConvAnalytics('${col}')" style="${alignRight ? 'text-align:right;' : ''}">` +
        `<button type="button" class="conv-analytics-th-btn" style="${alignRight ? 'justify-content:flex-end;margin-left:auto;' : ''}">${escapeHtml(label)}${arrow(col)}</button></th>`;

      const rowsHtml = sorted.map(c => {
        // Rounded the way the rest of the app rounds bytes: a conversation of four messages is
        // kilobytes, and "0.00 MB" beside it read as a row that had failed to measure itself.
        const size = formatConvSize(c.totalBytes);
        const titleTip = `${escapeHtml(c.name)} · ${c.totalBytes.toLocaleString()} bytes`;
        // The id rides in a data attribute rather than inside the handler's quotes: a name or an
        // id with an apostrophe in it would otherwise end the string and break the row.
        return `<tr>` +
          `<td><button type="button" class="conv-analytics-name-btn" data-id="${escapeHtml(c.id)}" ` +
          `onclick="openConversation(this.dataset.id)" title="Open ${escapeHtml(c.name)}">` +
          `${escapeHtml(c.name)}</button>${c.auto ? ' <span class="conv-analytics-auto-badge">auto</span>' : ''}</td>` +
          `<td class="conv-analytics-num">${c.msgCount.toLocaleString()}</td>` +
          `<td class="conv-analytics-num">${c.panes.toLocaleString()}</td>` +
          `<td class="conv-analytics-num" title="${titleTip}">${size}</td>` +
          `</tr>`;
      }).join('');

      tableWrap.innerHTML = `<table class="conv-analytics-table" aria-label="Conversations by local storage size">` +
        `<thead><tr>` +
        th('name', 'Conversation', false) +
        th('msgCount', 'Messages', true) +
        th('panes', 'Panes', true) +
        th('size', 'Size', true) +
        `</tr></thead>` +
        `<tbody>${rowsHtml}</tbody>` +
        `</table>`;
    }

    async function refreshConvAnalytics() {
      const btn = document.getElementById('convAnalyticsRefresh');
      if (btn) btn.classList.add('spinning');
      try {
        await renderConvAnalytics();
      } finally {
        if (btn) setTimeout(() => btn.classList.remove('spinning'), 350);
      }
    }

    // What lands in this box is almost never a bare URL. start.sh fences the address as a code
    // block so it is copyable on a phone, chat clients add their own backticks and newlines, and
    // the line above it in the terminal is "Tunnel:  wss://…". The link start.sh prints for the
    // phone is worse: it is a github.io address carrying the real one in ?relay=, so pasting it
    // whole used to store the wrong host entirely.
    //
    // So: pull the address out of whatever surrounds it rather than asking anyone to trim by hand.
    function cleanRelayUrl(raw) {
      let s = String(raw == null ? '' : raw).trim();
      if (!s) return '';
      // ?relay= first — in an app link the real address is in there, and the github.io URL
      // wrapping it would otherwise win the scheme match below.
      const rel = s.match(/[?&]relay=([^&\s'"`<>]+)/i);
      if (rel) { try { s = decodeURIComponent(rel[1]); } catch (e) { s = rel[1]; } }
      // The first thing that looks like an address, and nothing either side of it.
      const m = s.match(/(?:wss?|https?):\/\/[^\s'"`<>\\]+/i);
      if (m) s = m[0];
      // Trailing prose the regex is right to include mid-URL but wrong to keep at the end:
      // "…trycloudflare.com." at the end of a sentence, or inside brackets.
      s = s.replace(/[)>\]},.;:!?'"`]+$/, '');
      // A page served over https cannot open ws://, and the tunnel is quoted as https:// in
      // cloudflared's own banner — so the scheme people copy is often the wrong one of the pair.
      s = s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
      return s.replace(/\/+$/, '');
    }

    // Empties the box and leaves the caret in it, ready for the next tunnel's address. Nothing is
    // saved and nothing disconnects: what is stored is still what Connect last stored, so a cleared
    // box that is never submitted costs the reader nothing.
    function clearRelayUrl() {
      const input = document.getElementById('relayUrl');
      if (!input) return;
      input.value = '';
      input.focus();
      if (window.cue) cue('tick');
    }

    function saveAndConnect() {
      const box = document.getElementById('relayUrl');
      const url = cleanRelayUrl(box.value);
      if (!url) return;
      // Written back, so what was stored is what is on screen — a box still showing the pasted
      // mess after a successful connect reads as the paste having been rejected.
      box.value = url;
      localStorage.setItem('herdr_relay_url', url);
      const token = document.getElementById('relayToken').value.trim();
      if (token) localStorage.setItem('herdr_relay_token', token);
      else localStorage.removeItem('herdr_relay_token');
      connect();
      toggleSettings();
    }

    // Connection
    function connect() {
      let url = localStorage.getItem('herdr_relay_url') || (isSelfRelay ? autoRelayUrl : '');
      if (!url) { showSetup(); return; }
      if (ws) ws.close();
      // start_options is a per-connection capability advertisement, never cached state.
      startOptions = null;
      closeStart();
      render();
      setStatus('connecting');
      // Append token as query param if stored separately
      const token = localStorage.getItem('herdr_relay_token');
      let wsUrl = url;
      if (token) wsUrl += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
      ws = new WebSocket(wsUrl);
      // Central wire accounting. Every caller goes through this socket, so instrumenting it here
      // catches polls, sends, pushes and commands without duplicating counters at each call site.
      const send = ws.send.bind(ws);
      ws.send = data => {
        noteBandwidth('sent', data);
        try { const msg = JSON.parse(data); if (msg.type === 'read_pane') notePaneBandwidth(msg.pane_id, 'sent', data); }
        catch (e) { /* non-JSON wire payloads have no pane identity */ }
        return send(data);
      };
      // Re-announcing the push subscription here rather than only at subscribe time is what makes
      // it survive the socket being down at the wrong moment — on a phone that is most of the time.
      ws.onopen = () => {
        setStatus('connected');
        if (window.cue) cue('ready');
        announceSubscription();
      };
      ws.onclose = () => {
        // First drop only: reconnect attempts every 3s must not keep pushing the clock forward, or
        // an hour offline reads as three seconds when the socket finally comes back.
        if (!wsDownSince) wsDownSince = Date.now();
        resetBandwidthBucket();
        setStatus('disconnected');
        setTimeout(connect, 3000);
      };
      ws.onerror = () => setStatus('disconnected');
      ws.onmessage = (e) => {
        noteBandwidth('received', e.data);
        const msg = JSON.parse(e.data);
        if (msg.type === 'pane_content') notePaneBandwidth(msg.pane_id, 'received', e.data);
        handleMessage(msg);
      };
    }

    // One update path for every status dot: the app header's and the term header's, so the
    // connection stays visible on mobile where the app header is hidden. The dot carries the
    // whole signal — the text beside it said the same thing twice and cost tab room.
    function setStatus(s) {
      const color = s === 'connected' ? 'var(--dot-green)' : s === 'connecting' ? 'var(--dot-orange)' : 'var(--dot-red)';
      const label = s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Offline';
      document.querySelectorAll('.status-dot').forEach(d => {
        d.style.background = color;
        d.title = label;
      });
    }

    function showSetup() {
      document.getElementById('agents').innerHTML = `<div class="empty">
    <p style="font-size:1.5rem;margin-bottom:12px">🐑</p>
    <p><strong>herdr-remote</strong></p>
    <p style="margin-top:8px">Monitor & approve agents from your phone</p>
    <p style="margin-top:16px;font-size:0.75rem;color:var(--muted);text-align:left;max-width:280px;margin-left:auto;margin-right:auto">
      <strong>Connect your own:</strong><br>
      1. Run: <code style="font-size:0.7rem">cd relay && ./start.sh</code><br>
      2. Tap ⚙ → paste the wss:// URL<br>
    </p>
  </div>`;
    }
    function handleMessage(msg) {
      if (msg.type === 'error') {
        convLiveNoteError(msg.message);
        showToast(msg.message || 'The relay refused that.');
      }
      else if (msg.type === 'conv_log') {
        convLiveReceive(msg);
      }
      else if (msg.type === 'projects') {
        projects = msg.projects || [];
        render();
      }
      else if (msg.type === 'start_options') {
        startOptions = msg;
        render();
      }
      else if (msg.type === 'command_result' &&
               (msg.command === 'start_agent' || msg.command === 'open_terminal')) {
        document.getElementById('startSubmit').disabled = false;
        // The session appears on the next poll snapshot; the browser invents nothing.
        if (msg.ok) {
          // Say so when the relay had to rename around a collision — otherwise the pane shows up
          // under a name the user never typed and reads as the wrong session.
          const asked = document.getElementById('startName').value.trim();
          const renamed = asked && msg.label && msg.label !== asked;
          showSpawnStatus(renamed ? `Name taken — started as "${msg.label}" — opening…`
            : `${msg.command === 'open_terminal' ? 'Terminal opened' : 'Session started'} — opening…`,
            renamed ? 'warning' : 'busy');
          closeStart();
          // Open it once the poll has seen it. Not here: the session is not in `agents` yet, and
          // openTerminal reads the snapshot for the pane's title and its pair. Starting a session
          // is asking to work in it, so landing on the list and hunting for it is a step nobody
          // wanted.
          pendingStart = msg.pane_id || null;
        }
        else {
          const error = withRetryHint(msg.error ||
            (msg.command === 'open_terminal' ? 'could not open the terminal' : 'start failed'));
          setStartError(error);
          showSpawnStatus(error, 'error');
        }
      }
      else if (msg.type === 'command_result' && msg.command === 'set_slot') {
        if (!msg.ok) { showToast(msg.error || 'Could not adjust the pane'); }
        else if (activePane === msg.pane_id) {
          // Fitting the pane is the request to stop panning, so the layout follows it: a pane
          // herdr has just narrowed to this screen wants its lines wrapped to the screen too.
          // True size would leave the sideways scroll the fit was asked to remove.
          setWrapMode('reflow');
          // The relay reports a pane's width by measuring its scrollback, so the new number only
          // appears once the pane has redrawn at it. One delayed read beats guessing the width
          // here and laying the text out at a column count herdr may not have agreed to.
          setTimeout(refreshPane, 600);
        }
      }
      else if (msg.type === 'command_result' && msg.command === 'rename_pane') {
        // Same rule: apply the label only once the relay confirms herdr took it. Painting it
        // optimistically made a relay that never handled the message look like a working rename
        // until the next poll silently undid it.
        const a = paneOf(msg.pane_id);
        if (a && msg.ok) {
          a.label = msg.label;
          if (activePane === msg.pane_id) syncOpenPaneChrome();
          render();
          renderPairStrip();
        }
      }
      else if (msg.type === 'agents') {
        // Track timeline on status changes
        let ring = false;
        for (const a of msg.agents) {
          const prev = prevStatuses[a.pane_id];
          // First sight of a pane — the first snapshot after a reload, or an agent someone else
          // started. Nothing rings and nothing lands on the timeline, because none of that
          // happened while anyone was here to hear it. The recorder is the exception: a pane
          // already sitting in an ending state finished a turn that is still on screen and readable,
          // and refusing to look at it would throw away a recording this browser can plainly see.
          if (!prev) {
            noteStatus(a.pane_id, a.status, true);
            convReadTurnEnd(a.pane_id, a.status);
          }
          else if (prev !== a.status) {
            timeline.unshift({ project: a.project, agent: a.agent, status: a.status, time: new Date() });
            if (timeline.length > 100) timeline.pop();
            noteActivity(a.pane_id);
            noteStatus(a.pane_id, a.status);
            convReadTurnEnd(a.pane_id, a.status);
            if (shouldSound(a.pane_id, a.status)) ring = true;
          }
          prevStatuses[a.pane_id] = a.status;
        }
        // Once per snapshot, however many panes moved: a herd that all stop on the same poll is
        // one event to the person hearing it, not a chord.
        if (ring && window.cue) cue('chime');
        agents = msg.agents;
        // Not `msg.shells || []` — a relay with terminal mode off sends no key at all, and this
        // has to read as "no terminals" rather than crash the next .filter.
        shells = Array.isArray(msg.shells) ? msg.shells : [];
        // Before the render, so a pane's first snapshot and the card for it arrive together.
        convAutoJoin();
        // Which member is ended is a question only a snapshot answers, so the prune rides on one.
        // It writes nothing on the polls where nothing has outgrown the cap, which is all of them.
        convPruneAuto();
        // After the auto-join, so a pane filed under a conversation on this very snapshot is a
        // member by the time recovery looks for one. Declines on every snapshot but the first
        // after an outage long enough to have missed turns.
        convRecoverOutage();
        render();
        renderBandwidth();
        // Approvals and the back/forward targets both follow the snapshot: a session that just
        // blocked, or one that just ended, changes what the bar should offer.
        renderQuickActions();
        syncConvBadge();
        if (activePane) {
          // herdr reuses a pane_id once its pane closes, so an open pane that has left both lists
          // is not retargeted or polled on — it is let go.
          if (!paneOf(activePane)) {
            const gone = activePane;
            closeTerminal();
            showToast(`${gone} ended.`);
          } else {
            // A shell herdr just handed an agent loses its $ and its hidden controls here,
            // without the pane having to be reopened.
            syncOpenPaneChrome();
          }
        }
        openPendingStart();
        openNotificationPane();
      }
      else if (msg.type === 'agent_update') {
        const update = msg.agent;
        if (!update || !update.pane_id) return;
        const existing = agents.find(a => a.pane_id === update.pane_id);
        const previousStatus = existing?.status || prevStatuses[update.pane_id];
        if (existing) Object.assign(existing, update);
        else agents.push({ ...update });
        if (previousStatus && previousStatus !== update.status) {
          timeline.unshift({ project: update.project, agent: update.agent, status: update.status, time: new Date() });
          if (timeline.length > 100) timeline.pop();
          noteActivity(update.pane_id);
          noteStatus(update.pane_id, update.status);
          convReadTurnEnd(update.pane_id, update.status);
          if (shouldSound(update.pane_id, update.status) && window.cue) cue('chime');
          // A status change is the one thing that says the pane's text is about to be worth
          // re-reading, and it arrives here rather than being asked for — the relay polls herdr on
          // its own and pushes this. Reading now instead of waiting for the next tick is what
          // keeps an agent that woke up locally feeling live while idle panes are polled slowly.
          // Not while a deep read is on screen: scrollback does not change, and re-fetching tens
          // of thousands of lines is exactly what POLL_MAX_LINES exists to stop.
          if (update.pane_id === activePane && paneLines <= POLL_MAX_LINES) refreshPane();
        }
        prevStatuses[update.pane_id] = update.status;
        render();
        renderBandwidth();
        renderQuickActions();
        syncConvBadge();
      }
      else if (msg.type === 'blocked') {
        const a = agents.find(x => x.pane_id === msg.pane_id);
        if (a) { a.status = 'blocked'; a.prompt = msg.prompt; a.options = msg.options; }
        else agents.push({ ...msg, status: 'blocked' });
        // No chime here. The relay broadcasts the snapshot before this message, so the transition
        // into blocked has already been heard — sounding it again was two chimes for one event.
        noteActivity(msg.pane_id);
        noteStatus(msg.pane_id, 'blocked');
        convReadTurnEnd(msg.pane_id, 'blocked');
        timeline.unshift({ project: msg.project, agent: msg.agent, status: 'blocked', time: new Date() });
        if (timeline.length > 100) timeline.pop();
        render();
        renderBandwidth();
        renderQuickActions();  // the approval buttons belong on screen the moment it blocks
        syncConvBadge();
      } else if (msg.type === 'pane_content' && msg.pane_id !== activePane) {
        // A pane that is in a conversation, read because its turn just ended. Recorded, never
        // drawn: recordPane ignores any pane no conversation names, so a stray read is harmless.
        if (convRecordable(msg)) recordPane(msg.pane_id, (msg.content || '').split('\n'));
      } else if (msg.type === 'pane_content') {
        const el = document.getElementById('termContent');
        const prevHeight = el.scrollHeight;
        const prevScroll = el.scrollTop;
        const next = msg.content || '(empty)';
        // Splitting or resizing a pane changes its width mid-session, so this is re-applied
        // on change rather than read once when the pane opens.
        const cols = Number.isInteger(msg.cols) && msg.cols > 0 ? msg.cols : null;
        if (cols !== paneCols) { paneCols = cols; applyWrapMode(); }
        // Only a real change is activity. The pane is re-read every 3s regardless.
        // The pane's text changing is the finest-grained activity there is — it catches an agent
        // that answered without ever leaving 'working', which no status transition reports.
        //
        // The first content after opening is skipped: the element was empty, so it always differs,
        // and counting it stamped every pane the moment you looked at it. That one line was the
        // whole reason this field read the current time no matter which pane you switched to.
        if (!paneTextPrimed) {
          paneTextPrimed = true;
          syncPaneLoading();  // this read is the one the pill was waiting for
        } else if (next !== paneText) {
          paneStampAt = new Date();
          noteActivity(activePane);
          renderStatusBar();
        }
        setPaneText(next);
        if (userScrolledUp) {
          // Keep scroll position relative to bottom (content may have grown at top)
          const growth = el.scrollHeight - prevHeight;
          el.scrollTop = prevScroll + growth;
        } else {
          el.scrollTop = el.scrollHeight;
        }
        // setPaneText drew against the old scroll position; the band lives outside the scroller.
        drawSel();
        // After the pane is drawn: recording must never be what a user waits on, and it runs on
        // the rows the read already produced.
        if (convRecordable(msg)) recordPane(activePane, paneRows);
      }
    }

    function render() {
      syncAcked(agents.concat(shells));   // before anything reads needsAttention
      // The pane on screen, in front of you, is by definition one you have looked at — including
      // after it changes status while open. Gated on visibility rather than on activePane alone:
      // a backgrounded tab sitting on the pane that just finished is exactly the case the badge
      // and the chime exist for, and acking it there would swallow both.
      if (activePane && !document.hidden) ackPane(activePane);
      renderStatusBar();
      renderPairStrip();  // pair health is recomputed from every snapshot, never cached
      renderBody();
      renderRecents();
      renderAgentTabs();
      syncBrowserTab();
    }

    // Coming back to the tab is looking at it: a pane that finished while you were away has been
    // seen the moment you return to it, and the title has to drop the count with it.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

    // The browser tab, which is the only surface that reaches you when the app is not on screen —
    // another tab, another window, a phone with the PWA in the background. Everything else in this
    // file signals inside a page nobody is looking at.
    //
    // A count and a colour rather than a flashing title: a title that alternates is unreadable in
    // the tab strip and reads as spam, and browsers truncate it to a few characters anyway, which
    // is why the favicon carries the same signal on its own.
    const TAB_TITLE = 'herdr-remote';
    const favicon = fill => 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<rect width="16" height="16" rx="4" fill="#1a1b26"/>` +
      `<circle cx="8" cy="8" r="4.5" fill="${fill}"/></svg>`);
    function syncBrowserTab() {
      const n = attentionCount();
      document.title = n ? `(${n}) ${TAB_TITLE}` : TAB_TITLE;
      const el = document.getElementById('favicon');
      // Hex and not var(--red): this is an SVG in a data: URI, which resolves no custom property
      // from the page. The two are the dark theme's --red and --blue.
      //
      // Red is blocked alone, matching everything else. Done shares the resting blue rather than
      // getting a third colour: a 16px dot cannot carry three states apart at tab size, and the
      // count already in the title is what says a finished pane is waiting to be read.
      const href = favicon(agents.some(a => attentionKind(a) === 'blocked') ? '#f7768e' : '#7aa2f7');
      if (el && el.getAttribute('href') !== href) el.setAttribute('href', href);
    }

    // One insertion point for the independently rendered landing-page sections.
    function renderBody() {
      syncAgentKind();
      renderBodyMain();
      // Once, here, rather than at each of the three places that write #agents: every one of them
      // is reached through renderBodyMain, and a fourth added later would otherwise be a list that
      // silently lost its Reorder button.
      addOrderButton();
      const html = terminalsHtml();
      document.getElementById('terminals').innerHTML = html;
      document.getElementById('pairs').innerHTML = pairsHtml();
      renderConversations();
      // Live-ness is the one thing on the standalone view that this snapshot can change.
      renderConvStandalone(false);
      // "Waiting for agents…" is true of the agents and false of the box: a machine with
      // terminals and no agents is not waiting for anything. Only that placeholder goes — wiping
      // the node took the Projects strip and its cards with it.
      if (html && !agents.length) {
        document.getElementById('agents').querySelectorAll('.empty').forEach(n => n.remove());
      }
      applySections();
    }

    function renderBodyMain() {
      if (projects.length) { renderProjects(); return; }
      const workspaces = [...new Set(agents.map(a => a.workspace_id).filter(Boolean))];
      if (workspaces.length <= 1) {
        activeWorkspace = null;
        activeTab = null;
        renderAgentList(agents);
        return;
      }
      let html = hoistHtml(ofKind(agents)) + layoutHtml(agents);
      if (!agents.length) html = '<div class="empty">Waiting for agents…</div>';
      document.getElementById('agents').innerHTML = html;
    }

    // Outer Project layer. Native workspaces and tabs stay beneath it, unchanged.
    function renderProjects() {
      if (activeProject && !projects.some(p => p.id === activeProject)) activeProject = null;
      let html = hoistHtml(ofKind(agents));
      html += `<div class="chip-strip"><span class="chip-label">Projects</span>`;
      html += `<button class="chip${activeProject === null ? ' active' : ''}" onclick="selectProject(null)">All</button>`;
      for (const p of projects) {
        const list = agents.filter(a => a.project_id === p.id);
        html += `<button class="chip${activeProject === p.id ? ' active' : ''}${alertClass(groupKind(list))}" onclick="selectProject('${p.id}')">${p.label}</button>`;
      }
      html += `</div>`;
      if (activeProject === null) {
        html += projects.map(projectCard).join('');
        // Every agent, flat, exactly the way Terminals are listed below it. A Project card is a
        // filter, not the only door in: a session visible in a card's count was two taps away and
        // is now one. Whatever needs you is already hoisted to the top, so it is not repeated.
        const rest = ofKind(agents).filter(a => !hoisted(a));
        if (rest.length) html += section('Agents', rest);
        else if (agentKind) html += section('Agents', [], `No ${agentKind} sessions`);
      } else {
        if (startOptions) {
          // + New terminal only when the relay says both of open_terminal's gates are open —
          // a chip that always errors is worse than a chip that is not there.
          const term = startOptions.terminal
            ? `<button class="chip chip-add" onclick="openStartDialog('${activeProject}', event, 'terminal')">+ New terminal</button>` : '';
          html += `<div class="chip-strip"><button class="chip chip-add" onclick="openStartDialog('${activeProject}')">+ Start session</button>${term}</div>`;
        }
        // layoutHtml carries its own Working / Done / Idle separators, so the only Project tab
        // that ever lost one was the empty one — it dropped to a bare line of body text while
        // Terminals below it kept a heading. It gets a separator of its own, saying why it is
        // empty in the header rather than under it.
        const mine = agents.filter(a => a.project_id === activeProject);
        html += ofKind(mine).length ? layoutHtml(mine)
          : section('Agents', [], agentKind ? `No ${agentKind} sessions` : 'No sessions');
      }
      document.getElementById('agents').innerHTML = html;
    }

    function projectCard(p) {
      const list = agents.filter(a => a.project_id === p.id);
      // Counted apart and said apart. One number covering both read as "N needs you" over a
      // Project whose sessions had all finished and were waiting on nobody.
      const blocked = list.filter(a => attentionKind(a) === 'blocked').length;
      const finished = list.filter(a => attentionKind(a) === 'done').length;
      const color = blocked ? 'var(--dot-red)'
        : finished ? 'var(--dot-blue)'
          : list.length ? 'var(--dot-green)' : 'var(--muted)';
      const host = p.host && p.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${p.host}</span>` : '';
      const notes = [];
      if (blocked) notes.push(`${blocked} needs you`);
      if (finished) notes.push(`${finished} finished`);
      const meta = list.length
        ? `${list.length} session${list.length > 1 ? 's' : ''}${notes.length ? ` · ${notes.join(' · ')}` : ''}`
        : 'No sessions';
      // Available on every Project card, including one with zero live sessions.
      const start = startOptions
        ? `<button class="chip chip-add" aria-label="Start session in ${p.label}" onclick="openStartDialog('${p.id}',event)">+ Start</button>`
        : '';
      return `<div class="agent" role="button" tabindex="0" aria-label="${p.label}, ${meta}" onclick="selectProject('${p.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectProject('${p.id}')}">
    <span class="dot" style="background:${color}" aria-hidden="true"></span>
    <div class="info"><div class="project">${p.label}${host}</div><div class="meta">${meta}</div></div>
    ${start}
    <span style="color:var(--muted);font-size:1.2rem" aria-hidden="true">›</span>
  </div>`;
    }

    // Which harness the landing page is showing, or '' for all of them. A view, not a setting:
    // it is answered by what is running right now, so it is not kept across a reload — a filter
    // that survives a restart is a page that looks empty for a reason nobody remembers.
    let agentKind = '';

    // The last pane of a kind exiting takes the filter with it, rather than leaving the page
    // filtered to a harness that is no longer here. Read before anything draws: the badges are
    // hung on the list *after* it is built, so clearing it there would leave one frame of cards
    // filtered to a kind that is already gone.
    function syncAgentKind() {
      if (agentKind && !agents.some(a => a.agent === agentKind)) agentKind = '';
    }

    // The harnesses in this list, as the badges they wear everywhere else. Only when there is more
    // than one: a machine running nothing but claude has no choice to offer, and a lone badge that
    // filters to what is already on screen is a control that does nothing.
    function agentKindsHtml(list) {
      const kinds = [...new Set(list.map(a => a.agent).filter(Boolean))].sort();
      if (kinds.length < 2) return '';
      return `<span class="agent-kind-filter">` +
        kinds.map(k => badgeHtml(k, k === agentKind, `pickAgentKind('${k}')`,
          {agent: k, title: `Show only the ${k} sessions`})).join('') + `</span>`;
    }

    function ofKind(list) {
      return agentKind ? list.filter(a => a.agent === agentKind) : list;
    }

    // Tapping the lit badge takes the filter off, the same as every other badge in this app.
    function pickAgentKind(k) {
      agentKind = agentKind === k ? '' : k;
      renderBody();
      if (window.cue) cue('tick');
    }

    // Blocked only. A finished pane is not lifted out of its section — it keeps its blue badge
    // where it already sits, so this header means one thing and the eye can trust it.
    function hoistHtml(list) {
      const waiting = list.filter(hoisted);
      if (!waiting.length) return '';
      return `<div class="section-header" style="color:var(--red)">Needs you <span style="opacity:0.6">(${waiting.length})</span></div>`
        + agentCards(waiting);
    }

    // Native workspace/tab navigation over `list` — all agents, or one Project's.
    function layoutHtml(list) {
      const workspaces = [...new Set(list.map(a => a.workspace_id).filter(Boolean))];
      let html = '';
      visibleTabs = [];
      if (workspaces.length <= 1) {
        activeWorkspace = null;
        activeTab = null;
      } else {
        // Space chip strip
        html += `<div class="chip-strip"><span class="chip-label">Spaces</span>`;
        html += `<button class="chip${activeWorkspace === null ? ' active' : ''}" onclick="backToWorkspaces()">All</button>`;
        for (const wsId of workspaces) {
          const wsAgents = list.filter(a => a.workspace_id === wsId);
          const name = wsAgents[0]?.project || wsId.slice(0, 8);
          html += `<button class="chip${activeWorkspace === wsId ? ' active' : ''}${alertClass(groupKind(wsAgents))}" onclick="selectWorkspace('${wsId}')">${name}</button>`;
        }
        html += `</div>`;
        // Tab chip strip (always show when workspace selected)
        if (activeWorkspace) {
          const wsTabs = [...new Set(list.filter(a => a.workspace_id === activeWorkspace).map(a => a.tab_id).filter(Boolean))];
          visibleTabs = wsTabs;
          html += `<div class="chip-strip"><span class="chip-label">Tabs</span>`;
          if (wsTabs.length > 1) {
            html += `<button class="chip${!activeTab ? ' active' : ''}" onclick="selectTab(null)">All</button>`;
          }
          wsTabs.forEach((tid, i) => {
            const tabAgents = list.filter(a => a.tab_id === tid);
            const tabLabel = tabAgents[0]?.label || 'Tab ' + (i + 1);
            html += `<button class="chip${activeTab === tid ? ' active' : ''}${alertClass(groupKind(tabAgents))}" onclick="selectTab('${tid}')">${tabLabel}</button>`;
          });
          html += `<button class="chip chip-add" onclick="createTab('${activeWorkspace}')">+</button>`;
          html += `</div>`;
        }
      }
      // Agent list (filtered). Only what the hoist took is dropped here, so a done pane appears
      // exactly once — under Done, where it belongs — instead of being lifted into Needs you.
      // The harness filter narrows the cards and never the Spaces and Tabs above them: those are
      // navigation, and a strip that shed a tab because of a filter would be a second filter.
      let filtered = ofKind(list).filter(a => !hoisted(a));
      if (activeWorkspace) filtered = filtered.filter(a => a.workspace_id === activeWorkspace);
      if (activeTab) filtered = filtered.filter(a => a.tab_id === activeTab);
      const working = filtered.filter(a => a.status === 'working');
      const done = filtered.filter(a => a.status === 'done');
      const idle = filtered.filter(a => a.status === 'idle' || a.status === 'unknown');
      if (working.length) html += section('Working', working);
      if (done.length) html += section('Done', done);
      if (idle.length) html += section('Idle', idle);
      // A filter that matches nothing still needs its heading: the badges are hung on the first
      // one, so a page with no headings is a page filtered to nothing with no way back.
      if (agentKind && !ofKind(list).length) html += section('Agents', [], `No ${agentKind} sessions`);
      return html;
    }

    function renderAgentList(list) {
      const shown = ofKind(list);
      // Same rule as layoutHtml: the hoist owns the blocked panes you have not looked at, and the
      // sections below get everything else. Blocked still keeps a section for the acked ones —
      // a pane you have seen is blocked is not news, but it is still stuck.
      const rest = shown.filter(a => !hoisted(a));
      const blocked = rest.filter(a => a.status === 'blocked');
      const working = rest.filter(a => a.status === 'working');
      const done = rest.filter(a => a.status === 'done');
      const idle = rest.filter(a => a.status === 'idle' || a.status === 'unknown');
      let html = hoistHtml(shown);
      if (blocked.length) html += section('Blocked', blocked);
      if (working.length) html += section('Working', working);
      if (done.length) html += section('Done', done);
      if (idle.length) html += section('Idle', idle);
      // A filter that matches nothing says so under its own strip, rather than dropping the page
      // to a bare line with no way back to the rest of the sessions.
      if (!shown.length && list.length) html += section('Agents', [], `No ${agentKind} sessions`);
      if (!list.length) html = '<div class="empty">Waiting for agents…</div>';
      document.getElementById('agents').innerHTML = html;
    }

    // A workspace ID from one Project means nothing under another, and leaving it set
    // silently filters the new Project down to nothing.
    function selectProject(id) { activeProject = id; activeWorkspace = null; activeTab = null; render(); }
    function selectWorkspace(id) { activeWorkspace = id; activeTab = null; render(); }
    function backToWorkspaces() { activeWorkspace = null; activeTab = null; render(); }
    function selectTab(id) { activeTab = id; render(); }

    // The tab strip as last rendered. Read rather than recomputed, so the keyboard shortcut and
    // the chips can never disagree about what the next tab is.
    let visibleTabs = [];

    // One step along that strip, wrapping. "All" is a real position in it, and — as in the strip
    // itself — only offered once there is more than one tab to be "all" of.
    function stepTab(dir) {
      if (!visibleTabs.length) return false;
      const ring = visibleTabs.length > 1 ? [null, ...visibleTabs] : visibleTabs;
      const at = ring.indexOf(activeTab);
      selectTab(ring[(at + dir + ring.length) % ring.length]);
      return true;
    }

    function createTab(workspaceId) {
      if (!ws) return;
      if (window.cue) cue('sparkle');
      ws.send(JSON.stringify({ type: 'create_tab', workspace_id: workspaceId }));
      setTimeout(() => { activeTab = null; }, 1500);
    }
