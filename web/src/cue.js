    window.cue = (() => {
      // name: [group, wave, notes in Hz played in order, seconds per note, peak gain]
      //
      // The group is what Settings switches. Three and not nine: what a listener wants off is a
      // kind of moment — every tap, every outcome, or the one that calls them back to the phone —
      // and a checkbox per oscillator would be a mixing desk for a decision with three answers.
      const VOICES = {
        tick: ['ui', 'square', [1200], 0.03, 0.05],
        toggle: ['ui', 'square', [800, 1200], 0.05, 0.05],
        page: ['ui', 'sine', [520, 780], 0.06, 0.05],
        droplet: ['ui', 'sine', [1480, 990], 0.07, 0.05],
        success: ['result', 'sine', [880, 1320], 0.09, 0.06],
        ready: ['result', 'sine', [660, 880, 1320], 0.09, 0.06],
        sparkle: ['result', 'triangle', [1320, 1760, 2640], 0.05, 0.04],
        error: ['result', 'sawtooth', [220, 165], 0.10, 0.05],
        // The one that means "a pane is waiting on you", and the only one that has to carry across
        // a room — so it is the longest and the loudest of them. Its own group for the same reason:
        // someone silencing the interface in an office still wants to be told their agent stopped.
        chime: ['alert', 'sine', [880, 1174, 1568], 0.13, 0.08],
      };
      // Read per cue rather than cached: a checkbox has to take effect on the next tap, not the
      // next reload. Unset is on, so a browser that never stored anything sounds as it always did,
      // and one that refuses storage is audible rather than silently muted.
      window.cueOn = group => {
        try { return localStorage.getItem('herdr_sound_' + group) !== 'off'; }
        catch (e) { return true; }
      };
      let ctx;
      return name => {
        const voice = VOICES[name];
        if (!voice || !window.cueOn(voice[0])) return;
        try {
          ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
          if (ctx.state === 'suspended') ctx.resume();
          const [, wave, notes, dur, peak] = voice;
          notes.forEach((hz, i) => {
            const at = ctx.currentTime + i * dur;
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = wave;
            osc.frequency.value = hz;
            // Exponential and never to zero: a linear fade clicks at the end, and an exponential
            // ramp to an actual 0 is undefined. 0.0001 is inaudible and legal.
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start(at);
            osc.stop(at + dur + 0.02);
          });
        } catch (e) { /* no audio on this device: not a reason to break the caller */ }
      };
    })();
