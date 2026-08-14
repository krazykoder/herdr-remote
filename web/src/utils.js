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
