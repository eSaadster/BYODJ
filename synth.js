/* ============================================================
 * BYODJ — synth.js
 * Audio engine + sequencer grid + all synth-control DOM wiring.
 * Exposes exactly one global: window.BYODJ_SYNTH
 * Classic script (no modules) — loaded after Tone.js CDN bundle.
 * ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------- constants

  var NUM_ROWS = 11;
  var VISIBLE_STEPS = 16;   // grid DOM is ALWAYS 16 columns (160 cells)
  var MAX_STEPS = 64;       // every scene allocated 64 wide; patternLength masks it
  var NUM_SCENES = 4;
  var SCENE_LETTERS = ['A', 'B', 'C', 'D'];
  var DEFAULT_VEL = 0.9;
  var DEFAULT_PROB = 1;
  var MAX_SONG_SECTIONS = 32;

  // Ramp-able song-section params -> backing slider id. tempo is NOT here:
  // bar durations are computed from bpm, so a tempo ramp would drift the math.
  var RAMPABLE = {
    filterCutoff: 'filter-cutoff',  filterResonance: 'filter-resonance',
    djFilter: 'dj-filter',          reverb: 'reverb-wet',
    delay: 'delay-wet',             distortion: 'distortion-amount',
    chorus: 'chorus-wet',           crush: 'crush-amount',
    pump: 'pump-amount',            masterVolume: 'master-volume'
  };
  var RAMPABLE_NAMES = 'filterCutoff, filterResonance, djFilter, reverb, ' +
    'delay, distortion, chorus, crush, pump, masterVolume';

  // Composition keys that section overrides may NOT contain.
  var OVERRIDE_BLOCKED = ['clearFirst', 'patternLength', 'patterns', 'pattern',
    'chain', 'song', 'scene', 'mode', 'play'];

  var ROW_NAMES = [
    'Kick', 'Bass', 'Snare', 'Closed Hat',
    'Open Hat', 'Lead Root', 'Lead Third', 'Lead Fifth',
    'Lead 7th', 'Lead Oct', 'Perc'
  ];

  // Per-row probability that a cell turns on in randomizeGrid()
  var RANDOM_PROBS = [0.25, 0.25, 0.2, 0.5, 0.15, 0.25, 0.25, 0.25, 0.15, 0.12, 0.15];

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
    'LeadSeventh', 'LeadHigh', 'Perc'
  ];

  // Row keys accepted by applyComposition()'s pattern object, index-aligned
  // with the grid rows. (Row 9 is 'leadHigh', not 'leadOctave', to avoid
  // colliding with the top-level leadOctave composition field.)
  var ROW_KEYS = [
    'kick', 'bass', 'snare', 'closedHat',
    'openHat', 'leadRoot', 'leadThird', 'leadFifth',
    'leadSeventh', 'leadHigh', 'perc'
  ];

  // ---------------------------------------------------------- state

  // A cell is null (off) or { v: 0..1, p: 0..1 }. Always allocated 64 wide so
  // changing patternLength 16 -> 64 -> 16 never destroys data.
  // scenes[sceneIdx][row][absStep]   (absStep = bar*16 + visibleCol)
  var scenes = [];
  (function () {
    for (var sc = 0; sc < NUM_SCENES; sc++) {
      var rows = [];
      for (var r = 0; r < NUM_ROWS; r++) {
        var rowArr = [];
        for (var s = 0; s < MAX_STEPS; s++) rowArr.push(null);
        rows.push(rowArr);
      }
      scenes.push(rows);
    }
  })();

  // ---- edit/view state ----
  var patternLength = 16;   // 16 | 32 | 64, global, shared by all scenes
  var editScene = 0;        // scene shown/edited in the grid (0..3)
  var editBar = 0;          // visible 16-step window (0..patternLength/16-1)

  // ---- arrangement state ----
  var chain = [0];          // parsed scene indices from chain-input ("A" default)
  var playbackMode = 'loop';   // 'loop' | 'chain' | 'song'
  var song = { sections: [] }; // normalized section objects
  var autoFill = false;

  // ---- playback state machine (reset by play()) ----
  var playStep = 0;         // 0..patternLength-1 within the PLAYING scene
  var playScene = 0;
  var chainPos = 0;         // index into chain (chain mode)
  var songPos = 0;          // index into song.sections (song mode)
  var songBar = 0;          // bars elapsed inside current section
  var barCounter = 0;       // global bars since play() — drives fills every 4th bar
  var pendingScene = null;  // loop-mode scene switch, consumed at next bar boundary
  var pendingMode = null;   // playback-mode switch, consumed at next bar boundary
  var activeRamps = [];     // { id, param, from, to, stepsTotal, stepsDone }
  // New song applied while playing in song mode: enter its section 0 at the
  // next bar boundary (instead of yanking songPos under the running section).
  var pendingSongReset = false;
  // #song-status holds an apply error until the next play/stop/successful
  // apply (otherwise the per-16th Draw refresh clobbers it within ~125 ms).
  var songErrorSticky = false;

  var prevDrawnStep = -1;  // last column highlighted with .playhead
  var currentScale = 'minor';
  var currentRoot = 'C';

  // Tone nodes (created in init)
  var kick, bass, snare, hatClosed, hatOpen, poly;
  var leadPlucks = [], leadPluckIdx = 0, leadBell, leadDuo, padSynth, padFilter;
  var percTom, percMetal, percRim, samplePlayers;
  var filter, dist, delay, pingpong, reverb;
  var bassSaw, bassAcid, chorus, pumpGain, crusher, djHP, djLP;
  var comp, masterVol, limiter;
  var channels = {};         // kick|bass|snare|hats|lead|pad|perc -> Tone.Channel
  var repeatId = null;
  var initialized = false;

  // Performance / sound-design state (read at trigger time)
  var pumpAmount = 0;
  var bassStyle = 'sub';     // 'sub' | 'saw' | 'acid'
  var leadStyle = 'saw';     // 'saw' | 'pluck' | 'bell' | 'duo'
  var delayStyle = 'feedback';
  var padOn = false;
  var percVoice = 'tom';
  var drumKitMode = 'synth';
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

  function agentLog(msg) {
    if (window.BYODJ_AGENT && typeof window.BYODJ_AGENT.log === 'function') {
      try { window.BYODJ_AGENT.log(msg); } catch (e) {}
    }
  }

  // Normalize a scene reference ('A'-'D' any case, or 0-3) to an index, or -1.
  function sceneIndex(v) {
    if (typeof v === 'number' && v === Math.floor(v) && v >= 0 && v < NUM_SCENES) return v;
    if (typeof v === 'string' && v.length === 1) {
      var i = SCENE_LETTERS.indexOf(v.toUpperCase());
      if (i !== -1) return i;
    }
    return -1;
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function selectHasOption(id, v) {
    var sel = document.getElementById(id);
    if (!sel) return false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) return true;
    }
    return false;
  }

  // Probability gate, evaluated EVERY pass.
  function gateCell(cell) {
    return !!cell && (cell.p >= 1 || Math.random() < cell.p);
  }

  function syncCellDom(row, col) {
    var el = cellEl(row, col);
    if (!el) return;
    var cell = scenes[editScene][row][editBar * 16 + col];
    var on = !!cell;
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    // data-state is serialized by page-agent (aria-pressed/class are not),
    // so this is the attribute the LLM agent reads to see cell state.
    el.dataset.state = on ? 'on' : 'off';
    el.classList.toggle('on', on);
    // Velocity tier + tooltip are CSS/human affordances only (not serialized).
    if (on) {
      el.setAttribute('data-vel',
        cell.v >= 0.75 ? 'hi' : cell.v >= 0.45 ? 'mid' : 'lo');
      el.setAttribute('title',
        'vel ' + cell.v.toFixed(2) + ' prob ' + cell.p.toFixed(2));
    } else {
      el.removeAttribute('data-vel');
      el.removeAttribute('title');
    }
  }

  function syncAllCells() {
    for (var r = 0; r < NUM_ROWS; r++) {
      for (var s = 0; s < VISIBLE_STEPS; s++) syncCellDom(r, s);
    }
  }

  // Redraw the visible 10x16 window (scene select, bar select, length change,
  // copyScene, applyComposition pattern writes).
  function refreshGridView() { syncAllCells(); }

  function clearAllScenes() {
    for (var sc = 0; sc < NUM_SCENES; sc++) {
      for (var r = 0; r < NUM_ROWS; r++) {
        for (var s = 0; s < MAX_STEPS; s++) scenes[sc][r][s] = null;
      }
    }
  }

  function getChainString() {
    var out = '';
    for (var i = 0; i < chain.length; i++) out += SCENE_LETTERS[chain[i]];
    return out;
  }

  function songTotalBars() {
    var total = 0;
    for (var i = 0; i < song.sections.length; i++) total += song.sections[i].bars;
    return total;
  }

  // Serialize the normalized song with scene LETTERS (human/agent readable;
  // round-trips through setSong unchanged). Written back into #song-input.
  function songSectionsToJson() {
    var out = [];
    for (var i = 0; i < song.sections.length; i++) {
      var sec = song.sections[i];
      var o = { name: sec.name, scene: SCENE_LETTERS[sec.scene], bars: sec.bars };
      if (sec.root) o.root = sec.root;
      if (sec.scale) o.scale = sec.scale;
      if (sec.overrides) o.overrides = sec.overrides;
      if (sec.ramps) o.ramps = sec.ramps;
      out.push(o);
    }
    return JSON.stringify(out);
  }

  // ---- toolbar attribute sync (page-agent reads data-state/aria-pressed) ----

  function syncSceneButtons() {
    for (var i = 0; i < NUM_SCENES; i++) {
      var btn = document.getElementById('scene-btn-' + SCENE_LETTERS[i].toLowerCase());
      if (!btn) continue;
      var on = (i === editScene);
      btn.dataset.state = on ? 'on' : 'off';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function syncBarButtons() {
    var numBars = patternLength / 16;
    for (var i = 0; i < 4; i++) {
      var btn = document.getElementById('bar-btn-' + (i + 1));
      if (!btn) continue;
      var inRange = i < numBars;
      // Hidden bars get BOTH hidden and disabled (excluded from agent
      // serialization; clicks are no-ops).
      btn.hidden = !inRange;
      btn.disabled = !inRange;
      var on = (i === editBar);
      btn.dataset.state = on ? 'on' : 'off';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // Selects have no auto-synced value attribute, so new selects mirror their
  // value into data-state for the agent (wired at wire time + every change).
  function mirrorSelect(id) {
    var sel = document.getElementById(id);
    if (sel) sel.setAttribute('data-state', sel.value);
  }

  // #song-status: compact machine-readable state in data-state (<= 20 chars),
  // fuller human text in textContent. compute/apply are split so the Draw
  // callback can snapshot the status BEFORE advanceBar mutates playback state
  // (the Draw runs ~lookahead later and must report what is audible).
  function computeSongStatus() {
    var state, text;
    if (!api.isPlaying()) {
      state = 'idle';
      text = song.sections.length
        ? 'song: ' + song.sections.length + ' sections / ' + songTotalBars() + ' bars (stopped)'
        : '—';
    } else if (playbackMode === 'song' && song.sections.length) {
      // A freshly applied song is not entered until the next bar boundary;
      // keep reporting the previous (still audible) state instead of a
      // section that has not started yet.
      if (pendingSongReset) return null;
      var sec = song.sections[Math.min(songPos, song.sections.length - 1)];
      state = songPos + ':' + (sec.name || '').slice(0, 8) + ':' +
        SCENE_LETTERS[sec.scene] + ':' + Math.min(songBar + 1, sec.bars) + '/' + sec.bars;
      text = 'section ' + (songPos + 1) + '/' + song.sections.length +
        (sec.name ? ' "' + sec.name + '"' : '') +
        ' scene ' + SCENE_LETTERS[sec.scene] +
        ' bar ' + Math.min(songBar + 1, sec.bars) + '/' + sec.bars;
    } else if (playbackMode === 'chain') {
      var pos = Math.min(chainPos, chain.length - 1);
      state = 'chain ' + getChainString() + ' @' + (pos + 1);
      text = 'chain ' + getChainString() + ' position ' + (pos + 1) + '/' + chain.length;
    } else {
      state = 'loop ' + SCENE_LETTERS[playScene];
      text = 'looping scene ' + SCENE_LETTERS[playScene];
    }
    return { state: state, text: text };
  }

  function applySongStatus(s) {
    // null = keep the previous display; sticky error stays until cleared by
    // the next play/stop/successful song apply.
    if (!s || songErrorSticky) return;
    var el = document.getElementById('song-status');
    if (!el) return;
    if (el.getAttribute('data-state') !== s.state) el.setAttribute('data-state', s.state);
    if (el.textContent !== s.text) el.textContent = s.text;
  }

  function updateSongStatus() { applySongStatus(computeSongStatus()); }

  function songStatusError(msg) {
    var el = document.getElementById('song-status');
    if (el) {
      el.setAttribute('data-state', 'error');
      el.textContent = msg;
    }
    songErrorSticky = true;
    agentLog(msg);
  }

  // ---- ramps (song sections): one long audio ramp + per-16th DOM tween ----

  function cancelRamp(id) {
    for (var i = activeRamps.length - 1; i >= 0; i--) {
      if (activeRamps[i].id === id) activeRamps.splice(i, 1);
    }
  }

  // Update slider position, serialized value attribute and <output> WITHOUT
  // dispatching 'input' (a dispatch would fight the long audio ramp with the
  // handler's 0.05 s mini-ramps).
  function syncSliderDisplay(id, v) {
    var input = document.getElementById(id);
    if (!input) return;
    input.value = String(v);
    input.setAttribute('value', input.value);
    var output = document.getElementById(id + '-value');
    if (output) output.value = input.value;
  }

  function startRamp(param, to, bars) {
    var id = RAMPABLE[param];
    var input = document.getElementById(id);
    if (!input || input.disabled) return;
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    if (!isNaN(min)) to = Math.max(min, to);
    if (!isNaN(max)) to = Math.min(max, to);
    cancelRamp(id);
    var from = parseFloat(input.value);
    if (isNaN(from)) from = to;
    // 4 beats/bar; seconds computed once at section entry. Read the tempo
    // from the slider, NOT bpm.value: setTempo applies via rampTo(bpm, 0.1),
    // so for ~100 ms after a tempo write (e.g. this same section's override)
    // bpm.value still reads the OLD tempo and the audio ramp would run at
    // the wrong rate, ending with an audible jump at the settle. The slider's
    // value property is already updated synchronously before startRamps runs.
    var tempoInput = document.getElementById('tempo-slider');
    var bpm = tempoInput ? parseFloat(tempoInput.value) : NaN;
    if (isNaN(bpm) || bpm <= 0) bpm = Tone.getTransport().bpm.value;
    var secs = bars * 4 * (60 / bpm);
    // ONE long ramp on the existing node. pump (plain state var) and
    // distortion (plain property) have no AudioParam — the DOM tick drives
    // them instead.
    if (param === 'filterCutoff') api.setFilterCutoff(to, secs);
    else if (param === 'filterResonance') api.setFilterResonance(to, secs);
    else if (param === 'djFilter') api.setDjFilter(to, secs);
    else if (param === 'reverb') api.setReverbWet(to, secs);
    else if (param === 'delay') api.setDelayWet(to, secs);
    else if (param === 'chorus') api.setChorusWet(to, secs);
    else if (param === 'crush') api.setCrush(to, secs);
    else if (param === 'masterVolume') api.setMasterVolume(to, secs);
    activeRamps.push({
      id: id, param: param, from: from, to: to,
      stepsTotal: Math.max(1, Math.round(bars * 16)), stepsDone: 0
    });
  }

  function startRamps(ramps, sectionBars) {
    if (!ramps) return;
    for (var k in ramps) {
      if (!ramps.hasOwnProperty(k) || !RAMPABLE.hasOwnProperty(k)) continue;
      var spec = ramps[k];
      if (!spec || typeof spec.to !== 'number' || !isFinite(spec.to)) continue;
      var bars = (typeof spec.bars === 'number' && spec.bars > 0) ? spec.bars : sectionBars;
      startRamp(k, spec.to, bars);
    }
  }

  // Called every 16th from the scheduler: advance the DOM tween; on
  // completion settle through the normal setRangeControl pathway.
  function tickRamps() {
    if (!activeRamps.length) return;
    for (var i = activeRamps.length - 1; i >= 0; i--) {
      var rmp = activeRamps[i];
      rmp.stepsDone++;
      if (rmp.stepsDone >= rmp.stepsTotal) {
        activeRamps.splice(i, 1);
        setRangeControl(rmp.id, rmp.to);
      } else {
        var interp = rmp.from + (rmp.to - rmp.from) * (rmp.stepsDone / rmp.stepsTotal);
        syncSliderDisplay(rmp.id, interp);
        if (rmp.param === 'pump') api.setPump(clamp01(interp));
        else if (rmp.param === 'distortion') api.setDistortion(clamp01(interp));
      }
    }
  }

  // stop(): freeze each ramp at its current interpolated value via the normal
  // pathway, then clear.
  function freezeRamps() {
    if (!activeRamps.length) return;
    var frozen = activeRamps.slice();
    activeRamps.length = 0;
    for (var i = 0; i < frozen.length; i++) {
      var rmp = frozen[i];
      var t = rmp.stepsTotal ? rmp.stepsDone / rmp.stepsTotal : 1;
      setRangeControl(rmp.id, rmp.from + (rmp.to - rmp.from) * t);
    }
  }

  // ---- song playback state machine ----

  function enterSection(i) {
    var sec = song.sections[i];
    if (!sec) return;
    playScene = sec.scene;
    var compObj = {};
    var k;
    if (sec.overrides) {
      for (k in sec.overrides) {
        if (sec.overrides.hasOwnProperty(k)) compObj[k] = sec.overrides[k];
      }
    }
    if (sec.root) compObj.root = sec.root;    // chord progressions / key changes
    if (sec.scale) compObj.scale = sec.scale;
    // Same DOM-control pathway as the agent tool; settings-only (noPattern)
    // and never restarts the transport (noPlay). All targets are .set()/ramps
    // ~lookahead ahead of audible time — no nodes are ever rebuilt.
    var res = api.applyComposition(compObj, { noPlay: true, noPattern: true });
    if (res && res.warnings && res.warnings.length) {
      agentLog('song section "' + (sec.name || SCENE_LETTERS[sec.scene]).slice(0, 12) +
        '": ' + res.warnings.join('; '));
    }
    startRamps(sec.ramps, sec.bars);
  }

  // ALL scene/section/mode transitions are bar-quantized.
  function advanceBar() {
    barCounter++;
    if (pendingMode) {
      playbackMode = pendingMode;
      pendingMode = null;
      chainPos = 0; songPos = 0; songBar = 0;
      pendingSongReset = false;  // mode switch enters section 0 itself
      if (playbackMode === 'song' && song.sections.length) {
        enterSection(0);
        playStep = 0;
        return;
      }
      if (playbackMode === 'chain') {
        playScene = chain[0];
        playStep = 0;
        return;
      }
      playScene = editScene;  // loop (or empty song falls back to loop)
    }
    if (playbackMode === 'loop') {
      if (pendingScene !== null) { playScene = pendingScene; pendingScene = null; }
      if (playStep >= patternLength) playStep = 0;
    } else if (playbackMode === 'chain') {
      // Chain advances per FULL pattern (a chain letter = one full pass).
      if (playStep >= patternLength) {
        playStep = 0;
        chainPos = (chainPos + 1) % chain.length;
        playScene = chain[chainPos];
      }
    } else if (playbackMode === 'song' && song.sections.length) {
      if (pendingSongReset) {
        // A new song was applied mid-play: enter its section 0 at this bar
        // boundary so section 0's scene/root/overrides/ramps actually run.
        pendingSongReset = false;
        songPos = 0;
        songBar = 0;
        enterSection(0);
        playStep = 0;
        return;
      }
      songBar++;
      var sec = song.sections[songPos];
      if (!sec || songBar >= sec.bars) {
        songPos = (songPos + 1) % Math.max(1, song.sections.length);  // song loops
        songBar = 0;
        enterSection(songPos);
        playStep = 0;
      } else if (playStep >= patternLength) {
        playStep = 0;  // scene loops inside long sections
      }
    } else {
      // song mode without sections: behave like loop
      if (playStep >= patternLength) playStep = 0;
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

  function chordNotes() {
    var saved = leadOct;
    leadOct = '3';
    var notes = [noteForRow(5), noteForRow(6), noteForRow(7)];
    leadOct = saved;
    return notes;
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

      for (var s = 0; s < VISIBLE_STEPS; s++) {
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
      if (ev.altKey) {
        // Alt+click on an ON cell cycles velocity 0.9 -> 0.6 -> 0.35 -> 0.9
        // (prob untouched). Alt+click on an OFF cell acts like plain click.
        var data = scenes[editScene][row][editBar * 16 + st];
        if (data) {
          data.v = (data.v >= 0.75) ? 0.6 : (data.v >= 0.45) ? 0.35 : DEFAULT_VEL;
          syncCellDom(row, st);
          return;
        }
      }
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

    // PluckSynth is built on FeedbackCombFilter, an AudioWorklet; worklet
    // modules cannot load from file:// (same constraint as BitCrusher), so
    // gate the pool and fall back to the saw poly at trigger time.
    if (window.location.protocol !== 'file:') {
      try {
        for (var pi = 0; pi < 4; pi++) {
          leadPlucks.push(new Tone.PluckSynth({ attackNoise: 1, dampening: 4000, resonance: 0.7 }));
        }
      } catch (ePluck) {
        console.warn('BYODJ_SYNTH: PluckSynth creation failed, pluck lead style disabled', ePluck);
        leadPlucks = [];
      }
    } else {
      var pluckOpt = document.querySelector('#lead-style option[value="pluck"]');
      if (pluckOpt) {
        pluckOpt.disabled = true;
        pluckOpt.title = 'pluck needs HTTP (AudioWorklet cannot load from file://)';
      }
    }
    leadBell = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 14,
      envelope: { attack: 0.01, decay: 0.5, sustain: 0.25, release: 1.8 },
      volume: -8
    });
    leadDuo = new Tone.PolySynth(Tone.DuoSynth, {
      vibratoAmount: 0,
      harmonicity: 1.5,
      envelope: { attack: 0.01, decay: 0.25, sustain: 0.55, release: 0.8 },
      volume: -9
    });
    leadDuo.maxPolyphony = 8;

    padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsawtooth' },
      envelope: { attack: 0.6, decay: 0.3, sustain: 0.8, release: 2.5 },
      volume: -10
    });
    padFilter = new Tone.Filter(1200, 'lowpass');

    percTom = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3 });
    percMetal = new Tone.MetalSynth({ envelope: { decay: 0.15 }, harmonicity: 5.1, resonance: 3000 });
    percRim = new Tone.MetalSynth({ envelope: { decay: 0.04 }, frequency: 800, harmonicity: 8 });

    filter = new Tone.Filter(2000, 'lowpass', -24);
    dist = new Tone.Distortion(0);
    // True bypass at slider=0: Distortion's waveshaper attenuates even at
    // amount 0 (clean signal scaled to ~1/3), so keep wet at 0 until used.
    dist.wet.value = 0;
    delay = new Tone.FeedbackDelay('8n', 0.35);
    delay.wet.value = 0.15;
    pingpong = new Tone.PingPongDelay('8n', 0.35);
    pingpong.wet.value = 0;
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
    channels.pad   = new Tone.Channel(-6);
    channels.perc  = new Tone.Channel(0);

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

    poly.chain(filter, dist, chorus, delay, pingpong, reverb, channels.lead);
    for (var lpi = 0; lpi < leadPlucks.length; lpi++) leadPlucks[lpi].chain(filter);
    leadBell.chain(filter);
    leadDuo.chain(filter);
    channels.lead.connect(pumpGain);

    padSynth.chain(padFilter, channels.pad);
    channels.pad.connect(pumpGain);

    percTom.connect(channels.perc);
    percMetal.connect(channels.perc);
    percRim.connect(channels.perc);
    channels.perc.connect(pumpGain);

    pumpGain.chain(crusher, djHP, djLP, comp, masterVol, limiter, Tone.getDestination());

    if (window.location.protocol !== 'file:') {
      try {
        samplePlayers = new Tone.Players({
          kick: 'https://tonejs.github.io/audio/drum-samples/CR78/kick.mp3',
          snare: 'https://tonejs.github.io/audio/drum-samples/CR78/snare.mp3',
          hatClosed: 'https://tonejs.github.io/audio/drum-samples/CR78/hihat.mp3',
          hatOpen: 'https://tonejs.github.io/audio/drum-samples/CR78/hihat.mp3'
        });
        samplePlayers.player('kick').connect(channels.kick);
        samplePlayers.player('snare').connect(channels.snare);
        samplePlayers.player('hatClosed').connect(channels.hats);
        samplePlayers.player('hatOpen').connect(channels.hats);
      } catch (e3) {
        console.warn('BYODJ_SYNTH: sampled drum kit unavailable', e3);
        samplePlayers = null;
      }
    } else {
      var sampled = document.querySelector('#drum-kit option[value="sampled"]');
      if (sampled) {
        sampled.disabled = true;
        sampled.title = 'sampled kit needs HTTP';
      }
    }

    var transport = Tone.getTransport();
    transport.bpm.value = 120;
    transport.swingSubdivision = '16n';

    repeatId = transport.scheduleRepeat(function (time) {
      var st = playStep;             // absolute step within the PLAYING scene
      var stepInBar = st % 16;
      var sc = scenes[playScene];
      // Auto-fill: every 4th bar, a generated snare/hat fill SHADOWS (never
      // mutates) the pattern over the last 4 steps, with rising velocity.
      var isFillBar = autoFill && (barCounter % 4 === 3);
      var inFillWindow = isFillBar && stepInBar >= 12;
      var c;

      c = sc[0][st];
      if (gateCell(c)) {
        if (drumKitMode === 'sampled' && samplePlayers) {
          samplePlayers.player('kick').volume.value = Tone.gainToDb(c.v);
          samplePlayers.player('kick').start(time);
        } else {
          kick.triggerAttackRelease(kickNote, '16n', time, c.v);
        }
        if (pumpAmount > 0) {
          // Sidechain pump: duck the mix bus on every kick, recover in 180ms.
          pumpGain.gain.cancelScheduledValues(time);
          pumpGain.gain.setValueAtTime(1 - 0.8 * pumpAmount, time);
          pumpGain.gain.linearRampToValueAtTime(1, time + 0.18);
        }
      }
      c = sc[1][st];
      if (gateCell(c)) {
        var bassSynth = (bassStyle === 'saw') ? bassSaw
          : (bassStyle === 'acid') ? bassAcid
          : bass;
        bassSynth.triggerAttackRelease(currentRoot + '1', '16n', time, c.v);
      }
      if (inFillWindow) {
        var fv = 0.5 + 0.15 * (stepInBar - 12);   // 0.5 -> 0.95 across 12..15
        snare.triggerAttackRelease('16n', time, fv);
        hatClosed.triggerAttackRelease('16n', time, Math.max(0.3, fv - 0.2));
      } else {
        c = sc[2][st];
        if (gateCell(c)) {
          if (drumKitMode === 'sampled' && samplePlayers) { samplePlayers.player('snare').volume.value = Tone.gainToDb(c.v); samplePlayers.player('snare').start(time); }
          else snare.triggerAttackRelease('16n', time, c.v);
        }
        c = sc[3][st];
        if (gateCell(c)) {
          if (drumKitMode === 'sampled' && samplePlayers) { samplePlayers.player('hatClosed').volume.value = Tone.gainToDb(c.v); samplePlayers.player('hatClosed').start(time); }
          else hatClosed.triggerAttackRelease('16n', time, c.v);
        }
      }
      c = sc[4][st];
      if (gateCell(c)) {
        if (drumKitMode === 'sampled' && samplePlayers) { samplePlayers.player('hatOpen').volume.value = Tone.gainToDb(c.v); samplePlayers.player('hatOpen').start(time); }
        else hatOpen.triggerAttackRelease('16n', time, c.v);
      }
      for (var r = 5; r <= 9; r++) {
        c = sc[r][st];
        if (gateCell(c)) {
          var note = noteForRow(r);
          if (leadStyle === 'pluck' && leadPlucks.length) {
            var pl = leadPlucks[leadPluckIdx++ % leadPlucks.length];
            pl.triggerAttackRelease(note, leadNoteLen, time, c.v);
          } else if (leadStyle === 'bell') {
            leadBell.triggerAttackRelease(note, leadNoteLen, time, c.v);
          } else if (leadStyle === 'duo') {
            leadDuo.triggerAttackRelease(note, leadNoteLen, time, c.v);
          } else {
            poly.triggerAttackRelease(note, leadNoteLen, time, c.v);
          }
        }
      }
      c = sc[10][st];
      if (gateCell(c)) {
        if (percVoice === 'metal') percMetal.triggerAttackRelease('16n', time, c.v);
        else if (percVoice === 'rim') percRim.triggerAttackRelease('16n', time, c.v);
        else percTom.triggerAttackRelease('G2', '16n', time, c.v);
      }
      if (padOn && stepInBar === 0) {
        padSynth.triggerAttackRelease(chordNotes(), '1m', time, 0.7);
      }

      tickRamps();   // per-16th DOM interpolation of active section ramps

      // Snapshot display state BEFORE advanceBar below mutates it: the Draw
      // callback runs ~lookahead (~100 ms) later, so reading playScene /
      // songPos / chainPos live would show the NEXT scene/section one 16th
      // early at every transition boundary.
      var drawScene = playScene;
      var drawBar = Math.floor(st / 16);
      var drawStatus = computeSongStatus();
      Tone.getDraw().schedule(function () {
        // Playhead only when the playing bar of the playing scene is visible.
        if (drawScene === editScene && drawBar === editBar) {
          highlightColumn(st % 16);
        } else if (prevDrawnStep >= 0) {
          clearPlayhead();
        }
        applySongStatus(drawStatus);
      }, time);

      playStep++;
      if (playStep % 16 === 0) advanceBar();   // every bar boundary
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
      // A real write to a slider supersedes any in-flight section ramp on it
      // (the handler's short rampTo replaces the long one).
      cancelRamp(id);
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
    // EVERY select mirrors its value into data-state at wire time and on each
    // change: selects have no auto-synced value attribute, and song sections
    // mutate root/scale at runtime (enterSection -> setSelectControl
    // dispatches 'change'), so this is the only serialized state the agent
    // can read to see the current value.
    sel.setAttribute('data-state', sel.value);
    sel.addEventListener('change', function () {
      sel.setAttribute('data-state', sel.value);
      handler(sel.value);
    });
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
    wireSlider('level-pad',   function (v) { api.setChannelVolume('pad', v); });
    wireSlider('level-perc',  function (v) { api.setChannelVolume('perc', v); });
    wireToggle('mute-kick',   function (on) { api.setChannelMute('kick', on); });
    wireToggle('mute-bass',   function (on) { api.setChannelMute('bass', on); });
    wireToggle('mute-snare',  function (on) { api.setChannelMute('snare', on); });
    wireToggle('mute-hats',   function (on) { api.setChannelMute('hats', on); });
    wireToggle('mute-lead',   function (on) { api.setChannelMute('lead', on); });
    wireToggle('mute-pad',    function (on) { api.setChannelMute('pad', on); });
    wireToggle('mute-perc',   function (on) { api.setChannelMute('perc', on); });

    // Master & groove
    wireSlider('master-volume', function (v) { api.setMasterVolume(v); });
    wireSlider('dj-filter',     function (v) { api.setDjFilter(v); });
    wireSlider('pump-amount',   function (v) { api.setPump(v); });
    wireSlider('crush-amount',  function (v) { api.setCrush(v); });
    wireSlider('swing-amount',  function (v) { api.setSwing(v); });

    // Sound design
    wireSelect('drum-kit',     function (v) { api.setDrumKit(v); });
    wireSelect('bass-style',   function (v) { api.setBassStyle(v); });
    wireSelect('lead-style',   function (v) { mirrorSelect('lead-style'); api.setLeadStyle(v); });
    wireSelect('perc-voice',   function (v) { mirrorSelect('perc-voice'); api.setPercVoice(v); });
    wireSelect('delay-style',  function (v) { mirrorSelect('delay-style'); api.setDelayStyle(v); });
    wireSelect('lead-octave',  function (v) { api.setLeadOctave(v); });
    wireSelect('lead-notelen', function (v) { api.setLeadNoteLen(v); });
    wireSlider('glide-amount', function (v) { api.setGlide(v); });
    wireSlider('chorus-wet',   function (v) { api.setChorusWet(v); });

    var playBtnEl = document.getElementById('play-btn');
    if (playBtnEl) playBtnEl.dataset.state = 'stopped';
    wireButton('play-btn',   function () { api.play(); });
    wireButton('stop-btn',   function () { api.stop(); });
    wireButton('clear-btn',  function () { api.clearGrid(); });
    wireButton('clear-all-btn', function () { api.clearAll(); });
    wireButton('random-btn', function () { api.randomizeGrid(); });

    // Scenes + bar pager
    wireButton('scene-btn-a', function () { api.setScene(0); });
    wireButton('scene-btn-b', function () { api.setScene(1); });
    wireButton('scene-btn-c', function () { api.setScene(2); });
    wireButton('scene-btn-d', function () { api.setScene(3); });
    wireButton('bar-btn-1', function () { api.setEditBar(0); });
    wireButton('bar-btn-2', function () { api.setEditBar(1); });
    wireButton('bar-btn-3', function () { api.setEditBar(2); });
    wireButton('bar-btn-4', function () { api.setEditBar(3); });

    // New selects mirror their value into data-state (selects have no
    // auto-synced value attribute, so this is what the agent reads).
    wireSelect('pattern-length', function (v) {
      mirrorSelect('pattern-length');
      api.setPatternLength(parseInt(v, 10));
    });
    wireSelect('playback-mode', function (v) {
      mirrorSelect('playback-mode');
      api.setPlaybackMode(v);
    });
    wireSelect('copy-scene-to', function () { mirrorSelect('copy-scene-to'); });
    mirrorSelect('pattern-length');
    mirrorSelect('playback-mode');
    mirrorSelect('copy-scene-to');
    mirrorSelect('lead-style');
    mirrorSelect('perc-voice');
    mirrorSelect('delay-style');

    wireButton('copy-scene-btn', function () {
      var sel = document.getElementById('copy-scene-to');
      if (sel) api.copyScene(editScene, sel.value);
    });

    wireButton('chain-apply-btn', function () {
      var input = document.getElementById('chain-input');
      if (!input) return;
      if (api.setChain(input.value) === null) {
        // Revert the field to the last good chain so the serialized value
        // attribute never lies.
        input.value = api.getChain();
        input.setAttribute('value', input.value);
        agentLog('chain: must be 1-8 letters A-D, ignored (kept "' +
          api.getChain() + '")');
      }
    });

    // Auto fills (groove feature; engine state only)
    wireToggle('fills-toggle', function (on) { api.setAutoFill(on); });
    wireToggle('pad-toggle', function (on) { api.setPad(on); });

    // Song panel: manual escape hatch (the composer tool is the primary editor)
    wireButton('song-apply-btn', function () {
      var ta = document.getElementById('song-input');
      if (!ta) return;
      var parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        songStatusError('Song JSON parse error: ' + e.message);
        return;
      }
      var res = api.setSong(parsed);
      if (!res.ok) {
        songStatusError('Song rejected: ' +
          res.errors.concat(res.warnings).join('; '));
      } else if (res.warnings.length) {
        agentLog('song warnings: ' + res.warnings.join('; '));
      }
    });
    wireButton('song-status', function () { /* read-only readout */ });

    // Initial serialized state for the toolbar + status
    syncSceneButtons();
    syncBarButtons();
    updateSongStatus();

    // Initialize scale/root from current select values (contract defaults:
    // minor / C — but read the DOM in case markup differs).
    var scaleSel = document.getElementById('scale-select');
    if (scaleSel && SCALES[scaleSel.value]) currentScale = scaleSel.value;
    var rootSel = document.getElementById('root-select');
    if (rootSel && rootSel.value) currentRoot = rootSel.value;

    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      var syncTheme = function () {
        var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        themeBtn.dataset.state = t;
        themeBtn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
        themeBtn.textContent = t === 'light' ? 'Dark' : 'Light';
      };
      themeBtn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { window.localStorage.setItem('byodj.theme', next); } catch (e) {}
        syncTheme();
      });
      syncTheme();
    }
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
        // Settle any in-flight section ramps from the previous run so a
        // restart doesn't keep tweening sliders/audio of the new one
        // (enterSection(0) below starts fresh ramps).
        freezeRamps();
        // Commit a queued bar-quantized mode change instead of discarding
        // it: a restart is a fresh start, so the most recently requested
        // mode wins (setPlaybackMode already synced the select + its
        // data-state mirror, so the serialized attributes stay truthful).
        if (pendingMode !== null) playbackMode = pendingMode;
        // Reset the playback state machine.
        playStep = 0;
        barCounter = 0;
        chainPos = 0;
        songPos = 0;
        songBar = 0;
        pendingScene = null;
        pendingMode = null;
        pendingSongReset = false;
        songErrorSticky = false;
        if (playbackMode === 'chain') {
          playScene = chain[0];
        } else if (playbackMode === 'song' && song.sections.length) {
          playScene = song.sections[0].scene;
        } else {
          playScene = editScene;
        }
        // Enter section 0 BEFORE the transport starts so its overrides/ramps
        // are in place for the first audible step.
        if (playbackMode === 'song') {
          if (song.sections.length) {
            enterSection(0);
          } else {
            agentLog('song mode: no sections loaded, looping scene ' +
              SCENE_LETTERS[editScene] + ' instead');
          }
        }
        transport.position = 0;
        clearPlayhead();
        transport.start();
        // Serialized transport state so the agent can verify playback.
        var playBtn = document.getElementById('play-btn');
        if (playBtn) playBtn.dataset.state = 'playing';
        updateSongStatus();
      });
    },

    stop: function () {
      if (!initialized) return;
      Tone.getTransport().stop();
      // Cancel Draw events already queued within the audio lookahead window,
      // otherwise a pending highlightColumn re-adds .playhead after we clear.
      Tone.getDraw().cancel();
      if (padSynth) padSynth.releaseAll();
      if (poly) poly.releaseAll();
      if (leadBell) leadBell.releaseAll();
      if (leadDuo) leadDuo.releaseAll();
      clearPlayhead();
      // Freeze in-flight section ramps at their current interpolated value.
      freezeRamps();
      var playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.dataset.state = 'stopped';
      updateSongStatus();
      applySongStatus({ state: 'idle', text: '\u2014' });
    },

    isPlaying: function () {
      if (!initialized) return false;
      return Tone.getTransport().state === 'started';
    },

    // col is the VISIBLE column (0-15); the underlying step is editBar*16+col.
    toggleCell: function (row, st) {
      if (row < 0 || row >= NUM_ROWS || st < 0 || st >= VISIBLE_STEPS) return false;
      var abs = editBar * 16 + st;
      var cur = scenes[editScene][row][abs];
      scenes[editScene][row][abs] = cur ? null : { v: DEFAULT_VEL, p: DEFAULT_PROB };
      syncCellDom(row, st);
      return !!scenes[editScene][row][abs];
    },

    // Clears the EDIT scene — all 64 steps, never just the visible bar.
    clearGrid: function () {
      for (var r = 0; r < NUM_ROWS; r++) {
        for (var s = 0; s < MAX_STEPS; s++) scenes[editScene][r][s] = null;
      }
      refreshGridView();
    },

    // Full clean slate: every scene, the chain, the song, and all arrangement
    // state back to defaults. Sound design / mixer / effects are untouched
    // (matching clearFirst's scope plus the arrangement).
    clearAll: function () {
      for (var sc = 0; sc < NUM_SCENES; sc++) {
        for (var r = 0; r < NUM_ROWS; r++) {
          for (var s = 0; s < MAX_STEPS; s++) scenes[sc][r][s] = null;
        }
      }
      // setSong rejects empty arrays (a song needs >= 1 section), so empty
      // the arrangement directly.
      song.sections = [];
      songPos = 0;
      songBar = 0;
      pendingSongReset = false;
      var ta = document.getElementById('song-input');
      if (ta) ta.value = '[]';
      api.setChain('A');
      api.setPlaybackMode('loop');   // also refreshes #song-status
      api.setPatternLength(16);
      api.setScene('A');
      api.setEditBar(0);
    },

    // Randomizes the edit scene across patternLength (cells at defaults).
    randomizeGrid: function () {
      for (var r = 0; r < NUM_ROWS; r++) {
        for (var s = 0; s < patternLength; s++) {
          scenes[editScene][r][s] = (Math.random() < RANDOM_PROBS[r])
            ? { v: DEFAULT_VEL, p: DEFAULT_PROB } : null;
        }
      }
      refreshGridView();
    },

    // Back-compat: 10x16 boolean view of the visible window.
    getGridState: function () {
      var out = [];
      for (var r = 0; r < NUM_ROWS; r++) {
        var row = [];
        for (var s = 0; s < VISIBLE_STEPS; s++) {
          row.push(!!scenes[editScene][r][editBar * 16 + s]);
        }
        out.push(row);
      }
      return out;
    },

    // ---- F1: pattern length + bar paging ----

    setPatternLength: function (len) {
      if (len !== 16 && len !== 32 && len !== 64) return null;
      patternLength = len;
      // Snap the visible bar back into range and re-hide pager tabs.
      if (editBar >= patternLength / 16) editBar = 0;
      syncBarButtons();
      refreshGridView();
      // Keep the select + its data-state mirror in sync when called
      // programmatically (no dispatch — avoids handler recursion).
      var sel = document.getElementById('pattern-length');
      if (sel) {
        if (sel.value !== String(len)) sel.value = String(len);
        mirrorSelect('pattern-length');
      }
      return patternLength;
    },

    getPatternLength: function () { return patternLength; },

    setEditBar: function (b) {
      if (typeof b !== 'number' || b !== Math.floor(b)) return null;
      if (b < 0 || b >= patternLength / 16) return null;
      editBar = b;
      syncBarButtons();
      refreshGridView();
      return editBar;
    },

    getEditBar: function () { return editBar; },

    // ---- F2: scenes + chain ----

    setScene: function (s) {
      var i = sceneIndex(s);
      if (i === -1) return null;
      editScene = i;
      syncSceneButtons();
      refreshGridView();
      if (playbackMode === 'loop') {
        // Mid-play loop-mode switches are bar-quantized; stopped is immediate.
        if (api.isPlaying()) pendingScene = i;
        else playScene = i;
      }
      return i;
    },

    getScene: function () { return editScene; },

    copyScene: function (from, to) {
      var f = sceneIndex(from);
      var t = sceneIndex(to);
      if (f === -1 || t === -1) return false;
      if (f !== t) {
        for (var r = 0; r < NUM_ROWS; r++) {
          for (var s = 0; s < MAX_STEPS; s++) {
            var cell = scenes[f][r][s];
            scenes[t][r][s] = cell ? { v: cell.v, p: cell.p } : null;
          }
        }
      }
      if (t === editScene) refreshGridView();
      return true;
    },

    setChain: function (str) {
      if (typeof str !== 'string' || !/^[A-Da-d]{1,8}$/.test(str)) return null;
      var up = str.toUpperCase();
      chain = [];
      for (var i = 0; i < up.length; i++) {
        chain.push(SCENE_LETTERS.indexOf(up.charAt(i)));
      }
      if (chainPos >= chain.length) chainPos = 0;
      // Sync the serialized value attribute (wireSlider pattern) so the
      // agent-visible chain never lies.
      var input = document.getElementById('chain-input');
      if (input) {
        input.value = up;
        input.setAttribute('value', up);
      }
      return up;
    },

    getChain: function () { return getChainString(); },

    // ---- F3: playback mode + song ----

    setPlaybackMode: function (m) {
      if (m !== 'loop' && m !== 'chain' && m !== 'song') return null;
      if (api.isPlaying()) {
        pendingMode = m;          // consumed at the next bar boundary
      } else {
        playbackMode = m;
        pendingMode = null;
      }
      var sel = document.getElementById('playback-mode');
      if (sel) {
        if (sel.value !== m) sel.value = m;
        mirrorSelect('playback-mode');
      }
      updateSongStatus();
      return m;
    },

    getPlaybackMode: function () { return playbackMode; },

    // Accepts an array of sections (or {sections}) and normalizes. Never
    // throws; invalid sections are dropped with warnings; invalid optional
    // fields are stripped with warnings. ok:false leaves the current song
    // untouched.
    setSong: function (arr) {
      var errors = [];
      var warnings = [];
      if (arr && typeof arr === 'object' && !Array.isArray(arr) &&
          Array.isArray(arr.sections)) {
        arr = arr.sections;
      }
      if (!Array.isArray(arr)) {
        errors.push('song: expected an array of sections');
        return { ok: false, errors: errors, warnings: warnings };
      }
      if (arr.length > MAX_SONG_SECTIONS) {
        warnings.push('song: max ' + MAX_SONG_SECTIONS +
          ' sections, extra sections dropped');
        arr = arr.slice(0, MAX_SONG_SECTIONS);
      }
      var sections = [];
      for (var i = 0; i < arr.length; i++) {
        var sec = arr[i];
        var label = 'song[' + i + ']';
        if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
          warnings.push(label + ': not an object, section dropped');
          continue;
        }
        var sceneIdx = sceneIndex(sec.scene);
        var bars = sec.bars;
        if (sceneIdx === -1 || typeof bars !== 'number' ||
            bars !== Math.floor(bars) || bars < 1 || bars > 64) {
          warnings.push(label + ': missing scene/bars, section dropped' +
            ' (scene A-D, bars integer 1-64)');
          continue;
        }
        var norm = {
          name: (typeof sec.name === 'string') ? sec.name : '',
          scene: sceneIdx,
          bars: bars
        };
        if (sec.root !== undefined && sec.root !== null) {
          if (typeof sec.root === 'string' && selectHasOption('root-select', sec.root)) {
            norm.root = sec.root;
          } else {
            warnings.push(label + '.root: "' + sec.root + '" is not a valid root, ignored');
          }
        }
        if (sec.scale !== undefined && sec.scale !== null) {
          if (typeof sec.scale === 'string' && selectHasOption('scale-select', sec.scale)) {
            norm.scale = sec.scale;
          } else {
            warnings.push(label + '.scale: "' + sec.scale + '" is not a valid scale, ignored');
          }
        }
        var k;
        if (sec.overrides !== undefined && sec.overrides !== null) {
          if (typeof sec.overrides === 'object' && !Array.isArray(sec.overrides)) {
            var ov = {};
            var ovCount = 0;
            var blockedKeys = [];
            for (k in sec.overrides) {
              if (!sec.overrides.hasOwnProperty(k)) continue;
              if (OVERRIDE_BLOCKED.indexOf(k) !== -1) {
                blockedKeys.push(k);
              } else {
                ov[k] = sec.overrides[k];
                ovCount++;
              }
            }
            if (blockedKeys.length) {
              warnings.push(label + '.overrides: ' + blockedKeys.join('/') +
                ' keys not allowed in overrides, ignored');
            }
            if (ovCount) norm.overrides = ov;
          } else {
            warnings.push(label + '.overrides: expected an object, ignored');
          }
        }
        if (sec.ramps !== undefined && sec.ramps !== null) {
          if (typeof sec.ramps === 'object' && !Array.isArray(sec.ramps)) {
            var rp = {};
            var rpCount = 0;
            for (k in sec.ramps) {
              if (!sec.ramps.hasOwnProperty(k)) continue;
              if (!RAMPABLE.hasOwnProperty(k)) {
                warnings.push(label + '.ramps.' + k + ': not ramp-able (' +
                  RAMPABLE_NAMES + '), ignored');
                continue;
              }
              // Ramps on a disabled slider would be dropped silently at
              // section entry (startRamp skips disabled inputs); drop them
              // here WITH a warning so the LLM learns the limitation from
              // the tool output. Only crush is ever disabled (file:// gate).
              var rampInput = document.getElementById(RAMPABLE[k]);
              if (rampInput && rampInput.disabled) {
                warnings.push(label + '.ramps.' + k + ': control disabled' +
                  (k === 'crush' ? ' (bitcrush requires HTTP, not file://)' : '') +
                  ', ignored');
                continue;
              }
              var spec = sec.ramps[k];
              if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
                  typeof spec.to !== 'number' || !isFinite(spec.to)) {
                warnings.push(label + '.ramps.' + k + ': "to" must be a number, ignored');
                continue;
              }
              var entry = { to: spec.to };
              if (typeof spec.bars === 'number' && isFinite(spec.bars) && spec.bars > 0) {
                entry.bars = spec.bars;
              } else if (spec.bars !== undefined && spec.bars !== null) {
                warnings.push(label + '.ramps.' + k +
                  ': bars must be a number > 0, defaulting to section length');
              }
              rp[k] = entry;
              rpCount++;
            }
            if (rpCount) norm.ramps = rp;
          } else {
            warnings.push(label + '.ramps: expected an object, ignored');
          }
        }
        sections.push(norm);
      }
      if (!sections.length) {
        errors.push('song: no valid sections');
        return { ok: false, errors: errors, warnings: warnings };
      }
      song.sections = sections;
      songPos = 0;
      songBar = 0;
      // A new song applied while already playing in song mode must actually
      // ENTER its section 0 (scene/root/overrides/ramps) — defer to the next
      // bar boundary, where advanceBar consumes the flag. Until then
      // computeSongStatus keeps reporting the still-audible previous state
      // instead of a section that has not started yet.
      if (api.isPlaying() && playbackMode === 'song') pendingSongReset = true;
      // Rewrite the textarea with the normalized JSON (scene letters for
      // humans; round-trips through setSong unchanged).
      var ta = document.getElementById('song-input');
      if (ta) ta.value = songSectionsToJson();
      updateSongStatus();
      return { ok: true, errors: errors, warnings: warnings };
    },

    getSong: function () {
      return JSON.parse(JSON.stringify(song.sections));
    },

    // ---- F4: fills + programmatic cell access ----

    setAutoFill: function (on) {
      autoFill = !!on;
      return autoFill;
    },

    // Programmatic cell write; cell = null | {v, p}. Syncs DOM if visible.
    setCell: function (sceneIdx, row, absStep, cell) {
      var sc = sceneIndex(sceneIdx);
      if (sc === -1 || typeof row !== 'number' || row < 0 || row >= NUM_ROWS) return false;
      if (typeof absStep !== 'number' || absStep !== Math.floor(absStep) ||
          absStep < 0 || absStep >= MAX_STEPS) return false;
      scenes[sc][row][absStep] = cell ? {
        v: clamp01(typeof cell.v === 'number' && isFinite(cell.v) ? cell.v : DEFAULT_VEL),
        p: clamp01(typeof cell.p === 'number' && isFinite(cell.p) ? cell.p : DEFAULT_PROB)
      } : null;
      if (sc === editScene && Math.floor(absStep / 16) === editBar) {
        syncCellDom(row, absStep % 16);
      }
      return true;
    },

    getSceneState: function (sceneIdx) {
      var sc = sceneIndex(sceneIdx);
      if (sc === -1) return null;
      var out = [];
      for (var r = 0; r < NUM_ROWS; r++) {
        var row = [];
        for (var s = 0; s < MAX_STEPS; s++) {
          var cell = scenes[sc][r][s];
          row.push(cell ? { v: cell.v, p: cell.p } : null);
        }
        out.push(row);
      }
      return out;
    },

    setTempo: function (bpm) {
      if (!initialized) return;
      Tone.getTransport().bpm.rampTo(bpm, 0.1);
    },

    // Rampable setters take an optional trailing secs argument (used by song
    // section ramps for ONE long rampTo); default preserves the 0.05 s
    // slider behavior. `secs > 0` is false for undefined/NaN.
    setFilterCutoff: function (hz, secs) {
      if (!filter) return;
      filter.frequency.rampTo(hz, secs > 0 ? secs : 0.05);
    },

    setFilterResonance: function (q, secs) {
      if (!filter) return;
      filter.Q.rampTo(q, secs > 0 ? secs : 0.05);
    },

    setEnvelope: function (partial) {
      if (!poly || !partial) return;
      poly.set({ envelope: partial });
    },

    setWaveform: function (type) {
      if (!poly) return;
      poly.set({ oscillator: { type: type } });
    },

    setReverbWet: function (v, secs) {
      if (!reverb) return;
      reverb.wet.rampTo(v, secs > 0 ? secs : 0.05);
    },

    setDelayWet: function (v, secs) {
      if (!delay) return;
      var t = secs > 0 ? secs : 0.05;
      delay.wet.rampTo(delayStyle === 'feedback' ? v : 0, t);
      if (pingpong) pingpong.wet.rampTo(delayStyle === 'pingpong' ? v : 0, t);
    },

    setDelayStyle: function (name) {
      if (name !== 'feedback' && name !== 'pingpong') return;
      delayStyle = name;
      var input = document.getElementById('delay-wet');
      api.setDelayWet(input ? parseFloat(input.value) : 0);
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

    setMasterVolume: function (db, secs) {
      if (!masterVol) return;
      masterVol.volume.rampTo(db, secs > 0 ? secs : 0.05);
    },

    // Bipolar DJ sweep: -100..0 = lowpass closes down to 150 Hz,
    // 0..100 = highpass rises up to 6 kHz, 0 = both filters open.
    setDjFilter: function (v, secs) {
      if (!djHP || !djLP) return;
      var t = secs > 0 ? secs : 0.05;
      if (v <= 0) {
        djHP.frequency.rampTo(20, t);
        djLP.frequency.rampTo(
          v === 0 ? 20000 : 20000 * Math.pow(150 / 20000, -v / 100), t);
      } else {
        djLP.frequency.rampTo(20000, t);
        djHP.frequency.rampTo(20 * Math.pow(6000 / 20, v / 100), t);
      }
    },

    setPump: function (v) {
      if (typeof v === 'number' && isFinite(v)) {
        pumpAmount = Math.max(0, Math.min(1, v));
      }
    },

    setCrush: function (v, secs) {
      // crusher is a plain Gain passthrough (no .wet) when the BitCrusher
      // worklet is unavailable (file://) — no-op in that case.
      if (!crusher || !crusher.wet) return;
      crusher.wet.rampTo(v, secs > 0 ? secs : 0.05);
    },

    setChorusWet: function (v, secs) {
      if (!chorus) return;
      chorus.wet.rampTo(v, secs > 0 ? secs : 0.05);
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

    setLeadStyle: function (name) {
      if (name === 'pluck' && !leadPlucks.length) {
        // Worklet unavailable (file://) — keep the current style and say so,
        // mirroring setDrumKit's sampled-kit fallback.
        if (window.BYODJ_AGENT && window.BYODJ_AGENT.log) {
          window.BYODJ_AGENT.log('pluck lead style unavailable (needs HTTP); keeping ' + leadStyle);
        }
        return;
      }
      if (name === 'saw' || name === 'pluck' || name === 'bell' || name === 'duo') leadStyle = name;
    },

    setPad: function (on) {
      padOn = !!on;
      if (!padOn && padSynth) padSynth.releaseAll();
    },

    setPercVoice: function (name) {
      if (name === 'tom' || name === 'metal' || name === 'rim') percVoice = name;
    },

    setDrumKit: function (name) {
      if (name === 'sampled') {
        if (samplePlayers && samplePlayers.loaded) { drumKitMode = 'sampled'; return; }
        if (window.BYODJ_AGENT && window.BYODJ_AGENT.log) window.BYODJ_AGENT.log('sampled kit unavailable; using synth kit');
        return;
      }
      var kit = DRUM_KITS[name];
      if (!kit || !kick) return;
      drumKitMode = 'synth';
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
    // absent rows/scenes are left untouched. Never throws — every invalid
    // field becomes a warning reported back to the LLM.
    // internalOpts ({noPlay, noPattern}) is used ONLY by enterSection and is
    // not part of the public contract.
    applyComposition: function (comp, internalOpts) {
      if (!initialized) {
        return { ok: false, error: 'Synth not initialized (is Tone.js loaded?)' };
      }
      if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
        return { ok: false, error: 'Composition must be a JSON object' };
      }
      var noPlay = !!(internalOpts && internalOpts.noPlay);
      var noPattern = !!(internalOpts && internalOpts.noPattern);

      var applied = [];
      var warnings = [];
      var i, k;

      function slider(id, v, label) {
        if (v === undefined || v === null) return;
        if (typeof v !== 'number' || !isFinite(v)) {
          warnings.push(label + ': not a number, ignored');
          return;
        }
        // Disabled is NOT missing: tell the LLM why so it drops the field
        // instead of retrying. Only crush is ever disabled (file:// gate).
        var input = document.getElementById(id);
        if (input && input.disabled) {
          warnings.push(label + ': control disabled' +
            (id === 'crush-amount' ? ' (bitcrush requires HTTP, not file://)' : '') +
            ', ignored');
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

      // Apply one scene's rows. Each present row is cleared (all 64 steps)
      // then rebuilt from its entries; an entry is an integer (vel 0.9,
      // prob 1) or {step, vel?, prob?} with vel/prob clamped 0-1.
      function applyPatternRows(sceneIdx, patObj, labelPrefix, appliedPrefix) {
        if (!patObj || typeof patObj !== 'object' || Array.isArray(patObj)) {
          warnings.push(labelPrefix + ': expected an object mapping row names (' +
            ROW_KEYS.join(', ') + ') to step arrays, ignored');
          return;
        }
        for (var r = 0; r < NUM_ROWS; r++) {
          var key = ROW_KEYS[r];
          var steps = patObj[key];
          if (steps === undefined || steps === null) continue;
          if (!Array.isArray(steps)) {
            warnings.push(labelPrefix + '.' + key +
              ': expected an array of steps (integer or {step, vel, prob}), ignored');
            continue;
          }
          for (var s = 0; s < MAX_STEPS; s++) scenes[sceneIdx][r][s] = null;
          var count = 0;
          for (var j = 0; j < steps.length; j++) {
            var entry = steps[j];
            var stepIdx;
            var vel = DEFAULT_VEL;
            var prob = DEFAULT_PROB;
            if (typeof entry === 'number' && entry === Math.floor(entry)) {
              stepIdx = entry;
            } else if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
                       typeof entry.step === 'number' && entry.step === Math.floor(entry.step)) {
              stepIdx = entry.step;
              if (typeof entry.vel === 'number' && isFinite(entry.vel)) {
                vel = clamp01(entry.vel);
              } else if (entry.vel !== undefined && entry.vel !== null) {
                warnings.push(labelPrefix + '.' + key + ': vel must be a number 0-1, default 0.9 used');
              }
              if (typeof entry.prob === 'number' && isFinite(entry.prob)) {
                prob = clamp01(entry.prob);
              } else if (entry.prob !== undefined && entry.prob !== null) {
                warnings.push(labelPrefix + '.' + key + ': prob must be a number 0-1, default 1 used');
              }
            } else {
              warnings.push(labelPrefix + '.' + key + ': entry ' + JSON.stringify(entry) +
                ' is not an integer or {step, vel, prob}, ignored');
              continue;
            }
            if (stepIdx < 0 || stepIdx >= patternLength) {
              warnings.push(labelPrefix + '.' + key + ': step ' + stepIdx +
                ' out of range for patternLength ' + patternLength + ', ignored');
              continue;
            }
            scenes[sceneIdx][r][stepIdx] = { v: vel, p: prob };
            count++;
          }
          applied.push(appliedPrefix + key + ' ' + count + ' steps');
        }
        var unknown = Object.keys(patObj).filter(function (kk) {
          return ROW_KEYS.indexOf(kk) === -1;
        });
        if (unknown.length) {
          warnings.push(labelPrefix + ': unknown rows ignored: ' + unknown.join(', ') +
            ' (valid rows: ' + ROW_KEYS.join(', ') + ')');
        }
      }

      // Section overrides may not contain structural keys (warn-and-ignore).
      if (noPattern) {
        var blockedPresent = [];
        for (i = 0; i < OVERRIDE_BLOCKED.length; i++) {
          if (comp[OVERRIDE_BLOCKED[i]] !== undefined) blockedPresent.push(OVERRIDE_BLOCKED[i]);
        }
        if (blockedPresent.length) {
          warnings.push(blockedPresent.join('/') + ' keys not allowed in overrides, ignored');
        }
      }

      // 1. clearFirst — clears ALL FOUR scenes ("brand-new piece" intent).
      if (!noPattern && comp.clearFirst !== undefined && comp.clearFirst !== null) {
        if (typeof comp.clearFirst !== 'boolean') {
          warnings.push('clearFirst: expected boolean, ignored');
        } else if (comp.clearFirst) {
          clearAllScenes();
          refreshGridView();
          applied.push('all scenes cleared');
        }
      }

      // 2. patternLength — FIRST so step validation uses the new bound.
      if (!noPattern && comp.patternLength !== undefined && comp.patternLength !== null) {
        if (comp.patternLength === 16 || comp.patternLength === 32 || comp.patternLength === 64) {
          select('pattern-length', comp.patternLength, 'patternLength');
          // If the select is missing (markup not yet present), still apply
          // the engine state so step validation below is correct.
          if (patternLength !== comp.patternLength) api.setPatternLength(comp.patternLength);
        } else {
          warnings.push('patternLength: must be 16, 32 or 64, ignored');
        }
      }

      // 3. patterns — per-scene rows {A,B,C,D}.
      if (!noPattern && comp.patterns !== undefined && comp.patterns !== null) {
        if (typeof comp.patterns === 'object' && !Array.isArray(comp.patterns)) {
          var unknownScenes = [];
          for (k in comp.patterns) {
            if (!comp.patterns.hasOwnProperty(k)) continue;
            var si = sceneIndex(k);
            if (si === -1) { unknownScenes.push(k); continue; }
            applyPatternRows(si, comp.patterns[k],
              'patterns.' + SCENE_LETTERS[si], SCENE_LETTERS[si] + ': ');
          }
          if (unknownScenes.length) {
            warnings.push('patterns: unknown scenes ignored: ' + unknownScenes.join(', ') +
              ' (valid: A, B, C, D)');
          }
          refreshGridView();
        } else {
          warnings.push('patterns: expected an object with scene keys A-D, ignored');
        }
      }

      // 4. pattern (legacy) — identical handling, always targets scene A.
      if (!noPattern && comp.pattern !== undefined && comp.pattern !== null) {
        applyPatternRows(0, comp.pattern, 'pattern', '');
        refreshGridView();
      }

      // 5. chain — same path as the Apply button.
      if (!noPattern && comp.chain !== undefined && comp.chain !== null) {
        var chainSet = (typeof comp.chain === 'string') ? api.setChain(comp.chain) : null;
        if (chainSet === null) warnings.push('chain: must be 1-8 letters A-D, ignored');
        else applied.push('chain=' + chainSet);
      }

      // 6. song — validated by setSong; its errors/warnings merge here.
      if (!noPattern && comp.song !== undefined && comp.song !== null) {
        var songRes = api.setSong(comp.song);
        for (i = 0; i < songRes.warnings.length; i++) warnings.push(songRes.warnings[i]);
        if (!songRes.ok) {
          for (i = 0; i < songRes.errors.length; i++) warnings.push(songRes.errors[i]);
        } else {
          applied.push('song: ' + song.sections.length + ' sections / ' +
            songTotalBars() + ' bars');
        }
      }

      // 7. scene — scene-button pathway (syncs button data-state).
      if (!noPattern && comp.scene !== undefined && comp.scene !== null) {
        var scn = api.setScene(comp.scene);
        if (scn === null) warnings.push('scene: must be A, B, C or D, ignored');
        else applied.push('scene=' + SCENE_LETTERS[scn] + ' selected');
      }

      // 8. mode
      if (!noPattern && comp.mode !== undefined && comp.mode !== null) {
        if (comp.mode === 'loop' || comp.mode === 'chain' || comp.mode === 'song') {
          select('playback-mode', comp.mode, 'mode');
          // Fallback when the select markup is missing (idempotent if the
          // change handler above already applied/queued the mode).
          if (playbackMode !== comp.mode && pendingMode !== comp.mode) {
            api.setPlaybackMode(comp.mode);
          }
        } else {
          warnings.push('mode: must be loop, chain or song, ignored');
        }
      }

      // 9. existing settings fields, current order (mixer mutes last).
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
      select('delay-style', comp.delayStyle, 'delayStyle');
      slider('distortion-amount', comp.distortion, 'distortion');

      select('waveform-select', comp.waveform, 'waveform');
      select('scale-select', comp.scale, 'scale');
      select('root-select', comp.root, 'root');

      select('drum-kit', comp.drumKit, 'drumKit');
      select('bass-style', comp.bassStyle, 'bassStyle');
      select('lead-style', comp.leadStyle, 'leadStyle');
      select('perc-voice', comp.percVoice, 'percVoice');
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
        slider('level-pad', comp.mixer.padVol, 'padVol');
        slider('level-perc', comp.mixer.percVol, 'percVol');
        // Mutes go LAST so a requested drop isn't clobbered by other settings.
        ['kick', 'bass', 'snare', 'hats', 'lead', 'pad', 'perc'].forEach(function (ch) {
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
        var MIXER_KEYS = ['kickVol', 'bassVol', 'snareVol', 'hatsVol', 'leadVol', 'padVol', 'percVol',
          'kickMute', 'bassMute', 'snareMute', 'hatsMute', 'leadMute', 'padMute', 'percMute'];
        var unknownMixer = Object.keys(comp.mixer).filter(function (k) {
          return MIXER_KEYS.indexOf(k) === -1;
        });
        if (unknownMixer.length) {
          warnings.push('unknown mixer keys ignored: ' + unknownMixer.join(', ') + ' (valid keys: ' + MIXER_KEYS.join(', ') + '; masterVolume is top-level)');
        }
      } else if (comp.mixer !== undefined && comp.mixer !== null) {
        warnings.push('mixer: expected an object with kickVol/bassVol/snareVol/hatsVol/leadVol (dB) and kickMute/bassMute/snareMute/hatsMute/leadMute (boolean), ignored');
      }

      if (comp.pad !== undefined && comp.pad !== null) {
        if (typeof comp.pad !== 'boolean') warnings.push('pad: expected boolean, ignored');
        else {
          var padState = api.setToggleControl('pad-toggle', comp.pad);
          if (padState === null) { api.setPad(comp.pad); warnings.push('pad: control missing (engine state set directly)'); }
          applied.push('pad=' + (comp.pad ? 'on' : 'off'));
        }
      }

      // 10. autoFill — allowed in section overrides (fills during builds).
      if (comp.autoFill !== undefined && comp.autoFill !== null) {
        if (typeof comp.autoFill !== 'boolean') {
          warnings.push('autoFill: expected boolean, ignored');
        } else {
          var fillState = api.setToggleControl('fills-toggle', comp.autoFill);
          if (fillState === null) {
            // Toggle markup missing: apply the engine state directly so the
            // composition still behaves as requested.
            api.setAutoFill(comp.autoFill);
            warnings.push('autoFill: control missing (engine state set directly)');
            applied.push('autoFill=' + (comp.autoFill ? 'on' : 'off'));
          } else {
            applied.push('autoFill=' + (fillState ? 'on' : 'off'));
          }
        }
      }

      // 11. play — suppressed for section entry (noPlay): sections must
      // never restart the transport.
      var playPromise = null;
      if (!noPlay) {
        if (typeof comp.play === 'boolean') {
          playPromise = comp.play ? api.play() : null;
        } else {
          if (comp.play !== undefined && comp.play !== null) {
            warnings.push('play: expected boolean, ignored (defaulting to play)');
          }
          playPromise = api.play();
        }
      }

      return { ok: true, applied: applied, warnings: warnings, playPromise: playPromise };
    }
  };

  window.BYODJ_SYNTH = api;

  document.addEventListener('DOMContentLoaded', function () {
    api.init();
  });
})();
