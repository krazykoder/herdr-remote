    // --- Launcher storage ---
    // localStorage is the working copy every render reads; state_sync mirrors it to the relay so
    // the tiles are the same set on the phone and the desktop. The split is the one
    // conversation_store.js already uses: the schema is pure and testable next door in
    // launcher_pure.js, and only this file knows there is a browser.

    // Bots are added on the way out rather than written in on the way past: a browser that has
    // never stored anything still draws them, and one whose stored bot the user has edited reads
    // that one back untouched. It reaches storage the next time anything is saved.
    function loadLauncher() {
      try { return launcherWithBots(parseLauncher(localStorage.getItem(LAUNCHER_KEY))); }
      catch (e) { return launcherWithBots([]); }   // private mode: nothing stored
    }

    // Every write goes through here, which is what keeps the outbox honest. The outbox is the set
    // of tile ids this browser made and the relay has never acknowledged; on reconnect it is the
    // only thing stateMerge will carry over the relay's document, so a tile built offline survives
    // an adopt and a stale cache still cannot resurrect a tile someone else deleted.
    function saveLauncher(items) {
      const kept = items.slice(0, LAUNCHER_MAX);
      try {
        // Ids this save *adds* are what the relay has never been told about. Ids it drops leave
        // the outbox with them: a tile deleted before it ever synced is not waiting to be sent
        // anywhere, and an outbox that only grows is a key that never stops.
        const before = new Set(loadLauncher().map(t => t.id));
        const here = new Set(kept.map(t => t.id));
        const pending = JSON.parse(localStorage.getItem(LAUNCHER_PENDING_KEY) || '[]');
        const next = new Set((Array.isArray(pending) ? pending : []).filter(id => here.has(id)));
        for (const t of kept) if (!before.has(t.id)) next.add(t.id);
        localStorage.setItem(LAUNCHER_PENDING_KEY, JSON.stringify(Array.from(next)));
        localStorage.setItem(LAUNCHER_KEY, serializeLauncher(kept));
      } catch (e) { /* private mode: this session only */ }
      if (typeof stateSyncMark === 'function') stateSyncMark('launcher');
      return kept;
    }

    // A stored section order written before the launcher existed does not name it, and
    // loadSections reads that absence as "switched off" — correctly, because it cannot tell the
    // two apart. So the section is switched on at the one moment that says the user wants it: they
    // just saved a tile. Causal rather than a migration, which is what lets a later switch-off
    // stick instead of being undone on the next load.
    //
    // Only when there is nothing there yet — a second tile must not resurrect a section its owner
    // deliberately turned off.
    function ensureLauncherSection(had) {
      if (had || typeof toggleSection !== 'function') return;
      if (typeof sectionOrder !== 'undefined' && sectionOrder.includes('launcher')) return;
      toggleSection('launcher', true);
    }

    // One tile in, by id. Used by the editor for both add and edit, because "save this tile" is
    // one operation to the person doing it.
    function putLauncherTile(tile) {
      const items = loadLauncher();
      // The bots do not count. They are here on every load, so counting them would mean the
      // section's one moment of "the user just made a tile" never arrives — see
      // ensureLauncherSection for why that moment is the switch.
      const had = items.filter(t => !launcherIsBot(t)).length;
      const at = items.findIndex(t => t.id === tile.id);
      if (at < 0) items.push(tile); else items[at] = tile;
      const kept = saveLauncher(items);
      ensureLauncherSection(had);
      return kept;
    }

    // A bot is refused. Its row is the only way into a conversation that may have months in it,
    // and deleting the row would not delete the thread — it would strand it, and the seed would
    // put the row back wearing the default harness rather than the one that was chosen. The
    // harness is editable; the row is not.
    function removeLauncherTile(id) {
      const items = loadLauncher();
      if (launcherIsBot(items.find(t => t.id === id))) return items;
      return saveLauncher(items.filter(t => t.id !== id));
    }

    // Move one tile by one place. The whole of reordering: six tiles do not need a drag-and-drop
    // system, and this is the same control the reorder sheet already offers for agents.
    function moveLauncherTile(id, by) {
      const items = loadLauncher();
      const at = items.findIndex(t => t.id === id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= items.length) return items;
      items.splice(to, 0, items.splice(at, 1)[0]);
      return saveLauncher(items);
    }
