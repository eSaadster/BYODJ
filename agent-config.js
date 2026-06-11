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

  // ---- Pinned system prompt (additive via instructions.system) -----------
  var BYODJ_SYSTEM_PROMPT = `
You are operating BYODJ, a music synthesizer web page. You compose music by manipulating its controls. You cannot hear audio; reason from control values and music theory.

PAGE LAYOUT:
- Step sequencer: 16 steps x 8 rows of toggle buttons labeled "{name} step {s}" (e.g. "Kick step 0", "ClosedHat step 12"). A step plays when toggled on: the cell shows data-state=on (off cells show data-state=off). Steps 0-15 run left to right in time; steps 0,4,8,12 are the beats. Rows: 0=Kick, 1=Bass, 2=Snare, 3=ClosedHat, 4=OpenHat, 5=LeadRoot, 6=LeadThird, 7=LeadFifth. Rows 5-7 are melodic notes from the selected scale and root; toggling multiple of rows 5-7 on the same step makes a chord. Click a cell button once to toggle it.
- Sliders (set with input_text, a plain number within the labeled range): Tempo (BPM) 60-200, Filter Cutoff (Hz) 100-10000 (low=dark/muffled, high=bright), Filter Resonance (Q) 0-20, Envelope Attack/Decay/Release in seconds and Sustain 0-1 (long attack+release=pads, short=plucky), Reverb Amount 0-1 (space), Delay Amount 0-1 (echo), Distortion Amount 0-1 (grit).
- Dropdowns: Lead Waveform (sine=soft, triangle=mellow, square=hollow/chiptune, sawtooth=bright/aggressive), Scale (major=happy, minor=sad, dorian=jazzy, phrygian=dark/exotic, pentatonic=bluesy/safe), Root Note (C..B).
- Transport buttons: "Play Sequence", "Stop Sequence", "Clear Grid", "Randomize Grid".

RULES:
1. Translate the user's mood/genre into concrete settings: pick tempo, scale, root, waveform, effects FIRST, then program the grid.
2. Typical patterns: kick on steps 0,4,8,12; snare on 4,12; closed hats on even steps; bass locked with kick; melody sparse (4-8 cells across rows 5-7).
3. To change a cell you must click its button; verify your click by re-reading the cell's data-state (on/off).
4. Use "Clear Grid" before programming a completely new pattern; keep existing cells when the user asks for a tweak.
5. ALWAYS click the "Play Sequence" button as your final action before calling done, so the user hears the result. The Play button shows data-state=playing while the sequence runs (data-state=stopped otherwise).
`.trim();

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

      // Connect button.
      var connectBtn = $('connect-btn');
      if (connectBtn) {
        connectBtn.addEventListener('click', function () {
          self.connect();
        });
      }

      // Send button + Ctrl/Cmd+Enter in the textarea.
      var sendBtn = $('send-btn');
      var textarea = $('instruction-input');
      function submit() {
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

      try {
        this.agent = new window.PageAgent({
          baseURL: baseURL,
          model: model,
          apiKey: apiKey || undefined,
          temperature: 0.2,
          maxRetries: 3,
          language: 'en-US',
          maxSteps: 80,
          stepDelay: 0.3,
          // Merged into page-agent's default attribute list so the agent can
          // see toggle state alongside data-state.
          includeAttributes: ['aria-pressed'],
          enableMask: true,
          viewportExpansion: -1,
          promptForNextTask: false,
          interactiveBlacklist: [
            function () { return document.getElementById('llm-config-panel'); },
            function () { return document.getElementById('chat-panel'); },
          ],
          instructions: { system: BYODJ_SYSTEM_PROMPT },
        });
      } catch (err) {
        this.agent = null;
        this.log('Failed to create agent: ' + (err && err.message ? err.message : err));
        return;
      }

      // ---- Live thought process: historychange -> status regions ----------
      if (typeof this.agent.addEventListener === 'function') {
        this.agent.addEventListener('historychange', function () {
          try {
            var history = self.agent && self.agent.history;
            if (!history || !history.length) return;
            var last = (typeof history.at === 'function')
              ? history.at(-1)
              : history[history.length - 1];
            if (!last) return;

            if (last.type === 'step') {
              var refl = last.reflection || {};
              setStatusText('status-eval', refl.evaluation_previous_goal);
              setStatusText('status-memory', refl.memory);
              setStatusText('status-goal', refl.next_goal);
              var action = last.action || {};
              var inputStr = '';
              try {
                inputStr = JSON.stringify(action.input);
              } catch (e) {
                inputStr = String(action.input);
              }
              self.log('Step ' + last.stepIndex + ': ' + action.name + ' ' + String(inputStr).slice(0, 120));
            } else if (last.type === 'error') {
              self.log('Error: ' + last.message);
            }
          } catch (e) {
            self.log('Status update error: ' + (e && e.message ? e.message : e));
          }
        });

        // Transient activity: surface retries (rate limits, flaky endpoints).
        this.agent.addEventListener('activity', function (event) {
          try {
            var detail = event && event.detail;
            if (detail && detail.type === 'retrying') {
              self.log('Retrying LLM request (attempt ' + detail.attempt + '/' + detail.maxAttempts + ')…');
            }
          } catch (e) {
            /* transient feedback only — never fatal */
          }
        });

        // Disable Send while the agent is running.
        this.agent.addEventListener('statuschange', function () {
          var sendBtn = $('send-btn');
          if (sendBtn && self.agent) {
            sendBtn.disabled = (self.agent.status === 'running');
          }
        });
      } else {
        this.log('Note: this PageAgent build does not expose addEventListener; live status display unavailable, but tasks will still run.');
      }

      // Do NOT call agent.panel.show() — our panels are the UI.

      var sendBtn = $('send-btn');
      if (sendBtn) sendBtn.disabled = false;
      this.log('Agent connected: ' + model);
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
