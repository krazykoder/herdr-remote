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

    // The conversation window scrolls as a whole — see `.view` — so the scroller is the view, not
    // the thread inside it.
    function hangConvBox() {
      return document.getElementById('convView');
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
      const boxes = ['termContent', 'convThread', 'convView']
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
