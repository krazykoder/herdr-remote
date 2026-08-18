    // --- The controls that hang over a thread ---
    //
    // Two of them, in all three places a conversation is read: the pane as rows, the pane as its
    // thread, and the conversation window. `Last` appears only when the reader is not at the end,
    // and `⟳` refreshes and then tidies.
    //
    // They hang over the text rather than sitting in a bar for one reason: on a phone the thread
    // already shares the screen with a header, a composer, a footer and a tab strip, and a row of
    // chrome for two buttons is a row of messages nobody can see.

    // Far enough from the end to be somewhere else. The pane's own `userScrolledUp` uses 50 and the
    // thread sticks within 24; this is looser than both, so the button cannot flicker at the edge of
    // either rule as a new message lands.
    const HANG_LAST_GAP = 60;

    function hangScrolledUp(el) {
      return !!el && (el.scrollHeight - el.scrollTop - el.clientHeight) > HANG_LAST_GAP;
    }

    // Which box the pane is being read in. The thread and the rows are siblings and one of them is
    // always hidden, so this is the same question `scrollPaneToBottom` asks.
    function hangPaneBox() {
      const box = document.getElementById('convThread');
      return box && !box.hidden ? box : document.getElementById('termContent');
    }

    // The conversation window thread box is the scroller inside .conv-wrap.
    function hangConvBox() {
      return document.getElementById('convViewThread') || document.getElementById('convView');
    }

    function hangSync() {
      const pane = document.getElementById('paneLast'), conv = document.getElementById('convLast');
      if (pane) pane.classList.toggle('on', !!activePane && hangScrolledUp(hangPaneBox()));
      if (conv) conv.classList.toggle('on', hangScrolledUp(hangConvBox()));
      // The refresh is offered whenever there is something to refresh, which is a different
      // question from where the reader is standing.
      const paneTidy = document.getElementById('paneTidy');
      const convTidy = document.getElementById('convTidy');
      if (paneTidy) paneTidy.classList.toggle('on', !!activePane);
      if (convTidy) convTidy.classList.toggle('on', !!convViewId);
      // Which record the thread is reading. Offered only where there is a thread to read — over the
      // pane's rows there is no bubble for it to change — and pressed is a state, so it is marked
      // on the button rather than said in a toast the reader has to remember.
      const thread = document.getElementById('convThread');
      hangSyncLive(document.getElementById('paneLive'), !!thread && !thread.hidden);
      hangSyncLive(document.getElementById('convLive'), !!convViewId);
    }

    function hangSyncLive(btn, offered) {
      if (!btn) return;
      const on = convLiveOn();
      btn.classList.toggle('on', offered);
      btn.classList.toggle('live', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on
        ? 'Reading the relay’s record — tap for this browser’s transcript'
        : 'Reading this browser’s transcript — tap for the relay’s record';
    }

    function hangToLast() {
      scrollPaneToBottom();
      hangSync();
    }

    function hangToLastConv() {
      const box = hangConvBox();
      if (box) box.scrollTop = box.scrollHeight;
      hangSync();
    }

    // Refresh, then tidy — one button, because they are one intention: "show me this properly". The
    // tidy is the same repair the pane menu offers, run without its confirmation: nothing is being
    // decided here that the reader has not already asked for, and a dialog on every refresh would
    // make the button unusable. It stays silent when it finds nothing, for the same reason.
    async function hangRefresh() {
      const btn = document.getElementById('paneTidy');
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      if (btn) btn.classList.add('busy');
      try {
        refreshPane();
        // "Show me this properly" over the relay's record is one more question to it, asked now
        // rather than at the next cadence. Invalidated rather than fetched from here: the roster
        // the thread is showing is the render's answer, not this button's, and asking for the open
        // pane alone would narrow a joint thread for one frame. The tidy below is a repair of the
        // local transcript and runs either way — the toggle changes what is drawn, not what is
        // stored.
        if (convLiveOn()) { convLiveInvalidate(); renderConvView(); }
        const removed = await convTidyQuiet([convMemberKey(a)]);
        if (removed) showToast(`Removed ${removed} duplicate message${removed > 1 ? 's' : ''}`);
      } finally {
        if (btn) btn.classList.remove('busy');
      }
    }

    // The window's own refresh. There is no pane behind it to read — the record outlives the panes
    // that wrote it — so refreshing here is re-reading the transcripts off disk and drawing them
    // again, over every member rather than one.
    async function hangRefreshConv() {
      const btn = document.getElementById('convTidy');
      const conv = convViewId ? loadConvIndex().find(c => c.id === convViewId) : null;
      if (!conv) return;
      if (btn) btn.classList.add('busy');
      try {
        if (convLiveOn()) convLiveInvalidate();   // ask the relay again, on the way through
        const removed = await convTidyQuiet((conv.members || []).map(m => m.key));
        convStandaloneHtml = '';        // the thread is being redrawn from the record, not diffed
        await renderConvStandalone(true);
        if (removed) showToast(`Removed ${removed} duplicate message${removed > 1 ? 's' : ''}`);
      } finally {
        if (btn) btn.classList.remove('busy');
      }
    }

    // Scroll says where the reader is; a resize of the content says the thread grew under them,
    // which changes the same answer without a scroll event ever firing.
    {
      const boxes = ['termContent', 'convThread', 'convViewThread', 'convView']
        .map(id => document.getElementById(id)).filter(Boolean);
      for (const el of boxes) el.addEventListener('scroll', hangSync, { passive: true });
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(hangSync);
        for (const id of ['termContent', 'convThread', 'convViewThread']) {
          const el = document.getElementById(id);
          if (el) ro.observe(el);
        }
      }
    }
