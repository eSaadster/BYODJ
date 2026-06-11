/* ===========================================================================
 * BYODJ — agent-config.js
 * Owns: LLM config panel, chat panel, status regions, PageAgent lifecycle.
 * Classic script (no modules). Loaded after Tone.js, page-agent (IIFE,
 * ?autoInit=false), and synth.js at the end of <body>.
 * Exposes exactly one global: window.BYODJ_AGENT
 * ======================================================================== */

(function () {
  'use strict';

  // ---- localStorage keys (pinned) ----------------------------------------
  var LS_BASE_URL = 'byodj.baseURL';
  var LS_API_KEY = 'byodj.apiKey';
  var LS_MODEL = 'byodj.model';
  var LS_MODE = 'byodj.mode';

  // ---- Pinned system prompt (additive via instructions.system) -----------
  var BYODJ_SYSTEM_PROMPT = `
You are operating BYODJ, a music synthesizer web page. You compose music by manipulating its controls. You cannot hear audio; reason from control values and music theory.

PAGE LAYOUT:
- Step sequencer: 16 steps x 10 rows of toggle buttons labeled "{name} step {s}". A cell plays when data-state=on; click once to toggle. Steps 0-15 run left to right; 0,4,8,12 are the beats. Rows: 0=Kick, 1=Bass, 2=Snare, 3=ClosedHat, 4=OpenHat, 5=LeadRoot, 6=LeadThird, 7=LeadFifth, 8=LeadSeventh (jazzy 7th), 9=LeadHigh (root an octave up). Rows 5-9 play notes from the selected scale; the same step on several lead rows makes a chord.
- MIXER: channel sliders "Kick Vol (dB)", "Bass Vol (dB)", "Snare Vol (dB)", "Hats Vol (dB)", "Lead Vol (dB)" (-24..6, 0=neutral) plus Mute toggle buttons ("Mute Kick" etc; data-state=on means MUTED). Use mutes for drops and breakdowns - never clear a pattern just to silence a part.
- MASTER & GROOVE sliders: Master Vol (dB) -36..6; DJ Filter -100..100 (negative=muffled lowpass sweep, positive=thin highpass sweep, 0=off - the classic DJ build/drop move); Pump 0-1 (mix ducks on every kick: house/EDM breathing); Bitcrush 0-1 (lo-fi grit on the whole mix); Swing 0-0.5 (0=robotic, 0.08=house, 0.18=lofi/hiphop).
- CONTROLS sliders: Tempo (BPM) 60-200; Filter Cutoff (Hz) 100-10000 (lead brightness, low=dark); Filter Resonance (Q) 0-20; Envelope Attack/Decay/Release seconds and Sustain 0-1 (long attack+release=pads, short=plucky); Reverb, Delay, Distortion 0-1.
- SOUND DESIGN: Drum Kit (analog, 808=boomy trap, 909=punchy house/techno, lofi=dusty); Bass Style (sub=deep thud, saw=reese/electro, acid=303 squelch); Lead Octave (3=dark, 4, 5=sparkly); Lead Note Length (16n=plucky arp, 8n, 4n, 2n=pads); Glide (seconds) 0-0.3 bass slides (303-style); Chorus 0-1 wide/dreamy.
- Dropdowns: Lead Waveform (sine=soft, triangle=mellow, square=chiptune, sawtooth=bright, fatsawtooth/fatsquare/fattriangle=huge detuned), Scale (major=happy, minor=sad, dorian=jazzy, phrygian=dark, lydian=dreamy, mixolydian=funky, harmonicMinor=dramatic, blues=gritty, pentatonic=safe), Root Note (C..B).
- Transport buttons: "Play Sequence", "Stop Sequence", "Clear Grid", "Randomize Grid".

GENRE CHEATSHEET (starting points):
house: 124bpm, kit 909, kick 0,4,8,12, openHat 2,6,10,14, snare 4,12, swing 0.08, bass saw, pump 0.5.
techno: 134bpm, kit 909, closedHat all 16, phrygian, sawtooth, distortion 0.2, pump 0.3.
lofi: 78bpm, kit lofi, swing 0.18, bitcrush 0.4, chorus 0.3, triangle, dorian, cutoff 1200, note length 4n.
trap: 140bpm, kit 808, sparse kick, snare on 8, closedHat runs of consecutive steps, lead octave 5.
synthwave: 100bpm, fatsawtooth, chorus 0.5, reverb 0.4, minor, note length 8n, octave 3 chords.
ambient: 70bpm, few or no drums, lydian, attack 1+, release 3+, note length 2n, reverb 0.7.

RULES:
1. Translate mood/genre into settings FIRST (tempo, scale, root, kit, bass style, waveform, effects), then program the grid.
2. Typical patterns: kick 0,4,8,12; snare 4,12; closed hats on even steps; bass locked with kick; melody sparse (4-10 cells across rows 5-9).
3. Verify each click by re-reading the cell or toggle's data-state. Sliders are set with input_text (a plain number in range); volume sliders are dB and may be negative.
4. Use "Clear Grid" before a completely new pattern; keep existing cells for tweaks. For drops/breakdowns use Mute buttons.
5. ALWAYS click "Play Sequence" as your final action before done (it shows data-state=playing while running, data-state=stopped otherwise).
`.trim();

  // ---- Composer mode: one-shot composition via a custom tool --------------
  var BYODJ_COMPOSER_PROMPT = `
You are the composer for BYODJ, a music synthesizer web page. You cannot hear audio; reason from music theory.

You have a custom tool "set_composition" that applies an ENTIRE composition in one call - tempo, scale, root, sound design, mixer, effects, and the 16-step pattern for all 10 instrument rows - then starts playback.

THE SEQUENCER: 16 steps (0-15) per row; steps 0,4,8,12 are the beats. Drum rows: kick, bass, snare, closedHat, openHat (bass plays the root note). Melodic rows from the selected scale: leadRoot, leadThird, leadFifth, leadSeventh (jazzy), leadHigh (root an octave up) - the same step on several lead rows makes a chord.

KEY FIELDS (all optional; omitted fields keep their current value):
- drumKit: analog | 808 (boomy trap) | 909 (punchy house/techno) | lofi (dusty). bassStyle: sub (deep thud) | saw (reese/electro) | acid (303 squelch).
- tempo 60-200; swing 0-0.5 (0=straight, 0.08=house, 0.18=lofi/hiphop).
- leadOctave "3"|"4"|"5" (3=dark, 5=sparkly); leadNoteLen 16n=plucky arp, 8n, 4n, 2n=pads; glide 0-0.3 (303-style bass slides); waveform (sine=soft, triangle=mellow, square=chiptune, sawtooth=bright, fatsawtooth/fatsquare/fattriangle=huge detuned); envelope ADSR (long attack+release=pads, short=plucky); filterCutoff 100-10000 (low=dark).
- scale moods: major=happy, minor=sad, dorian=jazzy, phrygian=dark, lydian=dreamy, mixolydian=funky, harmonicMinor=dramatic, blues=gritty, pentatonic=safe.
- Effects 0-1: reverb (space), delay (echo), distortion (grit), chorus (wide/dreamy), crush (lo-fi bitcrush on the whole mix), pump (mix ducks on every kick - house/EDM breathing). djFilter -100..100 (negative=muffled lowpass, positive=thin highpass, 0=off).
- mixer: channel volumes in dB -24..6 (0=neutral): kickVol, bassVol, snareVol, hatsVol, leadVol; and booleans kickMute, bassMute, snareMute, hatsMute, leadMute. Use mutes for drops/breakdowns - patterns are kept.
- top-level masterVolume: dB -36..6 (NOT inside mixer).

GENRE CHEATSHEET (starting points):
house: tempo 124, drumKit 909, kick [0,4,8,12], openHat [2,6,10,14], snare [4,12], swing 0.08, bassStyle saw, pump 0.5.
techno: 134, 909, closedHat all 16, phrygian, sawtooth, distortion 0.2, pump 0.3.
lofi: 78, lofi kit, swing 0.18, crush 0.4, chorus 0.3, triangle, dorian, filterCutoff 1200, leadNoteLen 4n.
trap: 140, 808, sparse kick, snare [8], closedHat consecutive-step rolls, leadOctave "5".
synthwave: 100, fatsawtooth, chorus 0.5, reverb 0.4, minor, leadNoteLen 8n, leadOctave "3" chords.
ambient: 70, few or no drums, lydian, envelope attack 1+, release 3+, leadNoteLen 2n, reverb 0.7.

WORKFLOW:
1. Decide everything first, then call set_composition ONCE. Brand-new piece: clearFirst=true plus every row you want. Tweak: pass only the fields and rows that change - omitted ones are kept.
2. Typical pattern: kick 0,4,8,12; snare 4,12; closed hats on even steps; bass locked with kick; melody sparse (4-10 cells across the five lead rows).
3. The tool starts playback and returns a summary. Then immediately finish the task. Do NOT click page controls or verify cells one by one unless the tool reported an error.
`.trim();

  var COMPOSITION_JSON_SCHEMA = {
    type: 'object',
    description: 'Complete or partial synth composition. Omitted fields keep their current value; pattern rows that are present replace that row entirely, omitted rows are kept.',
    properties: {
      clearFirst: { type: 'boolean', description: 'Clear the whole grid before applying the pattern. Use true for a brand-new composition.' },
      tempo: { type: 'number', description: 'Beats per minute, 60-200' },
      scale: { type: 'string', enum: ['major', 'minor', 'dorian', 'phrygian', 'pentatonic', 'lydian', 'mixolydian', 'harmonicMinor', 'blues'] },
      root: { type: 'string', enum: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] },
      waveform: { type: 'string', enum: ['sine', 'square', 'sawtooth', 'triangle', 'fatsawtooth', 'fatsquare', 'fattriangle'], description: 'Lead oscillator: sine=soft, triangle=mellow, square=chiptune, sawtooth=aggressive, fat*=huge detuned' },
      swing: { type: 'number', description: 'Shuffle 0-0.5. 0=straight, 0.08=house groove, 0.18=lofi/hiphop' },
      drumKit: { type: 'string', enum: ['analog', '808', '909', 'lofi'], description: 'Re-voices all drums: 808=boomy trap, 909=punchy house/techno, lofi=dusty' },
      bassStyle: { type: 'string', enum: ['sub', 'saw', 'acid'], description: 'sub=deep thud, saw=reese/electro, acid=303 squelch' },
      leadOctave: { type: 'string', enum: ['3', '4', '5'], description: 'Lead register: 3=dark, 5=sparkly' },
      leadNoteLen: { type: 'string', enum: ['16n', '8n', '4n', '2n'], description: 'Lead note length: 16n=plucky arp, 2n=pads/chords' },
      glide: { type: 'number', description: 'Bass portamento seconds 0-0.3 (303-style slides)' },
      chorus: { type: 'number', description: 'Chorus wet 0-1 (lush/wide/dreamy)' },
      crush: { type: 'number', description: 'Bitcrush wet 0-1 on the whole mix (lo-fi/8-bit grit)' },
      pump: { type: 'number', description: 'Sidechain pump 0-1: mix ducks on every kick (house/EDM breathing)' },
      djFilter: { type: 'number', description: 'Master sweep -100..100. Negative=muffled lowpass, positive=thin highpass, 0=off' },
      masterVolume: { type: 'number', description: 'Master volume dB, -36..6, 0=default' },
      mixer: {
        type: 'object',
        description: 'Channel volumes in dB (-24..6, 0=neutral) and mutes. Use mutes for drops/breakdowns - patterns are kept.',
        properties: {
          kickVol: { type: 'number' },
          bassVol: { type: 'number' },
          snareVol: { type: 'number' },
          hatsVol: { type: 'number' },
          leadVol: { type: 'number' },
          kickMute: { type: 'boolean' },
          bassMute: { type: 'boolean' },
          snareMute: { type: 'boolean' },
          hatsMute: { type: 'boolean' },
          leadMute: { type: 'boolean' }
        }
      },
      filterCutoff: { type: 'number', description: 'Low-pass cutoff in Hz, 100-10000. Low=dark/muffled, high=bright' },
      filterResonance: { type: 'number', description: 'Filter Q, 0-20' },
      envelope: {
        type: 'object',
        description: 'Lead synth ADSR. Long attack+release=pads, short=plucky',
        properties: {
          attack: { type: 'number', description: 'seconds, 0.001-2' },
          decay: { type: 'number', description: 'seconds, 0.01-2' },
          sustain: { type: 'number', description: '0-1' },
          release: { type: 'number', description: 'seconds, 0.01-4' }
        }
      },
      reverb: { type: 'number', description: 'Reverb wet amount 0-1 (space)' },
      delay: { type: 'number', description: 'Delay wet amount 0-1 (echo)' },
      distortion: { type: 'number', description: 'Distortion amount 0-1 (grit)' },
      pattern: {
        type: 'object',
        description: 'Step indices (integers 0-15) that are ON per row. Steps 0,4,8,12 are the quarter-note beats.',
        properties: {
          kick: { type: 'array', items: { type: 'integer' }, description: 'Kick drum steps' },
          bass: { type: 'array', items: { type: 'integer' }, description: 'Bass steps (plays the root note)' },
          snare: { type: 'array', items: { type: 'integer' }, description: 'Snare steps' },
          closedHat: { type: 'array', items: { type: 'integer' }, description: 'Closed hi-hat steps' },
          openHat: { type: 'array', items: { type: 'integer' }, description: 'Open hi-hat steps' },
          leadRoot: { type: 'array', items: { type: 'integer' }, description: 'Lead melody: scale root' },
          leadThird: { type: 'array', items: { type: 'integer' }, description: 'Lead melody: scale third' },
          leadFifth: { type: 'array', items: { type: 'integer' }, description: 'Lead melody: scale fifth' },
          leadSeventh: { type: 'array', items: { type: 'integer' }, description: 'Lead melody: scale seventh (jazzy)' },
          leadHigh: { type: 'array', items: { type: 'integer' }, description: 'Lead melody: root one octave up' }
        }
      },
      play: { type: 'boolean', description: 'Start playback after applying. Default true.' }
    }
  };

  // page-agent's customTools expect a zod v4 schema: it embeds each tool's
  // inputSchema inside a real zod object() (the AgentOutput macro-tool) and
  // serializes it with zod's toJSONSchema. The IIFE bundle does not expose
  // zod, so this shim satisfies the three zod-internal entry points actually
  // exercised:
  //   - _zod.toJSONSchema(): zod's toJSONSchema short-circuits here and uses
  //     the returned JSON schema verbatim (this is what the LLM sees),
  //   - _zod.run()/_zod.parse(): the parser for this property — passthrough,
  //     i.e. accept anything with zero issues. Field-level validation happens
  //     inside applyComposition, which reports problems back to the LLM as
  //     tool output it can react to,
  //   - safeParse(): in case the schema is ever used standalone.
  function zodLikeSchema(jsonSchema) {
    var passthrough = function (payload) { return payload; };
    return {
      _zod: {
        def: { type: 'custom' },
        // zod object() shapes reject members whose traits lack the $ZodType brand
        traits: new Set(['$ZodType']),
        toJSONSchema: function () { return jsonSchema; },
        run: passthrough,
        parse: passthrough
      },
      safeParse: function (data) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return { success: true, data: data };
        }
        return {
          success: false,
          error: { name: 'ZodError', issues: [{ code: 'custom', path: [], message: 'Expected a JSON object of composition settings' }] }
        };
      }
    };
  }

  var SET_COMPOSITION_TOOL = {
    description: 'Apply a complete musical composition to the synth in ONE call: tempo, scale, root, lead waveform, envelope, effects, and the 16-step pattern per instrument row — then start playback. Strongly prefer this over clicking individual controls.',
    inputSchema: zodLikeSchema(COMPOSITION_JSON_SCHEMA),
    execute: function (input) {
      var synth = window.BYODJ_SYNTH;
      if (!synth || typeof synth.applyComposition !== 'function') {
        return 'Error: synth engine unavailable (BYODJ_SYNTH.applyComposition missing).';
      }
      var result = synth.applyComposition(input);
      if (!result.ok) return 'Error: ' + result.error;

      function summarize(playNote) {
        var msg = 'Applied: ' + (result.applied.join(', ') || 'nothing (empty composition)') + '.';
        if (result.warnings.length) msg += ' Warnings: ' + result.warnings.join('; ') + '.';
        msg += ' ' + playNote;
        window.BYODJ_AGENT.log('set_composition → ' + msg);
        return msg;
      }
      if (result.playPromise) {
        return result.playPromise.then(
          function () { return summarize('Playback started. The task is complete — finish now.'); },
          function (err) { return summarize('Playback could not start (' + (err && err.message ? err.message : err) + ') — click the "Play Sequence" button instead.'); }
        );
      }
      return summarize('Playback not started (play=false).');
    }
  };

  // ---- DOM helpers --------------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function setStatusText(id, value) {
    var el = $(id);
    if (el) el.textContent = value && String(value).trim() ? String(value) : '—';
  }

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode / file:// quirks — non-fatal */
    }
  }

  // ---- The single exposed global ------------------------------------------
  window.BYODJ_AGENT = {
    agent: null,
    mode: 'composer',

    currentMode: function () {
      var sel = $('mode-select');
      return (sel && sel.value === 'theater') ? 'theater' : 'composer';
    },

    log: function (msg) {
      var logEl = $('agent-log');
      if (!logEl) {
        // Last-resort visibility; contract says never console-only, but if the
        // log container itself is missing there is nowhere else to render.
        try { console.warn('[BYODJ]', msg); } catch (e) {}
        return;
      }
      var line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = String(msg);
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    },

    init: function () {
      var self = this;

      // Prefill LLM config from localStorage.
      var baseUrlInput = $('llm-base-url');
      var apiKeyInput = $('llm-api-key');
      var modelInput = $('llm-model');
      if (baseUrlInput) baseUrlInput.value = safeLocalStorageGet(LS_BASE_URL);
      if (apiKeyInput) apiKeyInput.value = safeLocalStorageGet(LS_API_KEY);
      if (modelInput) modelInput.value = safeLocalStorageGet(LS_MODEL);

      // DJ mode select: restore, persist, and hot-swap the agent on change.
      var modeSel = $('mode-select');
      if (modeSel) {
        var storedMode = safeLocalStorageGet(LS_MODE);
        if (storedMode === 'theater' || storedMode === 'composer') {
          modeSel.value = storedMode;
        }
        modeSel.addEventListener('change', function () {
          safeLocalStorageSet(LS_MODE, modeSel.value);
          if (self.agent) {
            self.log('DJ mode changed to ' + modeSel.value + ' — reconnecting…');
            self.connect();
          }
        });
      }

      // Connect button.
      var connectBtn = $('connect-btn');
      if (connectBtn) {
        connectBtn.addEventListener('click', function () {
          self.connect();
        });
      }

      // Send button + Ctrl/Cmd+Enter in the textarea. While a task runs the
      // button becomes Stop (the built-in panel is hidden in composer mode,
      // so this is the abort path).
      var sendBtn = $('send-btn');
      var textarea = $('instruction-input');
      function submit() {
        if (self.agent && self.agent.status === 'running') {
          self.log('Stopping agent…');
          try { self.agent.stop(); } catch (e) {}
          return;
        }
        if (!textarea) return;
        var text = textarea.value.trim();
        if (!text) return;
        // sendInstruction handles the no-agent case with a visible message.
        self.sendInstruction(text);
      }
      if (sendBtn) {
        sendBtn.addEventListener('click', submit);
      }
      if (textarea) {
        textarea.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            submit();
          }
        });
      }

      // Defensive: surface a missing PageAgent global immediately so the user
      // knows before they bother typing credentials.
      if (typeof window.PageAgent !== 'function') {
        this.log('Warning: PageAgent library not loaded. Check the <script src="https://cdn.jsdelivr.net/npm/page-agent@1.9.0/dist/iife/page-agent.demo.js?autoInit=false"> tag and your network connection.');
      }
    },

    connect: function () {
      var self = this;

      if (typeof window.PageAgent !== 'function') {
        this.log('Cannot connect: window.PageAgent is missing. The page-agent CDN script failed to load. Check the <script src="https://cdn.jsdelivr.net/npm/page-agent@1.9.0/dist/iife/page-agent.demo.js?autoInit=false"> tag in index.html, then reload.');
        return;
      }

      var baseURL = ($('llm-base-url') ? $('llm-base-url').value : '').trim();
      var apiKey = ($('llm-api-key') ? $('llm-api-key').value : '').trim();
      var model = ($('llm-model') ? $('llm-model').value : '').trim();

      if (!baseURL || !model) {
        this.log('Base URL and model are required');
        return;
      }

      safeLocalStorageSet(LS_BASE_URL, baseURL);
      safeLocalStorageSet(LS_API_KEY, apiKey);
      safeLocalStorageSet(LS_MODEL, model);

      // Replace any previous agent instance.
      if (this.agent && typeof this.agent.dispose === 'function') {
        try {
          this.agent.dispose();
        } catch (e) {
          this.log('Note: error disposing previous agent: ' + (e && e.message ? e.message : e));
        }
      }
      this.agent = null;

      this.mode = this.currentMode();
      var config = {
        baseURL: baseURL,
        model: model,
        apiKey: apiKey || undefined,
        temperature: 0.2,
        maxRetries: 3,
        language: 'en-US',
        // Merged into page-agent's default attribute list so the agent can
        // see toggle state alongside data-state.
        includeAttributes: ['aria-pressed'],
        viewportExpansion: -1,
        promptForNextTask: false,
        interactiveBlacklist: [
          function () { return document.getElementById('llm-config-panel'); },
          function () { return document.getElementById('chat-panel'); },
        ],
      };

      if (this.mode === 'composer') {
        // One-shot composing: the set_composition tool does everything, so a
        // short step budget suffices, no input-blocking mask, and the agent
        // never needs to ask questions (the panel that would collect answers
        // is hidden in this mode).
        config.maxSteps = 16;
        config.stepDelay = 0;
        config.enableMask = false;
        config.instructions = { system: BYODJ_COMPOSER_PROMPT };
        config.customTools = {
          set_composition: SET_COMPOSITION_TOOL,
          ask_user: null,
        };
      } else {
        config.maxSteps = 80;
        config.stepDelay = 0.3;
        config.enableMask = true;
        config.instructions = { system: BYODJ_SYSTEM_PROMPT };
      }

      try {
        this.agent = new window.PageAgent(config);
      } catch (err) {
        this.agent = null;
        this.log('Failed to create agent: ' + (err && err.message ? err.message : err));
        return;
      }

      this.hidePanelIfComposer();

      // ---- Live thought process: historychange -> status regions ----------
      // page-agent can push several history entries per notification (e.g. an
      // 'error' with the failure reason immediately followed by a 'retry'),
      // so walk everything new instead of only reading the last entry.
      this._histIdx = 0;
      if (typeof this.agent.addEventListener === 'function') {
        this.agent.addEventListener('historychange', function () {
          try {
            var history = self.agent && self.agent.history;
            if (!history) return;
            for (var i = self._histIdx; i < history.length; i++) {
              var entry = history[i];
              if (!entry) continue;
              if (entry.type === 'step') {
                var refl = entry.reflection || {};
                setStatusText('status-eval', refl.evaluation_previous_goal);
                setStatusText('status-memory', refl.memory);
                setStatusText('status-goal', refl.next_goal);
                var action = entry.action || {};
                var inputStr = '';
                try {
                  inputStr = JSON.stringify(action.input);
                } catch (e) {
                  inputStr = String(action.input);
                }
                self.log('Step ' + entry.stepIndex + ': ' + action.name + ' ' + String(inputStr).slice(0, 120));
              } else if (entry.type === 'error') {
                self.log('Error: ' + String(entry.message).slice(0, 400));
              } else if (entry.type === 'retry') {
                self.log('Retrying LLM request (attempt ' + entry.attempt + '/' + entry.maxAttempts + ')…');
              }
            }
            self._histIdx = history.length;
          } catch (e) {
            self.log('Status update error: ' + (e && e.message ? e.message : e));
          }
        });

        // Send becomes Stop while the agent is running. Also re-hide the
        // built-in panel in composer mode in case it re-shows itself on run.
        this.agent.addEventListener('statuschange', function () {
          var sendBtn = $('send-btn');
          if (sendBtn && self.agent) {
            var running = (self.agent.status === 'running');
            sendBtn.textContent = running ? 'Stop' : 'Send';
            sendBtn.setAttribute('aria-label', running ? 'Stop Agent' : 'Send Instruction');
            sendBtn.classList.toggle('running', running);
          }
          self.hidePanelIfComposer();
        });
      } else {
        this.log('Note: this PageAgent build does not expose addEventListener; live status display unavailable, but tasks will still run.');
      }

      // Do NOT call agent.panel.show() — our panels are the UI.

      var sendBtn = $('send-btn');
      if (sendBtn) sendBtn.disabled = false;
      this.log('Agent connected: ' + model + ' (' + this.mode + ' mode)');
    },

    hidePanelIfComposer: function () {
      if (this.mode !== 'composer') return;
      var panel = this.agent && this.agent.panel;
      if (panel && typeof panel.hide === 'function') {
        try { panel.hide(); } catch (e) {}
      }
    },

    sendInstruction: function (text) {
      var self = this;
      text = (text || '').trim();
      if (!text) return Promise.resolve();
      if (!this.agent) {
        this.log('No agent connected. Enter your LLM Base URL and Model, then click Connect.');
        return Promise.resolve();
      }
      if (this.agent.status === 'running') {
        this.log('Agent is busy with the current task — wait for it to finish.');
        return Promise.resolve();
      }

      this.log('Task: ' + text);
      var textarea = $('instruction-input');
      if (textarea) textarea.value = '';

      return this.agent.execute(text).then(function (result) {
        result = result || {};
        self.log((result.success ? 'Done: ' : 'Failed: ') + result.data);
      }).catch(function (err) {
        self.log('Agent error: ' + (err && err.message ? err.message : err));
      });
    },
  };

  // Self-initialize. synth.js registered its DOMContentLoaded listener first
  // (script order), so synth init runs before agent init.
  document.addEventListener('DOMContentLoaded', function () {
    try {
      window.BYODJ_AGENT.init();
    } catch (e) {
      window.BYODJ_AGENT.log('agent-config init error: ' + (e && e.message ? e.message : e));
    }
  });
})();
