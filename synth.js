/* ============================================================
 * BYODJ — synth.js
 * Audio engine + sequencer grid + all synth-control DOM wiring.
 * Exposes exactly one global: window.BYODJ_SYNTH
 * Classic script (no modules) — loaded after Tone.js CDN bundle.
 * ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------- constants

  var NUM_ROWS = 10;
  var NUM_STEPS = 16;

  var ROW_NAMES = [
    'Kick', 'Bass', 'Snare', 'Closed Hat',
    'Open Hat', 'Lead Root', 'Lead Third', 'Lead Fifth',
    'Lead 7th', 'Lead Oct'
  ];

  // Per-row probability that a cell turns on in randomizeGrid()
  var RANDOM_PROBS = [0.25, 0.25, 0.2, 0.5, 0.15, 0.25, 0.25, 0.25, 0.15, 0.12];

  var SCALES = {
    major:         [0, 2, 4, 5, 7, 9, 11],
    minor:         [0, 2, 3, 5, 7, 8, 10],
    dorian:        [0, 2, 3, 5, 7, 9, 10],
    phrygian:      [0, 1, 3, 5, 7, 8, 10],
    lydian:        [0, 2, 4, 6, 7, 9, 11],
    mixolydian:    [0, 2, 4, 5, 7, 9, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    blues:         [0, 3, 5, 6, 7, 10],
    pentatonic:    [0, 3, 5, 7, 10]
  };

  // Melodic rows -> scale degree (index into the scale's interval array).
  // 7-note scales: index 2 = third, 4 = fifth, 6 = seventh, 7 wraps to +12.
  var ROW_DEGREE = { 5: 0, 6: 2, 7: 4, 8: 6, 9: 7 };
  // Pentatonic [0,3,5,7,10]: 1 = third-ish, 3 = fifth, 4 = seventh, 5 = +12.
  var ROW_DEGREE_PENTA = { 5: 0, 6: 1, 7: 3, 8: 4, 9: 5 };
  // Blues [0,3,5,6,7,10]: 1 = b3, 4 = fifth, 5 = b7, 6 wraps to +12.
  var ROW_DEGREE_BLUES = { 5: 0, 6: 1, 7: 4, 8: 5, 9: 6 };

  // Short names used in aria-labels — must stay <= 20 chars total per label
  // ("{name} step {s}") because page-agent truncates attribute values at 20.
  var ROW_LABEL_NAMES = [
    'Kick', 'Bass', 'Snare', 'ClosedHat',
    'OpenHat', 'LeadRoot', 'LeadThird', 'LeadFifth',
    'LeadSeventh', 'LeadHigh'
  ];

  // Row keys accepted by applyComposition()'s pattern object, index-aligned
  // with the grid rows. (Row 9 is 'leadHigh', not 'leadOctave', to avoid
  // colliding with the top-level leadOctave composition field.)
  var ROW_KEYS = [
    'kick', 'bass', 'snare', 'closedHat',
    'openHat', 'leadRoot', 'leadThird', 'leadFifth',
    'leadSeventh', 'leadHigh'
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
  var bassSaw, bassAcid, chorus, pumpGain, crusher, djHP, djLP;
  var comp, masterVol, limiter;
  var channels = {};         // kick|bass|snare|hats|lead -> Tone.Channel
  var repeatId = null;
  var initialized = false;

  // Performance / sound-design state (read at trigger time)
  var pumpAmount = 0;
  var bassStyle = 'sub';     // 'sub' | 'saw' | 'acid'
  var kickNote = 'C1';       // re-voiced by setDrumKit()
  var leadNoteLen = '16n';   // '16n' | '8n' | '4n' | '2n'
  var leadOct = '4';         // '3' | '4' | '5'

  // Drum-kit voicing bundles applied via .set() — nodes are never rebuilt.
  var DRUM_KITS = {
    analog: {
      kick: { pitchDecay: 0.05, octaves: 6, envelope: { decay: 0.4, release: 1.4 } },
      kickNote: 'C1',
      snare: { noise: { type: 'white' }, envelope: { decay: 0.2 } },
      hatClosed: { noise: { type: 'white' }, envelope: { decay: 0.05 } },
      hatOpen: { noise: { type: 'white' }, envelope: { decay: 0.3 } }
    },
    '808': {
      kick: { pitchDecay: 0.1, octaves: 8, envelope: { decay: 0.8, release: 1.8 } },
      kickNote: 'A0',
      snare: { noise: { type: 'pink' }, envelope: { decay: 0.25 } },
      hatClosed: { noise: { type: 'white' }, envelope: { decay: 0.03 } },
      hatOpen: { noise: { type: 'white' }, envelope: { decay: 0.5 } }
    },
    '909': {
      kick: { pitchDecay: 0.03, octaves: 5, envelope: { decay: 0.3, release: 1.0 } },
      kickNote: 'C1',
      snare: { noise: { type: 'white' }, envelope: { decay: 0.15 } },
      hatClosed: { noise: { type: 'white' }, envelope: { decay: 0.06 } },
      hatOpen: { noise: { type: 'white' }, envelope: { decay: 0.25 } }
    },
    lofi: {
      kick: { pitchDecay: 0.08, octaves: 4, envelope: { decay: 0.3, release: 0.8 } },
      kickNote: 'C1',
      snare: { noise: { type: 'pink' }, envelope: { decay: 0.12 } },
      hatClosed: { noise: { type: 'pink' }, envelope: { decay: 0.04 } },
      hatOpen: { noise: { type: 'pink' }, envelope: { decay: 0.2 } }
    }
  };

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
    var degrees = (currentScale === 'blues') ? ROW_DEGREE_BLUES
      : (currentScale === 'pentatonic') ? ROW_DEGREE_PENTA
      : ROW_DEGREE;
    var d = degrees[r];
    var intervals = SCALES[currentScale] || SCALES.minor;
    var semitones = intervals[d % intervals.length] +
      12 * Math.floor(d / intervals.length);
    return Tone.Frequency(currentRoot + leadOct).transpose(semitones).toNote();
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

    // One delegated click listener for all 160 cells
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
    });

    // Membrane "sub" bass — one of three switchable bass voices (bassStyle).
    bass = new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.5, sustain: 0.1, release: 0.8 }
    });

    bassSaw = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      volume: -4,
      portamento: 0,
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.2 },
      filterEnvelope: {
        attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3,
        baseFrequency: 200, octaves: 3
      }
    });

    bassAcid = new Tone.MonoSynth({
      oscillator: { type: 'square' },
      volume: -4,
      portamento: 0.05,
      envelope: { attack: 0.003, decay: 0.15, sustain: 0.3, release: 0.1 },
      // Resonance lives on the filter options, NOT filterEnvelope (Tone's
      // FrequencyEnvelope silently drops unknown keys like Q).
      filter: { Q: 8, type: 'lowpass', rolloff: -12 },
      filterEnvelope: {
        attack: 0.005, decay: 0.15, sustain: 0.1, release: 0.1,
        baseFrequency: 300, octaves: 3.5
      }
    });

    snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0 }
    });

    hatClosed = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0 }
    });

    hatOpen = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.3, sustain: 0 }
    });

    poly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.8 }
    });
    poly.maxPolyphony = 24;
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

    // ---- mixer channels + master section (built once, never disposed;
    // everything afterwards is param-ramped or .set()) ----
    channels.kick  = new Tone.Channel(0);
    channels.bass  = new Tone.Channel(0);
    channels.snare = new Tone.Channel(0);
    channels.hats  = new Tone.Channel(0);
    channels.lead  = new Tone.Channel(0);

    chorus = new Tone.Chorus(4, 2.5, 0.5).start();
    chorus.wet.value = 0;
    pumpGain = new Tone.Gain(1);
    // Tone.BitCrusher is an AudioWorklet; worklet modules cannot load from
    // file:// (the documented zero-server launch path). A dead worklet in the
    // series master chain throws uncaught load errors and silences the mix at
    // any nonzero crush, so gate it and fall back to a transparent Gain.
    crusher = null;
    if (window.location.protocol !== 'file:') {
      try {
        crusher = new Tone.BitCrusher(4);
        crusher.wet.value = 0;
      } catch (e) {
        console.warn('BYODJ_SYNTH: BitCrusher creation failed, bitcrush disabled', e);
        crusher = null;
      }
    }
    if (!crusher) {
      crusher = new Tone.Gain(1); // passthrough stand-in; setCrush no-ops on it
      var crushMsg = 'Bitcrush disabled: AudioWorklets cannot load from file://. ' +
        'Serve the page over HTTP (e.g. `python3 -m http.server`) to enable the crush control.';
      console.warn('BYODJ_SYNTH: ' + crushMsg);
      if (window.BYODJ_AGENT && typeof window.BYODJ_AGENT.log === 'function') {
        try { window.BYODJ_AGENT.log(crushMsg); } catch (e2) {}
      }
      var crushInput = document.getElementById('crush-amount');
      if (crushInput) {
        crushInput.disabled = true;
        crushInput.title = crushMsg;
      }
    }
    djHP = new Tone.Filter(20, 'highpass', -12);
    djLP = new Tone.Filter(20000, 'lowpass', -12);
    comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.2 });
    masterVol = new Tone.Volume(0);
    limiter = new Tone.Limiter(-1);

    // Kick bypasses pumpGain so the sidechain pump never ducks the kick itself.
    kick.connect(channels.kick);
    channels.kick.connect(crusher);

    bass.connect(channels.bass);
    bassSaw.connect(channels.bass);
    bassAcid.connect(channels.bass);
    channels.bass.connect(pumpGain);

    snare.connect(channels.snare);
    channels.snare.connect(pumpGain);

    hatClosed.connect(channels.hats);
    hatOpen.connect(channels.hats);
    channels.hats.connect(pumpGain);

    poly.chain(filter, dist, chorus, delay, reverb, channels.lead);
    channels.lead.connect(pumpGain);

    pumpGain.chain(crusher, djHP, djLP, comp, masterVol, limiter, Tone.getDestination());

    var transport = Tone.getTransport();
    transport.bpm.value = 120;
    transport.swingSubdivision = '16n';

    repeatId = transport.scheduleRepeat(function (time) {
      var st = step;

      if (grid[0][st]) {
        kick.triggerAttackRelease(kickNote, '16n', time, 0.9);
        if (pumpAmount > 0) {
          // Sidechain pump: duck the mix bus on every kick, recover in 180ms.
          pumpGain.gain.cancelScheduledValues(time);
          pumpGain.gain.setValueAtTime(1 - 0.8 * pumpAmount, time);
          pumpGain.gain.linearRampToValueAtTime(1, time + 0.18);
        }
      }
      if (grid[1][st]) {
        var bassSynth = (bassStyle === 'saw') ? bassSaw
          : (bassStyle === 'acid') ? bassAcid
          : bass;
        bassSynth.triggerAttackRelease(currentRoot + '1', '16n', time, 0.9);
      }
      if (grid[2][st]) snare.triggerAttackRelease('16n', time, 0.9);
      if (grid[3][st]) hatClosed.triggerAttackRelease('16n', time, 0.9);
      if (grid[4][st]) hatOpen.triggerAttackRelease('16n', time, 0.9);
      for (var r = 5; r < 10; r++) {
        if (grid[r][st]) {
          poly.triggerAttackRelease(noteForRow(r), leadNoteLen, time, 0.8);
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
    if (!input || input.disabled) return null;
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

  // Toggle buttons keep their state in data-state="on"/"off" (serialized by
  // page-agent) and mirror it in aria-pressed. Each click flips the state and
  // calls handler(isOn).
  function wireToggle(id, handler) {
    var btn = document.getElementById(id);
    if (!btn) {
      console.error('BYODJ_SYNTH: #' + id + ' not found');
      return;
    }
    if (btn.dataset.state !== 'on' && btn.dataset.state !== 'off') {
      btn.dataset.state = 'off';
    }
    btn.setAttribute('aria-pressed', btn.dataset.state === 'on' ? 'true' : 'false');
    btn.addEventListener('click', function () {
      var isOn = btn.dataset.state !== 'on';
      btn.dataset.state = isOn ? 'on' : 'off';
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      handler(isOn);
    });
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

    // Mixer strips
    wireSlider('level-kick',  function (v) { api.setChannelVolume('kick', v); });
    wireSlider('level-bass',  function (v) { api.setChannelVolume('bass', v); });
    wireSlider('level-snare', function (v) { api.setChannelVolume('snare', v); });
    wireSlider('level-hats',  function (v) { api.setChannelVolume('hats', v); });
    wireSlider('level-lead',  function (v) { api.setChannelVolume('lead', v); });
    wireToggle('mute-kick',   function (on) { api.setChannelMute('kick', on); });
    wireToggle('mute-bass',   function (on) { api.setChannelMute('bass', on); });
    wireToggle('mute-snare',  function (on) { api.setChannelMute('snare', on); });
    wireToggle('mute-hats',   function (on) { api.setChannelMute('hats', on); });
    wireToggle('mute-lead',   function (on) { api.setChannelMute('lead', on); });

    // Master & groove
    wireSlider('master-volume', function (v) { api.setMasterVolume(v); });
    wireSlider('dj-filter',     function (v) { api.setDjFilter(v); });
    wireSlider('pump-amount',   function (v) { api.setPump(v); });
    wireSlider('crush-amount',  function (v) { api.setCrush(v); });
    wireSlider('swing-amount',  function (v) { api.setSwing(v); });

    // Sound design
    wireSelect('drum-kit',     function (v) { api.setDrumKit(v); });
    wireSelect('bass-style',   function (v) { api.setBassStyle(v); });
    wireSelect('lead-octave',  function (v) { api.setLeadOctave(v); });
    wireSelect('lead-notelen', function (v) { api.setLeadNoteLen(v); });
    wireSlider('glide-amount', function (v) { api.setGlide(v); });
    wireSlider('chorus-wet',   function (v) { api.setChorusWet(v); });

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

    setSwing: function (v) {
      if (!initialized) return;
      Tone.getTransport().swing = v;
    },

    setMasterVolume: function (db) {
      if (!masterVol) return;
      masterVol.volume.rampTo(db, 0.05);
    },

    // Bipolar DJ sweep: -100..0 = lowpass closes down to 150 Hz,
    // 0..100 = highpass rises up to 6 kHz, 0 = both filters open.
    setDjFilter: function (v) {
      if (!djHP || !djLP) return;
      if (v <= 0) {
        djHP.frequency.rampTo(20, 0.05);
        djLP.frequency.rampTo(
          v === 0 ? 20000 : 20000 * Math.pow(150 / 20000, -v / 100), 0.05);
      } else {
        djLP.frequency.rampTo(20000, 0.05);
        djHP.frequency.rampTo(20 * Math.pow(6000 / 20, v / 100), 0.05);
      }
    },

    setPump: function (v) {
      if (typeof v === 'number' && isFinite(v)) {
        pumpAmount = Math.max(0, Math.min(1, v));
      }
    },

    setCrush: function (v) {
      // crusher is a plain Gain passthrough (no .wet) when the BitCrusher
      // worklet is unavailable (file://) — no-op in that case.
      if (!crusher || !crusher.wet) return;
      crusher.wet.rampTo(v, 0.05);
    },

    setChorusWet: function (v) {
      if (!chorus) return;
      chorus.wet.rampTo(v, 0.05);
    },

    setGlide: function (s) {
      // Portamento is a monophonic-voice feature; on a PolySynth each pooled
      // voice glides from whatever note IT last played, producing random
      // pitch swoops. Route glide to the mono bass voices instead, where
      // classic 303-style slides are well-defined.
      if (!bassSaw || !bassAcid) return;
      bassSaw.set({ portamento: s });
      bassAcid.set({ portamento: s });
    },

    setLeadOctave: function (str) {
      str = String(str);
      if (str === '3' || str === '4' || str === '5') leadOct = str;
    },

    setLeadNoteLen: function (str) {
      if (str === '16n' || str === '8n' || str === '4n' || str === '2n') {
        leadNoteLen = str;
      }
    },

    setBassStyle: function (name) {
      if (name === 'sub' || name === 'saw' || name === 'acid') bassStyle = name;
    },

    setDrumKit: function (name) {
      var kit = DRUM_KITS[name];
      if (!kit || !kick) return;
      kick.set(kit.kick);
      kickNote = kit.kickNote;
      snare.set(kit.snare);
      hatClosed.set(kit.hatClosed);
      hatOpen.set(kit.hatOpen);
    },

    setChannelVolume: function (ch, db) {
      var channel = channels[ch];
      if (!channel) return;
      if (channel.mute) {
        // Tone implements mute by writing -Infinity into the SAME volume
        // param; ramping it directly would audibly un-mute the channel. Flip
        // mute off/on around the write so _unmutedVolume picks up the new
        // fader value and the channel stays silent.
        channel.mute = false;
        channel.volume.value = db;
        channel.mute = true;
      } else {
        channel.volume.rampTo(db, 0.05);
      }
    },

    setChannelMute: function (ch, muted) {
      var channel = channels[ch];
      if (!channel) return;
      channel.mute = !!muted;
    },

    // Drives a wireToggle()-style button to the requested state by clicking
    // it only when its data-state differs. Returns the resulting boolean, or
    // null if the button is missing.
    setToggleControl: function (id, on) {
      var btn = document.getElementById(id);
      if (!btn) return null;
      var isOn = btn.dataset.state === 'on';
      if (isOn !== !!on) {
        btn.click();
        isOn = btn.dataset.state === 'on';
      }
      return isOn;
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

      if (comp.clearFirst !== undefined && comp.clearFirst !== null) {
        if (typeof comp.clearFirst !== 'boolean') {
          warnings.push('clearFirst: expected boolean, ignored');
        } else if (comp.clearFirst) {
          api.clearGrid();
          applied.push('grid cleared');
        }
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
      } else if (comp.pattern !== undefined && comp.pattern !== null) {
        warnings.push('pattern: expected an object mapping row names (' + ROW_KEYS.join(', ') + ') to arrays of step indices 0-15, ignored');
      }

      slider('tempo-slider', comp.tempo, 'tempo');
      slider('filter-cutoff', comp.filterCutoff, 'filterCutoff');
      slider('filter-resonance', comp.filterResonance, 'filterResonance');
      if (comp.envelope && typeof comp.envelope === 'object' && !Array.isArray(comp.envelope)) {
        slider('env-attack', comp.envelope.attack, 'attack');
        slider('env-decay', comp.envelope.decay, 'decay');
        slider('env-sustain', comp.envelope.sustain, 'sustain');
        slider('env-release', comp.envelope.release, 'release');
      } else if (comp.envelope !== undefined && comp.envelope !== null) {
        warnings.push('envelope: expected an object with attack/decay/sustain/release numbers, ignored');
      }
      slider('reverb-wet', comp.reverb, 'reverb');
      slider('delay-wet', comp.delay, 'delay');
      slider('distortion-amount', comp.distortion, 'distortion');

      select('waveform-select', comp.waveform, 'waveform');
      select('scale-select', comp.scale, 'scale');
      select('root-select', comp.root, 'root');

      select('drum-kit', comp.drumKit, 'drumKit');
      select('bass-style', comp.bassStyle, 'bassStyle');
      select('lead-octave', comp.leadOctave, 'leadOctave');
      select('lead-notelen', comp.leadNoteLen, 'leadNoteLen');
      slider('glide-amount', comp.glide, 'glide');
      slider('chorus-wet', comp.chorus, 'chorus');
      slider('swing-amount', comp.swing, 'swing');
      slider('crush-amount', comp.crush, 'crush');
      slider('pump-amount', comp.pump, 'pump');
      slider('dj-filter', comp.djFilter, 'djFilter');
      slider('master-volume', comp.masterVolume, 'masterVolume');

      if (comp.mixer && typeof comp.mixer === 'object' && !Array.isArray(comp.mixer)) {
        slider('level-kick', comp.mixer.kickVol, 'kickVol');
        slider('level-bass', comp.mixer.bassVol, 'bassVol');
        slider('level-snare', comp.mixer.snareVol, 'snareVol');
        slider('level-hats', comp.mixer.hatsVol, 'hatsVol');
        slider('level-lead', comp.mixer.leadVol, 'leadVol');
        // Mutes go LAST so a requested drop isn't clobbered by other settings.
        ['kick', 'bass', 'snare', 'hats', 'lead'].forEach(function (ch) {
          var want = comp.mixer[ch + 'Mute'];
          if (want === undefined || want === null) return;
          if (typeof want !== 'boolean') {
            warnings.push(ch + 'Mute: expected boolean, ignored');
            return;
          }
          var state = api.setToggleControl('mute-' + ch, want);
          if (state === null) warnings.push(ch + 'Mute: control missing');
          else applied.push(ch + 'Mute=' + state);
        });
        var MIXER_KEYS = ['kickVol', 'bassVol', 'snareVol', 'hatsVol', 'leadVol',
          'kickMute', 'bassMute', 'snareMute', 'hatsMute', 'leadMute'];
        var unknownMixer = Object.keys(comp.mixer).filter(function (k) {
          return MIXER_KEYS.indexOf(k) === -1;
        });
        if (unknownMixer.length) {
          warnings.push('unknown mixer keys ignored: ' + unknownMixer.join(', ') + ' (valid keys: ' + MIXER_KEYS.join(', ') + '; masterVolume is top-level)');
        }
      } else if (comp.mixer !== undefined && comp.mixer !== null) {
        warnings.push('mixer: expected an object with kickVol/bassVol/snareVol/hatsVol/leadVol (dB) and kickMute/bassMute/snareMute/hatsMute/leadMute (boolean), ignored');
      }

      var playPromise;
      if (typeof comp.play === 'boolean') {
        playPromise = comp.play ? api.play() : null;
      } else {
        if (comp.play !== undefined && comp.play !== null) {
          warnings.push('play: expected boolean, ignored (defaulting to play)');
        }
        playPromise = api.play();
      }

      return { ok: true, applied: applied, warnings: warnings, playPromise: playPromise };
    }
  };

  window.BYODJ_SYNTH = api;

  document.addEventListener('DOMContentLoaded', function () {
    api.init();
  });
})();
