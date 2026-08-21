    // --- Launcher storage ---
    // localStorage is the working copy every render reads; state_sync mirrors it to the relay so
    // the tiles are the same set on the phone and the desktop. The split is the one
    // conversation_store.js already uses: the schema is pure and testable next door in
    // launcher_pure.js, and only this file knows there is a browser.

    function loadLauncher() {
      try { return parseLauncher(localStorage.getItem(LAUNCHER_KEY)); }
      catch (e) { return []; }   // private mode: nothing stored
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

    // One tile in, by id. Used by the editor for both add and edit, because "save this tile" is
    // one operation to the person doing it.
    function putLauncherTile(tile) {
      const items = loadLauncher();
      const at = items.findIndex(t => t.id === tile.id);
      if (at < 0) items.push(tile); else items[at] = tile;
      return saveLauncher(items);
    }

    function removeLauncherTile(id) {
      return saveLauncher(loadLauncher().filter(t => t.id !== id));
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
