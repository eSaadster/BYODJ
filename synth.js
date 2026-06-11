/* ============================================================
 * BYODJ — synth.js
 * Audio engine + sequencer grid + all synth-control DOM wiring.
 * Exposes exactly one global: window.BYODJ_SYNTH
 * Classic script (no modules) — loaded after Tone.js CDN bundle.
 * ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------- constants

  var NUM_ROWS = 8;
  var NUM_STEPS = 16;

  var ROW_NAMES = [
    'Kick', 'Bass', 'Snare', 'Closed Hat',
    'Open Hat', 'Lead Root', 'Lead Third', 'Lead Fifth'
  ];

  // Per-row probability that a cell turns on in randomizeGrid()
  var RANDOM_PROBS = [0.25, 0.25, 0.2, 0.5, 0.15, 0.25, 0.25, 0.25];

  var SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    dorian:     [0, 2, 3, 5, 7, 9, 10],
    phrygian:   [0, 1, 3, 5, 7, 8, 10],
    pentatonic: [0, 3, 5, 7, 10]
  };

  // Melodic rows -> scale degree (index into the scale's interval array).
  // 7-note scales: index 2 = third, index 4 = fifth.
  var ROW_DEGREE = { 5: 0, 6: 2, 7: 4 };
  // Pentatonic [0,3,5,7,10]: index 1 = 3 semitones (third), index 3 = 7 (fifth).
  var ROW_DEGREE_PENTA = { 5: 0, 6: 1, 7: 3 };

  // Short names used in aria-labels — must stay <= 20 chars total per label
  // ("{name} step {s}") because page-agent truncates attribute values at 20.
  var ROW_LABEL_NAMES = [
    'Kick', 'Bass', 'Snare', 'ClosedHat',
    'OpenHat', 'LeadRoot', 'LeadThird', 'LeadFifth'
  ];

  // Row keys accepted by applyComposition()'s pattern object, index-aligned
  // with the grid rows.
  var ROW_KEYS = [
    'kick', 'bass', 'snare', 'closedHat',
    'openHat', 'leadRoot', 'leadThird', 'leadFifth'
  ];

  // ---------------------------------------------------------- state

  // grid[row][step] = boolean
  var grid = [];
  for (var r = 0; r < NUM_ROWS; r++) {
    var rowArr = [];
    for (var s = 0; s < NUM_STEPS; s++) rowArr.push(false);
    grid.push(rowArr);
  }

  var step = 0;            // current sequencer step
  var prevDrawnStep = -1;  // last column highlighted with .playhead
  var currentScale = 'minor';
  var currentRoot = 'C';

  // Tone nodes (created in init)
  var kick, bass, snare, hatClosed, hatOpen, poly;
  var filter, dist, delay, reverb;
  var repeatId = null;
  var initialized = false;

  // ---------------------------------------------------------- helpers

  function cellEl(row, st) {
    return document.getElementById('cell-r' + row + '-s' + st);
  }

  function syncCellDom(row, st) {
    var el = cellEl(row, st);
    if (!el) return;
    var on = grid[row][st];
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    // data-state is serialized by page-agent (aria-pressed/class are not),
    // so this is the attribute the LLM agent reads to see cell state.
    el.dataset.state = on ? 'on' : 'off';
    el.classList.toggle('on', on);
  }

  function syncAllCells() {
    for (var r = 0; r < NUM_ROWS; r++) {
      for (var s = 0; s < NUM_STEPS; s++) syncCellDom(r, s);
    }
  }

  function noteForRow(r) {
    var degrees = (currentScale === 'pentatonic') ? ROW_DEGREE_PENTA : ROW_DEGREE;
    var d = degrees[r];
    var intervals = SCALES[currentScale] || SCALES.minor;
    var semitones = intervals[d % intervals.length] +
      12 * Math.floor(d / intervals.length);
    return Tone.Frequency(currentRoot + '4').transpose(semitones).toNote();
  }

  function clearPlayhead() {
    var cells = document.querySelectorAll('#sequencer-grid .cell.playhead');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('playhead');
    prevDrawnStep = -1;
  }

  function highlightColumn(st) {
    var r, el;
    if (prevDrawnStep >= 0 && prevDrawnStep !== st) {
      for (r = 0; r < NUM_ROWS; r++) {
        el = cellEl(r, prevDrawnStep);
        if (el) el.classList.remove('playhead');
      }
    }
    for (r = 0; r < NUM_ROWS; r++) {
      el = cellEl(r, st);
      if (el) el.classList.add('playhead');
    }
    prevDrawnStep = st;
  }

  // ---------------------------------------------------------- grid DOM

  function buildGrid() {
    var container = document.getElementById('sequencer-grid');
    if (!container) {
      console.error('BYODJ_SYNTH: #sequencer-grid not found');
      return;
    }
    container.textContent = ''; // ensure empty

    for (var r = 0; r < NUM_ROWS; r++) {
      var label = document.createElement('span');
      label.className = 'row-label';
      label.textContent = ROW_NAMES[r];
      container.appendChild(label);

      for (var s = 0; s < NUM_STEPS; s++) {
        var btn = document.createElement('button');
        btn.id = 'cell-r' + r + '-s' + s;
        btn.className = 'cell';
        btn.type = 'button';
        btn.dataset.row = String(r);
        btn.dataset.step = String(s);
        btn.setAttribute('aria-pressed', 'false');
        btn.dataset.state = 'off';
        // Keep labels <= 20 chars (page-agent truncates attribute values).
        btn.setAttribute('aria-label', ROW_LABEL_NAMES[r] + ' step ' + s);
        container.appendChild(btn);
      }
    }

    // One delegated click listener for all 128 cells
    container.addEventListener('click', function (ev) {
      var target = ev.target;
      if (!(target instanceof Element)) return;
      var cell = target.closest('.cell');
      if (!cell || !container.contains(cell)) return;
      var row = parseInt(cell.dataset.row, 10);
      var st = parseInt(cell.dataset.step, 10);
      if (isNaN(row) || isNaN(st)) return;
      api.toggleCell(row, st);
    });
  }

  // ---------------------------------------------------------- audio graph

  function buildAudio() {
    kick = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4 }
    }).toDestination();

    bass = new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.5, sustain: 0.1, release: 0.8 }
    }).toDestination();

    snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0 }
    }).toDestination();

    hatClosed = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0 }
    }).toDestination();

    hatOpen = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.3, sustain: 0 }
    }).toDestination();

    poly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.8 }
    });
    poly.maxPolyphony = 16;
    poly.volume.value = -6;

    filter = new Tone.Filter(2000, 'lowpass', -24);
    dist = new Tone.Distortion(0);
    // True bypass at slider=0: Distortion's waveshaper attenuates even at
    // amount 0 (clean signal scaled to ~1/3), so keep wet at 0 until used.
    dist.wet.value = 0;
    delay = new Tone.FeedbackDelay('8n', 0.35);
    delay.wet.value = 0.15;
    reverb = new Tone.Reverb({ decay: 3, preDelay: 0.01, wet: 0.2 });
    // Reverb generates its impulse response async; fire-and-forget.
    reverb.ready.catch(function (err) {
      console.error('BYODJ_SYNTH: reverb IR generation failed', err);
    });

    poly.chain(filter, dist, delay, reverb, Tone.getDestination());

    var transport = Tone.getTransport();
    transport.bpm.value = 120;

    repeatId = transport.scheduleRepeat(function (time) {
      var st = step;

      if (grid[0][st]) kick.triggerAttackRelease('C1', '16n', time, 0.9);
      if (grid[1][st]) bass.triggerAttackRelease(currentRoot + '1', '16n', time, 0.9);
      if (grid[2][st]) snare.triggerAttackRelease('16n', time, 0.9);
      if (grid[3][st]) hatClosed.triggerAttackRelease('16n', time, 0.9);
      if (grid[4][st]) hatOpen.triggerAttackRelease('16n', time, 0.9);
      for (var r = 5; r < 8; r++) {
        if (grid[r][st]) {
          poly.triggerAttackRelease(noteForRow(r), '16n', time, 0.8);
        }
      }

      Tone.getDraw().schedule(function () { highlightColumn(st); }, time);

      step = (step + 1) % NUM_STEPS;
    }, '16n');
  }

  // ---------------------------------------------------------- control wiring

  function wireSlider(id, handler) {
    var input = document.getElementById(id);
    if (!input) {
      console.error('BYODJ_SYNTH: #' + id + ' not found');
      return;
    }
    var output = document.getElementById(id + '-value');
    var apply = function () {
      var v = parseFloat(input.value);
      // Keep the serialized HTML attribute in sync with the live property so
      // page-agent (which reads attributes via getAttribute) sees the value.
      input.setAttribute('value', input.value);
      if (output) output.value = input.value;
      if (!isNaN(v)) handler(v);
    };
    input.addEventListener('input', apply);
    // Sync the <output> and value attribute with the initial value.
    input.setAttribute('value', input.value);
    if (output) output.value = input.value;
  }

  // Programmatically set a range input through its normal input event so the
  // existing wiring updates the audio engine, <output>, and serialized value
  // attribute together. Returns the (clamped) applied value, or null if the
  // control is missing.
  function setRangeControl(id, v) {
    var input = document.getElementById(id);
    if (!input) return null;
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    if (!isNaN(min)) v = Math.max(min, v);
    if (!isNaN(max)) v = Math.min(max, v);
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return parseFloat(input.value);
  }

  // Returns the value if applied, null if the control is missing, undefined
  // if the value is not one of the select's options.
  function setSelectControl(id, v) {
    var sel = document.getElementById(id);
    if (!sel) return null;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) {
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return v;
      }
    }
    return undefined;
  }

  function wireSelect(id, handler) {
    var sel = document.getElementById(id);
    if (!sel) {
      console.error('BYODJ_SYNTH: #' + id + ' not found');
      return;
    }
    sel.addEventListener('change', function () { handler(sel.value); });
  }

  function wireButton(id, handler) {
    var btn = document.getElementById(id);
    if (!btn) {
      console.error('BYODJ_SYNTH: #' + id + ' not found');
      return;
    }
    btn.addEventListener('click', handler);
  }

  function wireControls() {
    wireSlider('tempo-slider',      function (v) { api.setTempo(v); });
    wireSlider('filter-cutoff',     function (v) { api.setFilterCutoff(v); });
    wireSlider('filter-resonance',  function (v) { api.setFilterResonance(v); });
    wireSlider('env-attack',        function (v) { api.setEnvelope({ attack: v }); });
    wireSlider('env-decay',         function (v) { api.setEnvelope({ decay: v }); });
    wireSlider('env-sustain',       function (v) { api.setEnvelope({ sustain: v }); });
    wireSlider('env-release',       function (v) { api.setEnvelope({ release: v }); });
    wireSlider('reverb-wet',        function (v) { api.setReverbWet(v); });
    wireSlider('delay-wet',         function (v) { api.setDelayWet(v); });
    wireSlider('distortion-amount', function (v) { api.setDistortion(v); });

    wireSelect('waveform-select', function (v) { api.setWaveform(v); });
    wireSelect('scale-select',    function (v) { api.setScale(v); });
    wireSelect('root-select',     function (v) { api.setRootNote(v); });

    var playBtnEl = document.getElementById('play-btn');
    if (playBtnEl) playBtnEl.dataset.state = 'stopped';
    wireButton('play-btn',   function () { api.play(); });
    wireButton('stop-btn',   function () { api.stop(); });
    wireButton('clear-btn',  function () { api.clearGrid(); });
    wireButton('random-btn', function () { api.randomizeGrid(); });

    // Initialize scale/root from current select values (contract defaults:
    // minor / C — but read the DOM in case markup differs).
    var scaleSel = document.getElementById('scale-select');
    if (scaleSel && SCALES[scaleSel.value]) currentScale = scaleSel.value;
    var rootSel = document.getElementById('root-select');
    if (rootSel && rootSel.value) currentRoot = rootSel.value;
  }

  // ---------------------------------------------------------- public API

  var api = {
    init: function () {
      if (initialized) return;
      if (typeof Tone === 'undefined') {
        console.error('BYODJ_SYNTH: Tone.js is not loaded — audio engine disabled.');
        return;
      }
      initialized = true;
      buildGrid();
      buildAudio();
      wireControls();
    },

    play: function () {
      if (!initialized) return Promise.resolve();
      // Tone.start() must be awaited inside the user-gesture call stack.
      return Tone.start().then(function () {
        var transport = Tone.getTransport();
        step = 0;
        transport.position = 0;
        clearPlayhead();
        transport.start();
        // Serialized transport state so the agent can verify playback.
        var playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.dataset.state = 'playing';
      });
    },

    stop: function () {
      if (!initialized) return;
      Tone.getTransport().stop();
      // Cancel Draw events already queued within the audio lookahead window,
      // otherwise a pending highlightColumn re-adds .playhead after we clear.
      Tone.getDraw().cancel();
      clearPlayhead();
      var playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.dataset.state = 'stopped';
    },

    isPlaying: function () {
      if (!initialized) return false;
      return Tone.getTransport().state === 'started';
    },

    toggleCell: function (row, st) {
      if (row < 0 || row >= NUM_ROWS || st < 0 || st >= NUM_STEPS) return false;
      grid[row][st] = !grid[row][st];
      syncCellDom(row, st);
      return grid[row][st];
    },

    clearGrid: function () {
      for (var r = 0; r < NUM_ROWS; r++) {
        for (var s = 0; s < NUM_STEPS; s++) grid[r][s] = false;
      }
      syncAllCells();
    },

    randomizeGrid: function () {
      for (var r = 0; r < NUM_ROWS; r++) {
        for (var s = 0; s < NUM_STEPS; s++) {
          grid[r][s] = Math.random() < RANDOM_PROBS[r];
        }
      }
      syncAllCells();
    },

    getGridState: function () {
      return grid.map(function (row) { return row.slice(); });
    },

    setTempo: function (bpm) {
      if (!initialized) return;
      Tone.getTransport().bpm.rampTo(bpm, 0.1);
    },

    setFilterCutoff: function (hz) {
      if (!filter) return;
      filter.frequency.rampTo(hz, 0.05);
    },

    setFilterResonance: function (q) {
      if (!filter) return;
      filter.Q.rampTo(q, 0.05);
    },

    setEnvelope: function (partial) {
      if (!poly || !partial) return;
      poly.set({ envelope: partial });
    },

    setWaveform: function (type) {
      if (!poly) return;
      poly.set({ oscillator: { type: type } });
    },

    setReverbWet: function (v) {
      if (!reverb) return;
      reverb.wet.rampTo(v, 0.05);
    },

    setDelayWet: function (v) {
      if (!delay) return;
      delay.wet.rampTo(v, 0.05);
    },

    setDistortion: function (v) {
      if (!dist) return;
      // Keep wet at 0 when the amount is 0 so the bottom of the slider is a
      // true bypass (Distortion's curve attenuates even at amount 0).
      dist.wet.rampTo(v > 0 ? 1 : 0, 0.05);
      dist.distortion = v;
    },

    setScale: function (name) {
      if (SCALES[name]) currentScale = name;
      // Notes are computed lazily at trigger time — nothing else to do.
    },

    setRootNote: function (name) {
      if (typeof name === 'string' && name) currentRoot = name;
      // Notes are computed lazily at trigger time.
    },

    // One-shot composition apply, used by the agent's set_composition tool in
    // composer mode. Drives the same DOM controls a human would, so outputs,
    // serialized attributes, and the audio engine stay in sync. All fields
    // are optional; pattern rows that are present replace that row entirely,
    // absent rows are left untouched.
    applyComposition: function (comp) {
      if (!initialized) {
        return { ok: false, error: 'Synth not initialized (is Tone.js loaded?)' };
      }
      if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
        return { ok: false, error: 'Composition must be a JSON object' };
      }

      var applied = [];
      var warnings = [];

      function slider(id, v, label) {
        if (v === undefined || v === null) return;
        if (typeof v !== 'number' || !isFinite(v)) {
          warnings.push(label + ': not a number, ignored');
          return;
        }
        var set = setRangeControl(id, v);
        if (set === null) warnings.push(label + ': control missing');
        else applied.push(label + '=' + set);
      }

      function select(id, v, label) {
        if (v === undefined || v === null) return;
        var set = setSelectControl(id, String(v));
        if (set === null) warnings.push(label + ': control missing');
        else if (set === undefined) warnings.push(label + ': "' + v + '" is not a valid option, ignored');
        else applied.push(label + '=' + set);
      }

      if (comp.clearFirst) {
        api.clearGrid();
        applied.push('grid cleared');
      }

      if (comp.pattern && typeof comp.pattern === 'object' && !Array.isArray(comp.pattern)) {
        for (var r = 0; r < NUM_ROWS; r++) {
          var steps = comp.pattern[ROW_KEYS[r]];
          if (steps === undefined || steps === null) continue;
          if (!Array.isArray(steps)) {
            warnings.push('pattern.' + ROW_KEYS[r] + ': expected an array of step numbers 0-15');
            continue;
          }
          for (var s = 0; s < NUM_STEPS; s++) grid[r][s] = false;
          var count = 0;
          for (var i = 0; i < steps.length; i++) {
            var st = steps[i];
            if (typeof st === 'number' && st === Math.floor(st) && st >= 0 && st < NUM_STEPS) {
              grid[r][st] = true;
              count++;
            } else {
              warnings.push('pattern.' + ROW_KEYS[r] + ': step ' + JSON.stringify(st) + ' is not an integer 0-15, ignored');
            }
          }
          applied.push(ROW_KEYS[r] + ' ' + count + ' steps');
        }
        var unknown = Object.keys(comp.pattern).filter(function (k) {
          return ROW_KEYS.indexOf(k) === -1;
        });
        if (unknown.length) {
          warnings.push('unknown pattern rows ignored: ' + unknown.join(', ') + ' (valid rows: ' + ROW_KEYS.join(', ') + ')');
        }
        syncAllCells();
      }

      slider('tempo-slider', comp.tempo, 'tempo');
      slider('filter-cutoff', comp.filterCutoff, 'filterCutoff');
      slider('filter-resonance', comp.filterResonance, 'filterResonance');
      if (comp.envelope && typeof comp.envelope === 'object') {
        slider('env-attack', comp.envelope.attack, 'attack');
        slider('env-decay', comp.envelope.decay, 'decay');
        slider('env-sustain', comp.envelope.sustain, 'sustain');
        slider('env-release', comp.envelope.release, 'release');
      }
      slider('reverb-wet', comp.reverb, 'reverb');
      slider('delay-wet', comp.delay, 'delay');
      slider('distortion-amount', comp.distortion, 'distortion');

      select('waveform-select', comp.waveform, 'waveform');
      select('scale-select', comp.scale, 'scale');
      select('root-select', comp.root, 'root');

      var playPromise = (comp.play !== false) ? api.play() : null;

      return { ok: true, applied: applied, warnings: warnings, playPromise: playPromise };
    }
  };

  window.BYODJ_SYNTH = api;

  document.addEventListener('DOMContentLoaded', function () {
    api.init();
  });
})();
