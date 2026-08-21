    // The shell is sized to the *visual* viewport, not the layout one, so anything docked at the
    // bottom — the conversation composer, the terminal input — rides above the on-screen keyboard
    // instead of behind it. `interactive-widget=resizes-content` in the meta tag does this on
    // Chrome for Android; Safari ignores it and leaves the page at full height with the keyboard
    // drawn over the last 300px of it, which is where the composer lives.
    (() => {
      const vv = window.visualViewport;
      if (!vv) return;
      const fit = () => {
        // Pinch-zoom shrinks the visual viewport too, and that is the user looking closer rather
        // than a widget taking space. Resizing the page to the zoomed frame would reflow it under
        // their fingers; zooming back out fires this again and restores the fit.
        if (vv.scale > 1.01) return;
        document.body.style.height = vv.height + 'px';
        // The same measurement, published for anything that *cannot* be sized by shrinking the
        // body: a `position: fixed` element is laid out against the layout viewport, which the
        // keyboard does not shrink on Safari, so `bottom: 0` puts it behind the keyboard however
        // short the body is. The bottom sheets are all fixed — see .sheet — and this is the number
        // they need. Zero on Chrome, where the meta tag already shrank the layout viewport and
        // `bottom: 0` is right by itself.
        const root = document.documentElement.style;
        root.setProperty('--kb-inset',
                         Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px');
        root.setProperty('--vv-height', vv.height + 'px');
        // Safari also scrolls the layout viewport up to reveal the focused field, taking the
        // header off screen. With the body already short enough to fit, there is nothing to reveal.
        if (vv.offsetTop) window.scrollTo(0, 0);
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      fit();
    })();

    // How recently a pane moved, in the three bands the colours are drawn from. One function so
    // the dot and the tab strip's cache signature cannot disagree about which band a pane is in.
    function activityBucket(paneId) {
      const since = Date.now() - (lastSeen[paneId] || 0);
      if (since < LIVE_MS) return 'live';
      if (since < RECENT_MS) return 'idle';
      return 'cold';
    }

    // One rule for every agent status dot, list and tab strip alike.
    //
    // Green is live: working, or moved within the last five minutes. An agent that finished
    // seconds ago is as live as one still running, and the previous rule painted it amber the
    // instant it left 'working' — which read as "going cold" at the exact moment it wanted
    // attention. Amber is now what it says: idle, somewhere between five minutes and an hour.
    // Muted is cold, and blocked outranks all of it.
    function statusColor(a) {
      if (a.status === 'blocked') return 'var(--dot-red)';
      if (a.status === 'working') return 'var(--dot-green)';
      const bucket = activityBucket(a.pane_id);
      if (bucket === 'live') return 'var(--dot-green)';
      if (bucket === 'idle') return 'var(--dot-orange)';
      return 'var(--muted)';
    }

    // A shell has no status, so recency is the whole signal — and the cold end is its own blue
    // rather than the muted grey a cold agent gets. That blue is what says "terminal" at a
    // glance, and a shell only ever stamps while it is open, so most of them sit cold most of
    // the time: a strip of grey dots would have thrown the identity away to say nothing.
    function shellColor(paneId) {
      const bucket = activityBucket(paneId);
      if (bucket === 'live') return 'var(--dot-green)';
      if (bucket === 'idle') return 'var(--dot-orange)';
      return 'var(--dot-shell)';
    }
    let activeWorkspace = null;
    let activeTab = null;
    let projects = [], activeProject = null;
    // Absence of start_options is the feature gate: no message, no Start session control.
    // startMode is which of the two things the shared dialog is currently asking about.
    let startOptions = null, startProjectId = null, startMode = 'agent';
    // Pairs live only in this browser. The relay has no pair message and stores no pair data.
    let pairs = [], pairSource = null, pairPartner = null, transferSelection = '';
