/* BYODJ — trace monitor scope + piano keyboard (STRATAM hardware UI) */
(function () {
  'use strict';

  var FRAME_MS = 33;
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var KEY_MAP = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12
  };
  var OCTAVE_SEMITONES = 24;

  var activeKeys = {};
  var keyButtons = {};
  var keyboardBuilt = false;

  function $(id) { return document.getElementById(id); }

  function getSynth() {
    return window.BYODJSynth || null;
  }

  function noteLabel(semitone, root, octave) {
    var rootIdx = NOTE_NAMES.indexOf(root);
    if (rootIdx < 0) rootIdx = 0;
    var idx = (rootIdx + semitone) % 12;
    var oct = parseInt(octave, 10) + Math.floor((rootIdx + semitone) / 12);
    return NOTE_NAMES[idx] + oct;
  }

  function chromaticNotes(root, octave) {
    var notes = [];
    for (var i = 0; i <= OCTAVE_SEMITONES; i++) {
      notes.push(noteLabel(i, root, octave));
    }
    return notes;
  }

  function isBlackNote(note) {
    return note.indexOf('#') !== -1;
  }

  /* ---------- Trace monitor ---------- */

  function initTraceMonitor() {
    var canvas = $('trace-monitor');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var bpmEl = $('trace-bpm-readout');
    var modeEl = $('trace-mode-readout');
    var monitorMode = $('monitor-mode-readout');
    var readout = $('trace-monitor-readout');
    var tempoSlider = $('tempo-slider');
    var playbackMode = $('playback-mode');
    var masterVol = $('master-volume');
    var audioLed = document.querySelector('[data-led="audio"]');

    function resizeCanvas() {
      var rect = canvas.parentElement.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var w = Math.max(320, Math.floor(rect.width));
      var h = 72;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function syncReadouts() {
      var bpm = tempoSlider ? tempoSlider.value : '120';
      var mode = playbackMode ? playbackMode.value : 'loop';
      var bpmText = bpm + ' BPM';
      if (bpmEl) bpmEl.textContent = bpmText;
      if (modeEl) modeEl.textContent = mode;
      if (monitorMode) monitorMode.textContent = mode;
    }

    function updateTextAlt(wavePeak) {
      if (!readout) return;
      var mv = masterVol ? masterVol.value : '0';
      var peak = typeof wavePeak === 'number' ? wavePeak.toFixed(3) : '0.000';
      readout.textContent = 'Lead waveform peak ' + peak + '. Master volume ' + mv + ' dB.';
    }

    function drawGrid(w, h) {
      ctx.strokeStyle = 'rgba(216, 212, 200, 0.12)';
      ctx.lineWidth = 1;
      for (var i = 1; i < 4; i++) {
        var y = (h / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    function drawFlatLine(w, h) {
      ctx.strokeStyle = 'rgba(216, 212, 200, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      updateTextAlt(0);
    }

    function drawWaveform(w, h, data) {
      ctx.strokeStyle = 'rgba(216, 212, 200, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      var peak = 0;
      var slice = w / data.length;
      for (var i = 0; i < data.length; i++) {
        var v = data[i];
        var abs = Math.abs(v);
        if (abs > peak) peak = abs;
        var x = i * slice;
        var y = ((1 - v) / 2) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      updateTextAlt(peak);
    }

    var lastFrame = 0;
    function loop(ts) {
      requestAnimationFrame(loop);
      if (ts - lastFrame < FRAME_MS) return;
      lastFrame = ts;

      resizeCanvas();
      syncReadouts();

      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      ctx.fillStyle = '#141615';
      ctx.fillRect(0, 0, w, h);
      drawGrid(w, h);

      var synth = getSynth();
      var analyser = synth && synth.getAnalyser ? synth.getAnalyser() : null;
      var playing = window.BYODJ_SYNTH && window.BYODJ_SYNTH.isPlaying && window.BYODJ_SYNTH.isPlaying();

      if (audioLed) audioLed.dataset.active = playing ? 'true' : 'false';

      if (analyser && typeof analyser.getValue === 'function') {
        var data = analyser.getValue();
        if (data && data.length) {
          drawWaveform(w, h, data);
          return;
        }
      }
      drawFlatLine(w, h);
    }

    if (tempoSlider) tempoSlider.addEventListener('input', syncReadouts);
    if (playbackMode) playbackMode.addEventListener('change', syncReadouts);
    if (masterVol) masterVol.addEventListener('input', function () { updateTextAlt(0); });

    syncReadouts();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    requestAnimationFrame(loop);
  }

  /* ---------- Piano keyboard ---------- */

  function getKeyboardConfig() {
    var octaveEl = $('lead-octave');
    var rootEl = $('root-select');
    var octave = octaveEl ? octaveEl.value : '4';
    var root = rootEl ? rootEl.value : 'C';
    return { root: root, octave: octave };
  }

  function setKeyActive(note, on) {
    var btn = keyButtons[note];
    if (!btn) return;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function pressNote(note) {
    if (activeKeys[note]) return;
    activeKeys[note] = true;
    setKeyActive(note, true);
    var synth = getSynth();
    if (synth && synth.attackNote) synth.attackNote(note);
    else if (synth && synth.playNote) synth.playNote(note);
  }

  function releaseNote(note) {
    if (!activeKeys[note]) return;
    delete activeKeys[note];
    setKeyActive(note, false);
    var synth = getSynth();
    if (synth && synth.releaseNote) synth.releaseNote(note);
  }

  function buildKeys(container) {
    var cfg = getKeyboardConfig();
    var notes = chromaticNotes(cfg.root, cfg.octave);
    container.innerHTML = '';

    var whiteCount = 0;
    var whitePositions = {};
    notes.forEach(function (note) {
      if (!isBlackNote(note)) {
        whitePositions[note] = whiteCount;
        whiteCount++;
      }
    });

    var whiteW = 100 / whiteCount;
    var blackW = whiteW * 0.58;

    notes.forEach(function (note) {
      if (isBlackNote(note)) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'piano-key piano-key-white';
      btn.dataset.note = note;
      btn.setAttribute('aria-label', note);
      btn.setAttribute('aria-pressed', 'false');
      btn.style.left = (whitePositions[note] * whiteW) + '%';
      btn.style.width = whiteW + '%';
      keyButtons[note] = btn;
      container.appendChild(btn);
    });

    notes.forEach(function (note) {
      if (!isBlackNote(note)) return;
      var semitone = notes.indexOf(note);
      var prevWhite = null;
      for (var i = semitone - 1; i >= 0; i--) {
        if (!isBlackNote(notes[i])) { prevWhite = notes[i]; break; }
      }
      if (!prevWhite) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'piano-key piano-key-black';
      btn.dataset.note = note;
      btn.setAttribute('aria-label', note);
      btn.setAttribute('aria-pressed', 'false');
      var left = (whitePositions[prevWhite] + 1) * whiteW - blackW / 2;
      btn.style.left = left + '%';
      btn.style.width = blackW + '%';
      keyButtons[note] = btn;
      container.appendChild(btn);
    });
  }

  function buildKeyboard() {
    var container = $('keyboard');
    if (!container || keyboardBuilt) return;
    keyboardBuilt = true;

    buildKeys(container);

    container.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('.piano-key');
      if (!btn) return;
      e.preventDefault();
      container.setPointerCapture(e.pointerId);
      pressNote(btn.dataset.note);
    });

    container.addEventListener('pointerup', function () {
      Object.keys(activeKeys).slice().forEach(releaseNote);
    });

    container.addEventListener('pointermove', function (e) {
      if (!(e.buttons & 1)) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var btn = el && el.closest ? el.closest('.piano-key') : null;
      if (!btn || !container.contains(btn)) return;
      var note = btn.dataset.note;
      Object.keys(activeKeys).forEach(function (n) {
        if (n !== note) releaseNote(n);
      });
      pressNote(note);
    });

    container.addEventListener('pointerleave', function (e) {
      if (e.buttons) return;
      Object.keys(activeKeys).forEach(releaseNote);
    });

    container.addEventListener('pointercancel', function () {
      Object.keys(activeKeys).forEach(releaseNote);
    });

    var octaveEl = $('lead-octave');
    var rootEl = $('root-select');
    function rebuild() {
      Object.keys(activeKeys).slice().forEach(releaseNote);
      keyButtons = {};
      activeKeys = {};
      buildKeys(container);
    }
    if (octaveEl) octaveEl.addEventListener('change', rebuild);
    if (rootEl) rootEl.addEventListener('change', rebuild);
  }

  function initComputerKeys() {
    var cfgNotes = function () {
      return chromaticNotes(getKeyboardConfig().root, getKeyboardConfig().octave);
    };

    function isTypingContext(el) {
      if (!el) return false;
      var tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    window.addEventListener('keydown', function (e) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingContext(e.target)) return;
      var semi = KEY_MAP[e.key.toLowerCase()];
      if (semi === undefined) return;
      var notes = cfgNotes();
      if (semi >= notes.length) return;
      e.preventDefault();
      pressNote(notes[semi]);
    });

    window.addEventListener('keyup', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingContext(e.target)) return;
      var semi = KEY_MAP[e.key.toLowerCase()];
      if (semi === undefined) return;
      var notes = cfgNotes();
      if (semi >= notes.length) return;
      e.preventDefault();
      releaseNote(notes[semi]);
    });
  }

  function initAgentLed() {
    var agentLed = document.querySelector('[data-led="agent"]');
    if (!agentLed) return;

    function syncAgent() {
      var sendBtn = $('send-btn');
      var running = sendBtn && sendBtn.classList.contains('running');
      agentLed.dataset.active = running ? 'true' : 'false';
    }

    var sendBtn = $('send-btn');
    if (sendBtn) {
      new MutationObserver(syncAgent).observe(sendBtn, { attributes: true, attributeFilter: ['class', 'disabled'] });
    }
    syncAgent();
  }

  function init() {
    initTraceMonitor();
    buildKeyboard();
    initComputerKeys();
    initAgentLed();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
