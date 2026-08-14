    // --- Sounds ---
    // The store is read inside window.cue, in the head, so nothing here has to reach the call
    // sites — all twenty-odd of them route through that one function and are already guarded.
    const SOUND_GROUPS = {alert: 'soundAlert', result: 'soundResult', ui: 'soundUi'};
    function setSound(group, on) {
      try { localStorage.setItem('herdr_sound_' + group, on ? 'on' : 'off'); }
      catch (e) { /* private mode: session-only */ }
      document.getElementById(SOUND_GROUPS[group]).checked = on;
      // A demo of the thing being switched, and the gesture that unlocks the AudioContext in the
      // same tap. Only on the way on: playing a sound to confirm silence is a joke at the user.
      if (on && window.cue) cue(group === 'alert' ? 'chime' : group === 'result' ? 'success' : 'tick');
    }
    // Guarded the same way every cue call site is. The head script that defines these is the one
    // piece of this app that can be missing — a CSP, a truncated download — and every other line
    // that touches it says `if (window.cue)`. This one ran unguarded and would have taken the whole
    // page's initialisation down with it, which is a hard failure to trade for a missing beep.
    for (const [group, id] of Object.entries(SOUND_GROUPS)) {
      document.getElementById(id).checked = window.cueOn ? window.cueOn(group) : true;
    }
