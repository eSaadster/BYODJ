# SPEC — BYODJ Song Mode (F1 Pattern Length, F2 Scenes+Chain, F3 Song Mode, F4 Velocity/Probability/Fills, Agent Upgrade)

Status: AUTHORITATIVE. This spec merges the Engine, Composer, and UI design lenses into one
conflict-free, directly implementable document. Where lenses disagreed, §1 records the decision.

## 0. File ownership

| File | Owns |
|---|---|
| `synth.js` | All engine state (scenes, song, ramps, playback state machine), scheduler, `applyComposition`, all control wiring, all DOM attribute sync. ES5 `var` IIFE; only global stays `window.BYODJ_SYNTH`. |
| `index.html` | All new markup (§3). No inline scripts. |
| `styles.css` | New CSS (§3.4). |
| `agent-config.js` | Both prompts (§8), `COMPOSITION_JSON_SCHEMA` (§7), `SET_COMPOSITION_TOOL.description`. zodLikeSchema and PageAgent lifecycle UNCHANGED except one added comment line. Only global stays `window.BYODJ_AGENT`. |
| `tests/e2e_composer.py` | Existing test must pass UNCHANGED; additions in §10. |

Hard constraints 1–7 from the task apply throughout; §9 cross-checks them.

---

## 1. Decisions (conflict resolutions)

1. **Bar pager IDs/labels**: `bar-btn-1`..`bar-btn-4`, aria-labels `Edit bar 1`..`Edit bar 4` (UI lens). 1-based is human-facing; internal 0-based index lives in non-serialized `data-bar`. Rejected `bar-tab-0..3` (engine/composer) — UI lens supplied complete markup and the 1-based labels read better for the theater agent.
2. **Auto-fill toggle**: `fills-toggle`, aria-label `Auto fills`, lives in `#master-panel` (UI lens — fills are a groove feature, peer of swing/pump). Rejected `autofill-btn`/`autofill-toggle`. Schema field stays `autoFill`.
3. **Chain input**: `chain-input` (`maxlength="8"`) + explicit `chain-apply-btn` (UI lens). Apply-on-click means the serialized `value` attribute never holds a half-typed invalid chain. Chain length cap is **8** (engine/UI) not 16 (composer) — schema regexp `^[A-Da-d]{1,8}$`.
4. **Per-scene schema key**: `patterns` (composer lens), NOT `scenes` (engine lens). The composer lens owns the schema; `patterns` reads naturally next to legacy `pattern`. The engine-internal array is still named `scenes`.
5. **Playback-mode schema key**: `mode` (composer lens), NOT `playbackMode`. Shorter on every LLM call. Engine API keeps `setPlaybackMode`.
6. **Song schema shape**: `song` is a bare **array** of sections (composer lens), not `{sections:[...]}` (engine). Simpler for the LLM. Engine-internal state keeps the `{ sections: [] }` wrapper; `setSong` accepts an array (or `{sections}` for tolerance) and normalizes.
7. **Status element**: ONE element, `#song-status`, a real `<button>` whose click is a no-op (composer lens — guarantees it lands in page-agent's interactive tree; an `<output>` might not). Its `data-state` uses the UI lens compact format (§3.3). The engine lens's separate `scene-now` span is DROPPED — the status string already carries the playing scene in every mode.
8. **Select serialization**: ALL selects mirror their value into `data-state` (`sel.setAttribute('data-state', sel.value)` at wire time and in the change handler, implemented once in `wireSelect`). Select elements have no auto-synced value attribute; data-state guarantees agent visibility. Existing selects are included because song sections mutate root/scale at runtime (`enterSection` → `setSelectControl` dispatches `change`), and the agent must be able to read the current value.
9. **Velocity display**: 3-tier non-serialized `data-vel` (`hi`/`mid`/`lo`) + `title` tooltip (UI lens) instead of a continuous `--vel` CSS var (engine). Tiers match the Alt+click cycle exactly and cost one CSS rule each. Probability gets NO visual except the `title` tooltip — it is inherently invisible (per-pass dice) and a composer-tool feature.
10. **Velocity mouse gesture**: Alt+click on an already-on cell cycles vel 0.9 → 0.6 → 0.35 → 0.9 (UI lens "cheap improvement" — adopted as required). Plain click is a pure on/off toggle (on = vel 0.9, prob 1). No probability gesture.
11. **Rampable params**: `filterCutoff, filterResonance, djFilter, reverb, delay, distortion, chorus, crush, pump, masterVolume`. **tempo is NOT rampable** (engine lens included it; rejected because section/bar durations are computed from bpm — a tempo ramp would make bar boundaries drift against the ramp math). filterResonance kept (engine lens; it is slider-backed and rampable for free).
12. **`cellDefaults` schema field**: DROPPED (composer-lens invention). It adds persistent engine state invisible to the theater agent for marginal value; defaults are fixed at vel 0.9 / prob 1.
13. **Song panel**: new `#song-panel` section between `#sound-panel` and `#llm-config-panel` (UI lens). IDs `song-input` / `song-apply-btn` / `song-status` (engine+UI naming; composer's `song-json`/`apply-song-btn` rejected).
14. **clearFirst**: clears ALL FOUR scenes and resets nothing else (engine lens) — "brand-new piece" intent; behaviorally identical to today for single-scene payloads. `applied` entry becomes `'all scenes cleared'`.
15. **Section `overrides` blocked keys**: `clearFirst, patternLength, patterns, pattern, chain, song, scene, mode, play` (union of both lenses, plus `patternLength` — changing it mid-song would break bar math). `autoFill` IS allowed in overrides (musically useful: fills only during builds).
16. **Chain advance**: per FULL pattern (patternLength steps), not per bar (engine lens). A chain letter = one full pass of that scene.
17. **song-status section index**: 0-based (matches `song[i]` warning paths the LLM sees); bar-in-section is 1-based (human/agent readable progress).
18. **Song size caps**: max 32 sections (extra sections dropped with a warning), `bars` 1..64 per section, section `name` truncated to 8 chars in status / 12 chars in `applied` summaries. Keeps `data-state` ≤ 20 chars always (§3.3 worst case = 19).

---

## 2. synth.js — data model

```js
// ---- constants ----
var NUM_ROWS = 10;
var VISIBLE_STEPS = 16;          // grid DOM is ALWAYS 16 columns (e2e pins 160 cells)
var MAX_STEPS = 64;              // every scene allocated at 64; patternLength masks it
var NUM_SCENES = 4;
var SCENE_LETTERS = ['A', 'B', 'C', 'D'];
var DEFAULT_VEL = 0.9, DEFAULT_PROB = 1;
var MAX_SONG_SECTIONS = 32;

// ---- pattern data ----
// A cell is null (off) or { v: 0..1, p: 0..1 }. Always allocated 64 wide so
// changing patternLength 16 -> 64 -> 16 never destroys data.
// scenes[sceneIdx][row][absStep]   (absStep = bar*16 + visibleCol)
var scenes = [];                 // built in init: 4 x 10 x 64, all null

// ---- edit/view state ----
var patternLength = 16;          // 16 | 32 | 64, global, shared by all scenes
var editScene = 0;               // scene shown/edited in the grid (0..3)
var editBar = 0;                 // visible 16-step window (0..patternLength/16-1)

// ---- arrangement state ----
var chain = [0];                 // parsed from chain-input ("A" default); 1..8 entries
var playbackMode = 'loop';       // 'loop' | 'chain' | 'song'
var song = { sections: [] };     // normalized section objects (§2.1)
var autoFill = false;

// ---- playback state machine (reset by play()) ----
var playStep = 0;                // 0..patternLength-1 within the PLAYING scene
var playScene = 0;
var chainPos = 0;                // index into chain (chain mode)
var songPos = 0;                 // index into song.sections (song mode)
var songBar = 0;                 // bars elapsed inside current section
var barCounter = 0;              // global bars since play() — drives fills every 4th bar
var pendingScene = null;         // loop-mode scene switch, consumed at next bar boundary
var pendingMode = null;          // playback-mode switch, consumed at next bar boundary
var activeRamps = [];            // §5.3
```

The old `grid` 10x16 boolean array is **deleted**; `scenes[editScene]` replaces it everywhere.
`getGridState()` survives as a boolean view of the visible window (§6).

### 2.1 Normalized section object (output of setSong validation)

```js
{ name: 'drop',          // string; '' allowed; truncated to 8 (status) / 12 (applied summary)
  scene: 1,              // index 0..3; accepted as 'A'..'D' (any case) or 0..3
  bars: 16,              // integer 1..64
  root: 'F',             // optional; must be a #root-select option
  scale: 'minor',        // optional; must be a #scale-select option
  overrides: { ... },    // optional partial composition; blocked keys per Decision 15
  ramps: { filterCutoff: { to: 9000, bars: 8 } } }
                         // optional; keys restricted to RAMPABLE (§5.3);
                         // to: number (clamped to slider min/max); bars: number > 0,
                         // default = the section's own bars
```

`setSong` returns `{ ok: true|false, errors: [], warnings: [] }`. Sections missing `scene` or
`bars` are dropped with a warning; invalid optional fields are stripped with a warning; a song
with 0 valid sections sets `ok: false`.

### 2.2 Every NUM_STEPS=16 / single-grid assumption to change (synth.js)

| Current code | Fix |
|---|---|
| `var NUM_STEPS = 16` (L13) | replace with `VISIBLE_STEPS` / `MAX_STEPS` / `patternLength` per use site |
| grid init (L63–69) | build `scenes` 4x10x64 of `null` |
| `var step` (L71) | playback state machine above |
| `syncCellDom`/`syncAllCells` (L130–145) | read `scenes[editScene][row][editBar*16 + col]`; also set `data-vel`/`title` (§4.1) |
| playhead (L158–177) | highlight only if `playScene===editScene && Math.floor(playStep/16)===editBar`; column = `playStep % 16` |
| `buildGrid` + click delegate (L195, L211–220) | DOM stays 16 cols; click maps `col -> editBar*16+col`; Alt+click vel cycle (§4.2) |
| `scheduleRepeat` cb (L369–399) | full rewrite (§5.1) |
| `play()` (L568–581) | reset state machine, enter section 0 in song mode (§5.4) |
| `toggleCell` (L599–604) | bounds `col < VISIBLE_STEPS`; writes `scenes[editScene][row][editBar*16+col]` |
| `clearGrid` (L606–611) | clears edit scene, all 64 steps |
| `randomizeGrid` (L613–620) | randomizes edit scene across `patternLength`; cells get `{v: DEFAULT_VEL, p: DEFAULT_PROB}` |
| `getGridState` (L622–624) | boolean view of visible window (back-compat); add `getSceneState` |
| `applyComposition` (L797–944) | extended per §6.1 |

---

## 3. index.html + styles.css — markup, IDs, serialization

### 3.1 Sequencer toolbar — two rows inserted in `#sequencer-panel` between `<h2>` and `#sequencer-grid`

```html
<div class="seq-toolbar">
  <div class="tb-group">
    <span class="tb-label">Scene</span>
    <button id="scene-btn-a" class="scene-btn" type="button" aria-label="Scene A" data-state="on"  aria-pressed="true">A</button>
    <button id="scene-btn-b" class="scene-btn" type="button" aria-label="Scene B" data-state="off" aria-pressed="false">B</button>
    <button id="scene-btn-c" class="scene-btn" type="button" aria-label="Scene C" data-state="off" aria-pressed="false">C</button>
    <button id="scene-btn-d" class="scene-btn" type="button" aria-label="Scene D" data-state="off" aria-pressed="false">D</button>
  </div>
  <div class="tb-group">
    <label class="tb-label" for="copy-scene-to">Copy to</label>
    <select id="copy-scene-to" class="tb-select" aria-label="Copy scene to" data-state="B">
      <option value="A">A</option><option value="B" selected>B</option>
      <option value="C">C</option><option value="D">D</option>
    </select>
    <button id="copy-scene-btn" class="scene-btn" type="button" aria-label="Copy scene">Copy</button>
  </div>
  <div class="tb-group">
    <label class="tb-label" for="chain-input">Chain</label>
    <input type="text" id="chain-input" aria-label="Scene chain" value="A" maxlength="8" autocomplete="off" spellcheck="false">
    <button id="chain-apply-btn" class="scene-btn" type="button" aria-label="Apply chain">Apply</button>
  </div>
</div>
<div class="seq-toolbar">
  <div class="tb-group">
    <label class="tb-label" for="playback-mode">Mode</label>
    <select id="playback-mode" class="tb-select" aria-label="Playback mode" data-state="loop">
      <option value="loop" selected>loop</option><option value="chain">chain</option><option value="song">song</option>
    </select>
  </div>
  <div class="tb-group">
    <label class="tb-label" for="pattern-length">Length</label>
    <select id="pattern-length" class="tb-select" aria-label="Pattern length" data-state="16">
      <option value="16" selected>16 steps (1 bar)</option>
      <option value="32">32 steps (2 bars)</option>
      <option value="64">64 steps (4 bars)</option>
    </select>
  </div>
  <div class="tb-group" id="bar-pager">
    <span class="tb-label">Bar</span>
    <button id="bar-btn-1" class="bar-btn" type="button" aria-label="Edit bar 1" data-state="on"  aria-pressed="true"  data-bar="0">1</button>
    <button id="bar-btn-2" class="bar-btn" type="button" aria-label="Edit bar 2" data-state="off" aria-pressed="false" data-bar="1" hidden disabled>2</button>
    <button id="bar-btn-3" class="bar-btn" type="button" aria-label="Edit bar 3" data-state="off" aria-pressed="false" data-bar="2" hidden disabled>3</button>
    <button id="bar-btn-4" class="bar-btn" type="button" aria-label="Edit bar 4" data-state="off" aria-pressed="false" data-bar="3" hidden disabled>4</button>
  </div>
</div>
```

Rules:
- `pattern-length` change shows/hides pager buttons (16 → bar 1 only; 32 → bars 1–2; 64 → all).
  Hidden buttons get BOTH `hidden` and `disabled` (excluded from agent serialization; clicks are no-ops).
- If length shrinks below the visible bar, synth.js snaps `editBar` to 0 / pager to bar 1.
- Exactly one scene button and one bar button have `data-state="on"` at any time.

### 3.2 Fills toggle — append inside `#master-panel .controls-grid`

```html
<div class="control">
  <label for="fills-toggle">Auto Fills (every 4th bar)</label>
  <button id="fills-toggle" class="toggle-btn" type="button" aria-label="Auto fills" data-state="off" aria-pressed="false">Fills</button>
</div>
```

Wired with the existing `wireToggle`.

### 3.3 Song panel — new section between `#sound-panel` and `#llm-config-panel`

```html
<section id="song-panel">
  <h2>Song</h2>
  <div class="song-row">
    <textarea id="song-input" rows="5" aria-label="Song JSON" spellcheck="false"
      placeholder='[{"name":"intro","scene":"A","bars":8},{"name":"drop","scene":"B","bars":16,"root":"F","ramps":{"filterCutoff":{"to":9000,"bars":4}}}]'></textarea>
    <button id="song-apply-btn" type="button" aria-label="Apply song">Apply</button>
  </div>
  <div class="song-readout">
    <span class="tb-label">Now</span>
    <button id="song-status" class="status-btn" type="button" aria-label="Song status" data-state="idle">&mdash;</button>
  </div>
  <p class="hint">Sections: { name, scene, bars, root?, scale?, overrides?, ramps? }. Set Mode to "song" and press Play. The composer tool is the primary editor; this textarea is the manual escape hatch.</p>
</section>
```

`#song-status` is a real button (guaranteed in page-agent's interactive tree); its click handler
is a no-op. `data-state` formats (ALL ≤ 20 chars), updated via `setAttribute` from the Draw
callback on every bar boundary and on play/stop:

| Situation | `data-state` | Worst case length |
|---|---|---|
| Stopped (any mode) | `idle` | 4 |
| Playing, loop mode | `loop A` (playing scene letter) | 6 |
| Playing, chain mode | `chain AABA @1` (chain string ≤8, `@` + 1-based position) | `chain AABACDDA @8` = 17 |
| Playing, song mode | `{idx}:{name≤8}:{scene}:{bar}/{bars}` — idx 0-based, bar 1-based | `31:breakdwn:D:64/64` = 19 |
| Song JSON parse/validation error on Apply | `error` (message goes in `textContent`) | 5 |

Full untruncated info always goes in `textContent` (humans); compact state in `data-state` (agent).

### 3.4 CSS (append to styles.css)

```css
/* ---------- Sequencer toolbar ---------- */
.seq-toolbar { display: flex; gap: 18px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 0 0 10px; }
.tb-group { display: flex; gap: 6px; align-items: center; }
.tb-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); user-select: none; }
.scene-btn, .bar-btn { padding: 4px 12px; font-size: 0.7rem; }
.scene-btn[data-state="on"] { background: var(--cyan); border-color: #8df1ff; color: #0d0b14; box-shadow: 0 0 10px var(--cyan); }
.bar-btn[data-state="on"] { background: var(--magenta); border-color: #ff7cc0; color: #0d0b14; box-shadow: 0 0 10px var(--magenta); }
.bar-btn[hidden] { display: none; }
#chain-input { width: 90px; text-transform: uppercase; padding: 4px 8px; font-size: 0.78rem; }
.tb-select { padding: 4px 8px; font-size: 0.75rem; }

/* ---------- Toggle buttons (fills — same look as mutes) ---------- */
.toggle-btn { padding: 4px 12px; font-size: 0.7rem; align-self: flex-start; }
.toggle-btn[data-state="on"] { background: var(--magenta); color: #0d0b14; box-shadow: 0 0 10px var(--magenta); }

/* ---------- Velocity tiers (data-vel is NOT serialized by page-agent) ---------- */
.cell.on[data-vel="mid"] { opacity: 0.7; }
.cell.on[data-vel="lo"]  { opacity: 0.45; }

/* ---------- Song panel ---------- */
.song-row { display: flex; gap: 12px; align-items: flex-start; }
#song-input { flex: 1; resize: vertical; font-size: 0.75rem; min-height: 90px; }
.song-readout { display: flex; gap: 10px; align-items: baseline; margin-top: 10px; }
#song-status { font-size: 0.78rem; color: var(--terminal-green); text-shadow: 0 0 6px rgba(57, 255, 142, 0.5); }
```

(If `--text-dim` / `--terminal-green` do not exist in styles.css, use the nearest existing dim-text
and accent-green color values already present in the file.)

### 3.5 Complete new aria-label inventory — 18 new elements, all ≤ 20 chars

| Element | aria-label | Chars |
|---|---|---|
| `#scene-btn-a`..`d` | `Scene A`..`Scene D` | 7 |
| `#copy-scene-to` | `Copy scene to` | 13 |
| `#copy-scene-btn` | `Copy scene` | 10 |
| `#chain-input` | `Scene chain` | 11 |
| `#chain-apply-btn` | `Apply chain` | 11 |
| `#playback-mode` | `Playback mode` | 13 |
| `#pattern-length` | `Pattern length` | 14 |
| `#bar-btn-1`..`4` | `Edit bar 1`..`Edit bar 4` | 10 |
| `#fills-toggle` | `Auto fills` | 10 |
| `#song-input` | `Song JSON` | 9 |
| `#song-apply-btn` | `Apply song` | 10 |
| `#song-status` | `Song status` | 11 |

Seven pre-existing `#controls-panel` labels exceeded the 20-char budget (constraint 3) and are
shortened: `Env Attack (sec)` (16), `Env Decay (sec)` (15), `Env Sustain (0-1)` (17),
`Env Release (sec)` (17), `Reverb (0 to 1)` (15), `Delay (0 to 1)` (14), `Distortion (0-1)` (16).
The only remaining label over 20 chars is `Instruction for the DJ agent` inside the blacklisted
`#chat-panel`, which page-agent never serializes. The non-blacklisted page max is
`LeadSeventh step 15` (19). Cell labels are NOT extended with bar/scene info — that context lives
in the bar/scene buttons' `data-state`.

### 3.6 Serialization contract (constraint 3)

| State | Element | Serialized as | Values |
|---|---|---|---|
| Active scene | `#scene-btn-a..d` | `data-state` + `aria-pressed` | `on`/`off`, exactly one `on` |
| Visible bar | `#bar-btn-1..4` | `data-state` + `aria-pressed` | `on`/`off`; out-of-range tabs `hidden disabled` |
| Pattern length | `#pattern-length` | `data-state` mirror | `16`/`32`/`64` |
| Playback mode | `#playback-mode` | `data-state` mirror | `loop`/`chain`/`song` |
| Copy target | `#copy-scene-to` | `data-state` mirror | `A`..`D` |
| Chain | `#chain-input` | `value` attribute via `setAttribute` on successful apply (wireSlider pattern) | ≤8 chars of A–D |
| Fills | `#fills-toggle` | `data-state` + `aria-pressed` via `wireToggle` | `on`/`off` |
| Song/playback position | `#song-status` | `data-state` | §3.3 formats |
| Cell on/off | `#cell-r{r}-s{s}` | `data-state` + `aria-pressed` | **unchanged** `on`/`off` |
| Cell vel/prob | `#cell-r{r}-s{s}` | NOT serialized | `data-vel` `hi`/`mid`/`lo` + `title="vel 0.90 prob 1.00"` — CSS/tooltip only |

| Existing selects (waveform, scale, root, drum kit, bass style, lead octave, lead note length) | `data-state` mirror via `wireSelect` | current option value |

`interactiveBlacklist` stays exactly `llm-config-panel` + `chat-panel`; all new controls are
outside both. `includeAttributes: ['aria-pressed']` unchanged.

---

## 4. Cell interaction & rendering (synth.js)

### 4.1 syncCellDom(row, col)

Reads `cell = scenes[editScene][row][editBar*16 + col]`:
- `data-state` = `'on'`/`'off'`, `aria-pressed` = `'true'`/`'false'` (exactly as today).
- If on: `data-vel` = `'hi'` (v ≥ 0.75) / `'mid'` (0.45 ≤ v < 0.75) / `'lo'` (v < 0.45);
  `title = 'vel ' + v.toFixed(2) + ' prob ' + p.toFixed(2)`. If off: remove `data-vel` and `title`.
- `refreshGridView()` = `syncAllCells()` over the 10x16 window; called on scene select, bar select,
  patternLength change, copyScene, applyComposition pattern writes.

### 4.2 Click delegate

- Plain click: cell off → `{v: 0.9, p: 1}`; cell on → `null`. (Click OFF discards composer-set vel/prob.)
- Alt+click (`event.altKey`) on an ON cell: cycle `v` 0.9 → 0.6 → 0.35 → 0.9 (`p` untouched).
  Alt+click on an OFF cell behaves like plain click (turns on at defaults).
- Underlying step is always `editBar*16 + dataset.step`.

---

## 5. Engine behavior

### 5.1 scheduleRepeat rewrite (still ONE scheduleRepeat('16n'), registered once in buildAudio)

```js
repeatId = transport.scheduleRepeat(function (time) {
  var st = playStep;                         // absolute step in playing scene
  var stepInBar = st % 16;
  var sc = scenes[playScene];
  var isFillBar = autoFill && (barCounter % 4 === 3);
  var inFillWindow = isFillBar && stepInBar >= 12;

  function gate(cell) {                      // probability, evaluated EVERY pass
    return cell && (cell.p >= 1 || Math.random() < cell.p);
  }

  var c;
  c = sc[0][st];
  if (gate(c)) {
    kick.triggerAttackRelease(kickNote, '16n', time, c.v);   // velocity = cell.v
    if (pumpAmount > 0) { /* existing pump dance, unchanged */ }
  }
  c = sc[1][st];
  if (gate(c)) bassSynthFor(bassStyle).triggerAttackRelease(currentRoot + '1', '16n', time, c.v);

  // Snare + closed hat: auto-fill SHADOWS (never mutates) the pattern in the
  // fill window — rising velocity 0.5 -> 0.95 across steps 12..15.
  if (inFillWindow) {
    var fv = 0.5 + 0.15 * (stepInBar - 12);
    snare.triggerAttackRelease('16n', time, fv);
    hatClosed.triggerAttackRelease('16n', time, Math.max(0.3, fv - 0.2));
  } else {
    c = sc[2][st]; if (gate(c)) snare.triggerAttackRelease('16n', time, c.v);
    c = sc[3][st]; if (gate(c)) hatClosed.triggerAttackRelease('16n', time, c.v);
  }
  c = sc[4][st]; if (gate(c)) hatOpen.triggerAttackRelease('16n', time, c.v);
  for (var r = 5; r < 10; r++) {
    c = sc[r][st];
    if (gate(c)) poly.triggerAttackRelease(noteForRow(r), leadNoteLen, time, c.v);
  }

  tickRamps();                               // §5.3 — per-16th DOM interpolation

  Tone.getDraw().schedule(function () {
    if (playScene === editScene && Math.floor(st / 16) === editBar) highlightColumn(st % 16);
    else clearPlayhead();
    updateSongStatus();                      // #song-status data-state per §3.3
  }, time);

  playStep++;
  if (playStep % 16 === 0) advanceBar(time); // every bar boundary
}, '16n');
```

### 5.2 advanceBar — ALL scene/section/mode transitions are bar-quantized

```js
function advanceBar(time) {
  barCounter++;
  if (pendingMode) {
    playbackMode = pendingMode; pendingMode = null;
    chainPos = 0; songPos = 0; songBar = 0;
    if (playbackMode === 'song' && song.sections.length) { enterSection(0, time); playStep = 0; return; }
    if (playbackMode === 'chain') { playScene = chain[0]; playStep = 0; return; }
    playScene = editScene;                   // loop (or empty song falls back to loop)
  }
  if (playbackMode === 'loop') {
    if (pendingScene !== null) { playScene = pendingScene; pendingScene = null; }
    if (playStep >= patternLength) playStep = 0;
  } else if (playbackMode === 'chain') {
    if (playStep >= patternLength) {         // chain advances per FULL pattern (Decision 16)
      playStep = 0; chainPos = (chainPos + 1) % chain.length; playScene = chain[chainPos];
    }
  } else {                                   // song
    songBar++;
    var sec = song.sections[songPos];
    if (!sec || songBar >= sec.bars) {
      songPos = (songPos + 1) % Math.max(1, song.sections.length);   // song loops
      songBar = 0; enterSection(songPos, time); playStep = 0;
    } else if (playStep >= patternLength) playStep = 0;   // scene loops inside long sections
  }
}
```

`patternLength` is always a multiple of 16, so pattern-end always coincides with a bar boundary.
A mid-play length change takes effect at the next `playStep >= patternLength` check (and clamps
`editBar`, re-hides bar tabs immediately).

`enterSection(i, time)`:

```js
function enterSection(i, time) {
  var sec = song.sections[i];
  playScene = sec.scene;
  var comp = {}, k;
  for (k in sec.overrides) if (sec.overrides.hasOwnProperty(k)) comp[k] = sec.overrides[k];
  if (sec.root)  comp.root  = sec.root;      // chord progressions / key changes
  if (sec.scale) comp.scale = sec.scale;
  api.applyComposition(comp, { noPlay: true, noPattern: true });   // constraint 4 pathway
  startRamps(sec.ramps, sec.bars);
}
```

This runs on the main thread ~lookahead (~100 ms) ahead of audible `time`; all targets are
`.set()`/`rampTo`, so it is musically inaudible and never rebuilds nodes (constraint 6).
Re-entering a section is idempotent: overrides are settings-only (`noPattern`).

### 5.3 Ramps

```js
var RAMPABLE = {
  filterCutoff: 'filter-cutoff',  filterResonance: 'filter-resonance',
  djFilter: 'dj-filter',          reverb: 'reverb-wet',
  delay: 'delay-wet',             distortion: 'distortion-amount',
  chorus: 'chorus-wet',           crush: 'crush-amount',
  pump: 'pump-amount',            masterVolume: 'master-volume'
};
```

`startRamps(ramps, sectionBars)` → for each key, `startRamp(param, to, bars || sectionBars)`:
- `seconds = bars * 4 * (60 / Tone.getTransport().bpm.value)` (4 beats/bar, computed once at
  section entry).
- **Audio**: ONE long ramp on the existing node — e.g. `filter.frequency.rampTo(to, seconds)`.
  Add an optional trailing `secs` argument to the relevant `setX` functions (default keeps today's
  0.05 s / immediate behavior, so slider wiring is untouched). `pump` has no AudioParam — it is
  interpolated purely by the DOM tick (each tick writes the state var).
- **DOM**: push `{ id, param, from: parseFloat(input.value), to, stepsTotal: bars*16, stepsDone: 0 }`
  onto `activeRamps`. `tickRamps()` (each 16th) increments `stepsDone` and calls
  `syncSliderDisplay(id, interp)` — a new helper that sets `input.value`,
  `setAttribute('value', ...)`, and the `<output>` **without dispatching `input`** (dispatching
  would fight the long audio ramp with 0.05 s mini-ramps). On completion, settle with one real
  `setRangeControl(id, to)` so everything reconciles through the normal pathway.
- A user or section writing the same slider mid-ramp: `wireSlider`'s handler removes the matching
  `activeRamps` entry (its short `rampTo` supersedes the long one).
- `stop()`: for each active ramp, freeze — `setRangeControl(id, currentInterpolatedValue)` — then
  clear `activeRamps`.

### 5.4 play / stop / mid-play semantics

- `play()`: reset `playStep=0, barCounter=0, chainPos=0, songPos=0, songBar=0, pendingScene=null,
  pendingMode=null`; `playScene = (mode==='chain') ? chain[0] : (mode==='song' && sections.length)
  ? sections[0].scene : editScene`; in song mode with ≥1 section, call `enterSection(0)` BEFORE
  `transport.start()` inside the existing `Tone.start().then(...)`. Song mode with 0 sections
  falls back to loop behavior + a console/agent-log warning. Everything else (position reset,
  `play-btn` `data-state='playing'`) unchanged.
- `stop()`: unchanged (transport stop, Draw cancel, clear playhead, `data-state='stopped'`) PLUS
  freeze ramps (§5.3) and set `#song-status` data-state to `idle`. Position state left as-is;
  `play()` re-resets.
- Scene button mid-play (loop mode): `editScene` + grid redraw immediately; `pendingScene`
  consumed at next bar boundary. While stopped: both immediate.
- `playback-mode` change mid-play: sets `pendingMode`, consumed at next bar boundary. Stopped:
  applies to state immediately; no section entry until `play()`.
- `pattern-length` change mid-play: immediate; wrap self-corrects at next bar boundary; `editBar`
  clamped; bar tabs re-hidden.
- Clear/Random buttons: operate on the FULL current scene (Clear: all 64 steps; Random: across
  `patternLength`), never just the visible bar.
- Copy scene: copies editScene's full 10x64 data (deep copy of `{v,p}` cells) into the
  `#copy-scene-to` target; edit scene stays selected.
- Chain apply: validate `/^[A-Da-d]{1,8}$/`, uppercase, parse to indices, sync the `value`
  attribute. Invalid input reverts the field to the last good value (serialized attribute never
  lies) and logs a warning to the agent log.
- Song apply (button): `JSON.parse` in try/catch → `setSong`. On error: `#song-status`
  `data-state="error"`, message in `textContent`, and a line in the agent log. On success the
  textarea is rewritten with the normalized JSON.
- `setSong` while PLAYING in song mode (Apply button or `applyComposition` with `play:false`):
  sets a `pendingSongReset` flag consumed at the next bar boundary, where `advanceBar` does
  `songPos=0; songBar=0; enterSection(0); playStep=0` — so section 0's scene/root/overrides/ramps
  actually run. Until that boundary `#song-status` keeps reporting the previous (still audible)
  state, never a section that has not been entered. `play()` clears the flag (it enters section 0
  itself); a pending mode switch also clears it for the same reason.

---

## 6. BYODJ_SYNTH public API (final)

Unchanged signatures: `init, play, stop, isPlaying, setTempo, setFilterCutoff, setFilterResonance,
setEnvelope, setReverbWet, setDelayWet, setDistortion, setWaveform, setScale, setRootNote,
setDrumKit, setBassStyle, setLeadOctave, setLeadNoteLen, setGlide, setChorusWet, setSwing,
setCrush, setPump, setDjFilter, setMasterVolume, setChannelVolume, setChannelMute,
setRangeControl, setSelectControl, setToggleControl` (some setters gain an optional trailing
`secs` arg; default preserves current behavior; `setChannelVolume`'s mute flip-off/write/flip-on
dance is byte-identical).

```js
// changed semantics, same signature
toggleCell(row, col)          // col 0-15 = VISIBLE column -> scenes[editScene][row][editBar*16+col]; returns boolean on-state
clearGrid()                   // clears the EDIT scene (all 64 steps)
randomizeGrid()               // randomizes the edit scene across patternLength (cells {v:0.9,p:1})
getGridState()                // back-compat: 10x16 booleans of the visible window
applyComposition(comp)        // extended fields per §6.1 (internal 2nd arg is not public contract)

// new
setPatternLength(len)         // 16|32|64; returns applied length or null
getPatternLength()
setScene(s)                   // 'A'-'D' or 0-3; selects edit scene, queues play-scene switch in loop mode; returns index or null
getScene()                    // edit scene index
copyScene(from, to)           // letters or indices; deep-copies cells; returns boolean
setEditBar(b)                 // 0..patternLength/16-1; repages grid; returns applied bar or null
getEditBar()
setChain(str)                 // 'AABA' (1-8 of A-D, case-insensitive); returns normalized string or null
getChain()                    // string form, e.g. 'AABA'
setPlaybackMode(m)            // 'loop'|'chain'|'song'; bar-quantized while playing; returns mode or null
getPlaybackMode()
setSong(arr)                  // array of sections (or {sections}); returns {ok, errors:[], warnings:[]}; updates textarea + song-status
getSong()                     // deep copy: array of normalized sections
setAutoFill(on)               // boolean; engine state (the fills-toggle button drives this via wireToggle)
setCell(sceneIdx, row, absStep, cell)   // cell = null | {v,p}; programmatic write, syncs DOM if visible; returns boolean
getSceneState(sceneIdx)       // 10x64 deep copy of null|{v,p}
```

Wiring rule (constraints 3+4): `pattern-length`, `playback-mode`, `copy-scene-to` via `wireSelect`
(+ data-state mirror per Decision 8); scene buttons, bar buttons, `copy-scene-btn`,
`chain-apply-btn`, `song-apply-btn` via `wireButton`; `fills-toggle` via `wireToggle`;
`chain-input` syncs its `value` attribute on successful apply. `applyComposition` drives them
exclusively through `setSelectControl` / `setToggleControl` / button-handler functions so
serialized attributes never drift.

### 6.1 applyComposition(comp, internalOpts) — apply order and validation

`internalOpts = { noPlay: true, noPattern: true }` is used ONLY by `enterSection`. Under
`noPattern`, keys `clearFirst, patternLength, patterns, pattern, chain, song, scene, mode, play`
are warn-and-ignored. Return contract unchanged:
`{ ok, applied: [], warnings: [], playPromise }` (or `{ ok:false, error }`).

Order:
1. `clearFirst` (boolean) → clears ALL four scenes; applied: `'all scenes cleared'`.
2. `patternLength` (16|32|64) → `setSelectControl('pattern-length', ...)` — FIRST so step
   validation uses the new bound. Non-enum value → warning, ignored.
3. `patterns` (`{A:{...},B:{...},...}`) → for each scene, for each present row: clear that row's
   full 64 steps, then apply entries. Each entry is an **integer or `{step, vel?, prob?}`**
   (vel default 0.9, prob default 1, both clamped 0–1; step must be an integer
   `0..patternLength-1`, else warning `patterns.B.kick: step 40 out of range for patternLength 32,
   ignored`). Unknown rows/scene keys → warning listing valid names. applied: `'A: kick 4 steps'`.
4. `pattern` (legacy) → identical row handling, always targets **scene A**. Accepts the same
   int-or-object entries. applied entries keep today's `'kick 4 steps'` shape.
5. `chain` (string) → same path as the Apply button (§5.4); applied: `'chain=AABA'`.
6. `song` (array) → `setSong`; its errors/warnings merge into the tool warnings; applied:
   `'song: 6 sections / 44 bars'`. Normalized JSON rewritten into `#song-input`.
7. `scene` (`'A'..'D'`) → `setScene` via the scene-button pathway; applied: `'scene=B selected'`.
8. `mode` → `setSelectControl('playback-mode', ...)`; applied: `'mode=song'`.
9. All existing fields in their current order (tempo, filterCutoff, filterResonance, envelope,
   reverb, delay, distortion, waveform, scale, root, drumKit, bassStyle, leadOctave, leadNoteLen,
   glide, chorus, swing, crush, pump, djFilter, masterVolume, mixer with mutes LAST) — code
   untouched.
10. `autoFill` (boolean) → `setToggleControl('fills-toggle', ...)`; applied: `'autoFill=on'`.
11. `play` — unchanged, but skipped entirely when `internalOpts.noPlay` (sections must never
    restart the transport).

After steps 3/4: `refreshGridView()`.

Example warnings the LLM must be able to see: `song[2]: missing scene/bars, section dropped`,
`song[1].ramps.tempo: not ramp-able (filterCutoff, filterResonance, djFilter, reverb, delay,
distortion, chorus, crush, pump, masterVolume), ignored`, `song[3].overrides: pattern/song/mode
keys not allowed in overrides, ignored`, `chain: must be 1-8 letters A-D, ignored`.

---

## 7. agent-config.js — COMPOSITION_JSON_SCHEMA (final literal)

The schema must stay **$ref/$defs-free**: zodLikeSchema's `toJSONSchema` short-circuit embeds it
verbatim inside page-agent's AgentOutput document, so fragment refs would resolve against the
wrong root. Shared shapes are duplicated programmatically. Add this one comment line to the
existing shim comment block: `// Schema must stay $ref-free: it is embedded inside the
AgentOutput document, so fragment refs would resolve against the wrong root.`
**zodLikeSchema code itself: zero changes.**

Replace the current `COMPOSITION_JSON_SCHEMA` block (agent-config.js L78–147) with exactly:

```js
  var NOTE_ENUM = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var SCALE_ENUM = ['major', 'minor', 'dorian', 'phrygian', 'pentatonic', 'lydian', 'mixolydian', 'harmonicMinor', 'blues'];

  // Shared step-item schema: integer or {step, vel, prob}. NO $ref/$defs —
  // this schema is embedded verbatim inside page-agent's AgentOutput schema,
  // so fragment refs would resolve against the wrong document root.
  function stepItem() {
    return {
      anyOf: [
        { type: 'integer', description: 'step index (vel 0.9, prob 1)' },
        {
          type: 'object',
          required: ['step'],
          properties: {
            step: { type: 'integer', description: '0..patternLength-1' },
            vel: { type: 'number', description: 'velocity 0-1, default 0.9. Accents 0.9-1, ghost notes 0.3-0.5' },
            prob: { type: 'number', description: 'chance 0-1 this step plays on each pass, default 1' }
          }
        }
      ]
    };
  }

  var ROW_DESCRIPTIONS = {
    kick: 'Kick drum', bass: 'Bass (plays the current root)', snare: 'Snare',
    closedHat: 'Closed hi-hat', openHat: 'Open hi-hat',
    leadRoot: 'Lead: scale root', leadThird: 'Lead: scale third',
    leadFifth: 'Lead: scale fifth', leadSeventh: 'Lead: scale seventh (jazzy)',
    leadHigh: 'Lead: root one octave up'
  };

  function sceneRowsSchema(withRowDescriptions) {
    var props = {};
    Object.keys(ROW_DESCRIPTIONS).forEach(function (k) {
      props[k] = { type: 'array', items: stepItem() };
      if (withRowDescriptions) props[k].description = ROW_DESCRIPTIONS[k];
    });
    return { type: 'object', properties: props };
  }

  var sceneA = sceneRowsSchema(true);  sceneA.description = 'Main scene';
  var sceneB = sceneRowsSchema(false); sceneB.description = 'Variation of A (same row names as A)';
  var sceneC = sceneRowsSchema(false); sceneC.description = 'Variation (e.g. breakdown)';
  var sceneD = sceneRowsSchema(false); sceneD.description = 'Variation (e.g. peak)';
  var legacyPattern = sceneRowsSchema(true);
  legacyPattern.description = 'Legacy single-scene pattern: same shape as patterns.A, applies to scene A. Prefer patterns.';

  var COMPOSITION_JSON_SCHEMA = {
    type: 'object',
    description: 'Complete or partial composition/arrangement. Omitted fields keep their current value; present pattern rows replace that row in that scene only.',
    properties: {
      clearFirst: { type: 'boolean', description: 'Clear ALL scenes before applying. Use true for a brand-new composition.' },
      patternLength: { type: 'integer', enum: [16, 32, 64], description: 'Steps per scene: 16=1 bar, 32=2 bars, 64=4 bars. A bar is 16 steps; bar 2 starts at step 16. Shared by all scenes.' },
      scene: { type: 'string', enum: ['A', 'B', 'C', 'D'], description: 'Scene selected for editing and for loop-mode playback. Default A.' },
      patterns: {
        type: 'object',
        description: 'Per-scene patterns. Each scene maps row names to the steps that are ON; a step is an integer or {step, vel, prob}. Present rows replace that row in that scene; omitted rows/scenes are kept. Make B/C/D variations of A.',
        properties: { A: sceneA, B: sceneB, C: sceneC, D: sceneD }
      },
      pattern: legacyPattern,
      chain: { type: 'string', description: 'Scene order for chain mode: 1-8 letters A-D, e.g. "AABA". Each letter plays that scene for its full patternLength.' },
      mode: { type: 'string', enum: ['loop', 'chain', 'song'], description: 'loop=repeat selected scene, chain=follow chain string, song=follow the song sections. Use song for a real arranged track.' },
      autoFill: { type: 'boolean', description: 'When true, every 4th bar gets a generated snare/hat fill with rising velocity over the last 4 steps. Pattern data is untouched.' },
      song: {
        type: 'array',
        description: 'Song-mode arrangement: ordered sections advancing on bar boundaries (1 bar = 16 steps). Set mode to "song". Max 32 sections. Replaces the current song entirely - resend ALL sections when changing any.',
        items: {
          type: 'object',
          required: ['scene', 'bars'],
          properties: {
            name: { type: 'string', description: 'Section label shown in Song status, e.g. intro/build/drop/breakdown/outro' },
            scene: { type: 'string', enum: ['A', 'B', 'C', 'D'], description: 'Scene played during this section' },
            bars: { type: 'integer', description: 'Section length in bars, 1-64' },
            root: { type: 'string', enum: NOTE_ENUM, description: 'Root override for this section. Per-section roots create chord progressions and key changes; bass and all lead rows follow.' },
            scale: { type: 'string', enum: SCALE_ENUM, description: 'Scale override for this section' },
            overrides: {
              type: 'object',
              additionalProperties: true,
              description: 'Partial composition applied at section start: any top-level fields EXCEPT patterns/pattern/song/chain/mode/scene/play/clearFirst/patternLength. E.g. {"mixer":{"kickMute":true},"reverb":0.5} for a breakdown.'
            },
            ramps: {
              type: 'object',
              description: 'Smooth sweeps starting at section start, e.g. {"filterCutoff":{"to":9000,"bars":8}}. Ramp-able: filterCutoff, filterResonance, djFilter, reverb, delay, distortion, chorus, crush, pump, masterVolume.',
              additionalProperties: {
                type: 'object',
                required: ['to'],
                properties: {
                  to: { type: 'number', description: 'target value in the param\'s normal range' },
                  bars: { type: 'number', description: 'ramp length in bars; default = the section\'s full length' }
                }
              }
            }
          }
        }
      },
      tempo: { type: 'number', description: 'Beats per minute, 60-200' },
      scale: { type: 'string', enum: SCALE_ENUM },
      root: { type: 'string', enum: NOTE_ENUM },
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
          kickVol: { type: 'number' }, bassVol: { type: 'number' }, snareVol: { type: 'number' },
          hatsVol: { type: 'number' }, leadVol: { type: 'number' },
          kickMute: { type: 'boolean' }, bassMute: { type: 'boolean' }, snareMute: { type: 'boolean' },
          hatsMute: { type: 'boolean' }, leadMute: { type: 'boolean' }
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
      play: { type: 'boolean', description: 'Start playback after applying. Default true.' }
    }
  };
```

**E2E pin check**: serialized payload still contains `"set_composition"`, `"clearFirst"`, and the
literal key `"pattern"` (note `"patterns"` would NOT satisfy the substring `'"pattern"'` — the
legacy key is load-bearing for the test as well as for back-compat). `ask_user` stays absent.

**SET_COMPOSITION_TOOL.description** (replace):

```
Apply a complete musical arrangement to the synth in ONE call: tempo, scale, sound design, mixer, effects, four pattern scenes (A-D, 16/32/64 steps, per-step velocity/probability), a scene chain, and full song-mode sections with per-section roots, overrides and parameter ramps — then start playback. Strongly prefer this over clicking individual controls.
```

`execute` / summarize logic, composer agent config (`maxSteps: 16`, `enableMask: false`,
no `ask_user`, panel hidden), theater config (`maxSteps: 80`, `enableMask: true`),
`includeAttributes: ['aria-pressed']`, `interactiveBlacklist`, and the PageAgent lifecycle:
**all unchanged.**

---

## 8. agent-config.js — prompts (final literal text)

### 8.1 `BYODJ_COMPOSER_PROMPT` (template literal; contains the pinned word `WORKFLOW`)

```
You are the composer for BYODJ, a music synthesizer web page. You cannot hear audio; reason from music theory.

Your tool "set_composition" applies an ENTIRE arranged track in one call - tempo, scale, sound design, mixer, effects, four pattern scenes, and a song arrangement - then starts playback.

SEQUENCER: a scene is patternLength steps (16=1 bar, 32=2 bars, 64=4 bars); every bar is 16 sixteenths with beats at 0,4,8,12 (bar 2 beats: 16,20,24,28; etc). Rows: kick, bass (plays the current root), snare, closedHat, openHat, plus melodic rows from the scale - leadRoot, leadThird, leadFifth, leadSeventh (jazzy), leadHigh (root +1 octave); the same step on several lead rows makes a chord.
A pattern step is an integer (vel 0.9, prob 1) or {step, vel, prob}: vel 0-1 = loudness (accents 0.9-1, ghost notes 0.3-0.5), prob 0-1 = chance it plays each pass (0.6-0.9 on extra hats/ghosts = human variation every loop).

SCENES: patterns.A-D. Make B/C/D VARIATIONS of A, not new songs: B = A + extra hats/melody (lift), C = A stripped for the breakdown (cut kick or melody, keep a hook), D = peak (busiest hats, octave-up notes, accents).

PLAYBACK mode: "loop" repeats scene `scene`; "chain" follows chain like "AABA" (1-8 letters); "song" follows the song array - use song for any real track.

SONG: ordered sections {name, scene, bars, root?, scale?, overrides?, ramps?}, switching on bar boundaries.
- Energy curve: intro 4-8 bars (sparse, dark/filtered) -> build 4-8 (add layers, ramp filterCutoff up or djFilter back to 0) -> drop 8-16 (full kit, brightest) -> breakdown 4-8 (kickMute, reverb up) -> build 4 -> drop 8-16 -> outro 4 (strip layers, ramp down). 32-64 bars total is a solid track.
- Chord progressions: per-section root changes move the WHOLE harmony (bass + all lead rows). In minor, roots A->F->C->G = i-VI-III-VII. 1-2 bars per root reads as a progression; 8+ bars reads as a key change. Keep the scale, change the root.
- overrides: any non-pattern fields applied at section start (mixer mutes/vols, effects, tempo, drumKit...). ramps: smooth sweeps, e.g. {"filterCutoff":{"to":9000,"bars":8}}; ramp-able: filterCutoff, filterResonance, djFilter, reverb, delay, distortion, chorus, crush, pump, masterVolume.
- autoFill true: a generated snare/hat fill (rising velocity) plays over the last 4 steps of every 4th bar; your pattern data is untouched.

KEY FIELDS (all optional; omitted = kept):
- patternLength 16|32|64; tempo 60-200; swing 0-0.5 (0.08 house, 0.18 lofi/hiphop).
- drumKit analog | 808 (boomy trap) | 909 (punchy house/techno) | lofi (dusty); bassStyle sub | saw (reese) | acid (303 squelch); glide 0-0.3 bass slides.
- leadOctave "3" dark | "4" | "5" sparkly; leadNoteLen 16n pluck | 8n | 4n | 2n pads; waveform sine soft, triangle mellow, square chiptune, sawtooth bright, fat* huge detuned; envelope ADSR (long attack+release = pads, short = plucky); filterCutoff 100-10000 (low=dark); filterResonance 0-20.
- scale moods: major happy, minor sad, dorian jazzy, phrygian dark, lydian dreamy, mixolydian funky, harmonicMinor dramatic, blues gritty, pentatonic safe. root C..B.
- Effects 0-1: reverb, delay, distortion, chorus, crush (lo-fi bitcrush), pump (mix ducks on every kick). djFilter -100..100 (negative = muffled lowpass, positive = thin highpass, 0 = off). masterVolume dB -36..6 (top level, NOT in mixer).
- mixer: kickVol/bassVol/snareVol/hatsVol/leadVol dB -24..6; kickMute/bassMute/snareMute/hatsMute/leadMute booleans. Mutes keep patterns - the drop/breakdown move, ideal inside section overrides.

GENRE CHEATSHEET (sound + arrangement):
house: 124, 909, saw bass, pump 0.5, swing 0.08; kick 0,4,8,12, openHat 2,6,10,14, snare 4,12. Song: 4 intro (no kick, djFilter -60) / 8 build (ramp djFilter to 0) / 16 drop / 8 breakdown (kickMute, reverb 0.5) / 16 drop / 4 outro.
techno: 134, 909, phrygian, sawtooth, distortion 0.2, pump 0.3; closedHat all 16 alternating vel 0.9/0.5. Long 8-16 bar sections, one root or i-VII, djFilter ramp into every drop.
lofi: 78, lofi kit, swing 0.18, crush 0.4, chorus 0.3, triangle, dorian, cutoff 1200, 4n; hats prob 0.7-0.9, vel 0.4-0.7. Song: 4 intro / 8 A / 8 B (root up a 4th) / 8 A / 4 outro.
trap: 140, 808, sparse kick, snare on step 8 of each bar, hat rolls = consecutive steps with vel rising 0.4->1, leadOctave "5", autoFill true; 8-bar sections, breakdown = drums muted + leadHigh hook.
synthwave: 100, fatsawtooth, chorus 0.5, reverb 0.4, minor, 8n, octave "3" chords; i-VI-III-VII via section roots, 2 bars each; verse = sparse chords scene, chorus = scene adding leadHigh + openHat.
ambient: 70, few or no drums, lydian, attack 1+, release 3+, 2n, reverb 0.7; 8-16 bar sections with drifting roots (e.g. C->F->A) and reverb/cutoff ramps instead of drums.

WORKFLOW:
1. Design the whole track first: genre settings, an energy curve with section bar counts, a root progression, scenes A-D as variations. Then call set_composition ONCE: clearFirst=true, patternLength, patterns, song (or chain), mode, plus all settings.
2. Pattern craft per bar: kick on the beats; snare 4,12 backbeat; hats between with vel/prob variation; bass locked to the kick; melody sparse (4-10 cells per bar across the lead rows, accents on downbeats).
3. Tweaks: pass only what changes - omitted fields, rows and scenes are kept, but song is replaced as a WHOLE: resend ALL sections when changing any. Add play:false to tweak without restarting the track (default play:true restarts from bar 0). Top-level "pattern" still edits scene A (legacy).
4. The tool starts playback and returns a summary. Then finish the task immediately. Do NOT click page controls or verify cells one by one unless the tool reported an error.
```

### 8.2 `BYODJ_SYSTEM_PROMPT` (theater mode, template literal)

```
You are operating BYODJ, a DJ/synth web page. You compose by manipulating its controls. You cannot hear audio; reason from control values and music theory.

PAGE LAYOUT:
- Step sequencer: 16 visible steps x 10 rows of toggle buttons labeled "{name} step {s}". A cell plays when data-state=on; one click toggles it (a fresh click turns it on at velocity 0.9, probability 1). Steps 0-15 run left to right; 0,4,8,12 are the beats. Rows: 0=Kick, 1=Bass, 2=Snare, 3=ClosedHat, 4=OpenHat, 5=LeadRoot, 6=LeadThird, 7=LeadFifth, 8=LeadSeventh (jazzy 7th), 9=LeadHigh (root an octave up). Rows 5-9 play notes from the selected scale; the same step on several lead rows makes a chord.
- The grid shows ONE bar of ONE scene at a time. "Pattern length" select: 16/32/64 steps = 1/2/4 bars per scene. "Edit bar 1".."Edit bar 4" buttons page which bar the 16 visible cells show and edit (active bar data-state=on; bars past the pattern length are disabled). Visible step s edits that bar's step s.
- Scenes: "Scene A".."Scene D" buttons pick the scene you edit (and the looped scene in loop mode); the active one has data-state=on. "Copy scene to" select + "Copy scene" button copy the current scene into the target scene - use this to make B/C/D as variations of A.
- ARRANGE: "Playback mode" select: loop (repeat current scene) | chain | song. "Scene chain" text input takes 1-8 letters A-D, e.g. AABA; click "Apply chain" - chain mode plays scenes in that order. "Song JSON" textarea + "Apply song" button: paste a JSON array of sections {name, scene, bars, root?, scale?, overrides?, ramps?}; sections advance on bar boundaries in song mode. "Song status" is a read-only readout (clicking does nothing); its data-state shows playback position: "idle", "loop A", "chain AABA @2", or "2:breakdwn:B:4/8" (section index : name : scene : bar/bars).
- MIXER: channel sliders "Kick Vol (dB)", "Bass Vol (dB)", "Snare Vol (dB)", "Hats Vol (dB)", "Lead Vol (dB)" (-24..6, 0=neutral) plus Mute toggle buttons ("Mute Kick" etc; data-state=on means MUTED). Use mutes for drops and breakdowns - never clear a pattern just to silence a part.
- MASTER & GROOVE sliders: Master Vol (dB) -36..6; DJ Filter -100..100 (negative=muffled lowpass sweep, positive=thin highpass sweep, 0=off - the classic DJ build/drop move); Pump 0-1 (mix ducks on every kick: house/EDM breathing); Bitcrush 0-1 (lo-fi grit on the whole mix); Swing 0-0.5 (0=robotic, 0.08=house, 0.18=lofi/hiphop); "Auto fills" toggle (data-state=on): every 4th bar a generated snare/hat fill plays over the last 4 steps without changing your pattern.
- CONTROLS sliders: Tempo (BPM) 60-200; Filter Cutoff (Hz) 100-10000 (lead brightness, low=dark); Filter Resonance (Q) 0-20; envelope "Env Attack (sec)", "Env Decay (sec)", "Env Sustain (0-1)", "Env Release (sec)" (long attack+release=pads, short=plucky); "Reverb (0 to 1)", "Delay (0 to 1)", "Distortion (0-1)".
- SOUND DESIGN: Drum Kit (analog, 808=boomy trap, 909=punchy house/techno, lofi=dusty); Bass Style (sub=deep thud, saw=reese/electro, acid=303 squelch); Lead Octave (3=dark, 4, 5=sparkly); Lead Note Length (16n=plucky arp, 8n, 4n, 2n=pads); Glide (seconds) 0-0.3 bass slides (303-style); Chorus 0-1 wide/dreamy.
- Dropdowns: Lead Waveform (sine=soft, triangle=mellow, square=chiptune, sawtooth=bright, fatsawtooth/fatsquare/fattriangle=huge detuned), Scale (major=happy, minor=sad, dorian=jazzy, phrygian=dark, lydian=dreamy, mixolydian=funky, harmonicMinor=dramatic, blues=gritty, pentatonic=safe), Root Note (C..B). Every dropdown's CURRENT value is in its data-state (song sections can change Root/Scale while playing).
- Transport buttons: "Play Sequence", "Stop Sequence", "Clear Grid", "Randomize Grid". Clear and Randomize act on the CURRENT scene only.

GENRE CHEATSHEET (starting points):
house: 124bpm, kit 909, kick 0,4,8,12, openHat 2,6,10,14, snare 4,12, swing 0.08, bass saw, pump 0.5; arrange AABA where B adds hats/melody.
techno: 134bpm, kit 909, closedHat all 16, phrygian, sawtooth, distortion 0.2, pump 0.3; long loops, sweep DJ Filter for builds and drops.
lofi: 78bpm, kit lofi, swing 0.18, bitcrush 0.4, chorus 0.3, triangle, dorian, cutoff 1200, note length 4n.
trap: 140bpm, kit 808, sparse kick, snare on 8, closedHat runs of consecutive steps, lead octave 5, Auto fills on.
synthwave: 100bpm, fatsawtooth, chorus 0.5, reverb 0.4, minor, note length 8n, octave 3 chords; alternate scenes as verse/chorus.
ambient: 70bpm, few or no drums, lydian, attack 1+, release 3+, note length 2n, reverb 0.7.

RULES:
1. Translate mood/genre into settings FIRST (tempo, scale, root, kit, bass style, waveform, effects), then program the grid, then arrange (scenes, chain or song, playback mode).
2. Typical bar: kick 0,4,8,12; snare 4,12; closed hats on even steps; bass locked with kick; melody sparse (4-10 cells across rows 5-9).
3. Verify each click by re-reading the cell or toggle's data-state. Sliders are set with input_text (a plain number in range); volume sliders are dB and may be negative. Before editing another bar or scene, click its "Edit bar N" or "Scene X" button and confirm data-state=on - the 16 visible cells then show THAT bar of THAT scene.
4. To build more than a loop: program scene A, use Copy scene to seed B/C/D, vary them (B adds layers, C strips for a breakdown), then set Playback mode to chain and Apply chain with e.g. AABA - or paste sections into Song JSON, click Apply song, and check Song status. Use Mute buttons for drops/breakdowns; use "Clear Grid" only before a completely new pattern (it clears just the current scene).
5. ALWAYS click "Play Sequence" as your final action before done (it shows data-state=playing while running, data-state=stopped otherwise).
```

---

## 9. Back-compat table (constraint cross-check)

| Old payload / behavior | New handling |
|---|---|
| Top-level `pattern` with integer arrays (0–15) | Applies to **scene A**; each integer becomes `{v:0.9, p:1}`; with default patternLength 16 / scene A / bar 0 it lands in the visible grid exactly as today |
| `clearFirst: true` | Clears all 4 scenes (superset of old single-grid clear; identical observable result for single-scene payloads); applied message `'all scenes cleared'` |
| `applyComposition` return value | Unchanged contract `{ok, applied, warnings, playPromise}` / `{ok:false, error}`; `execute`/log/finish-notes in agent-config.js byte-identical |
| `play` field semantics (default true) | Unchanged for public calls; suppressed only via internal `noPlay` (section entry) |
| `toggleCell(row, col)` | Same signature; now writes `scenes[editScene][row][editBar*16+col]`; identical behavior at defaults |
| `clearGrid()` / `randomizeGrid()` | Operate on current scene (identical at defaults; Random covers patternLength) |
| `getGridState()` | 10x16 booleans of the visible window (identical at defaults) |
| `cell-r{r}-s{s}` IDs, 160 cells, `data-state` on/off, aria-labels (max `LeadSeventh step 15` = 19) | Unchanged |
| Lead row trigger velocity | INTENTIONAL audible change: lead rows (5–9) trigger at `cell.v` (uniform DEFAULT_VEL 0.9) where HEAD hardcoded 0.8 — unchanged legacy payloads and hand-clicked cells play the lead ~1 dB hotter relative to the drums. Accepted per Decision 12 (uniform vel 0.9 / prob 1 defaults). |
| `play-btn`/`stop-btn`/`clear-btn`/`random-btn`, every existing slider/select/mute ID & wiring | Unchanged; `setChannelVolume` mute flip-off/write/flip-on dance preserved verbatim |
| Slider `value`-attribute syncing (`wireSlider` setAttribute) | Unchanged; ramps use the same attribute pathway via `syncSliderDisplay` + settle `setRangeControl` |
| Audio graph | Zero new nodes outside `buildAudio`; zero disposals; all changes `.set()`/`rampTo`. No new worklets/fetches — file:// keeps working (BitCrusher gating untouched) |
| Page load defaults | length 16, scene A, bar 0, mode loop, autoFill off, empty song, chain "A" → behaves exactly like today |
| Schema pins | `"set_composition"`, `"clearFirst"`, literal `"pattern"` key present; `ask_user` absent; `WORKFLOW` in composer prompt |
| Globals | Still exactly `window.BYODJ_SYNTH` and `window.BYODJ_AGENT`; ES5 `var` style throughout |

---

## 10. tests/e2e_composer.py — checklist of changes

Existing test: must pass with ZERO edits (every pin above is preserved). Additions:

1. **Schema surface**: assert serialized tools payload also contains `"patterns"`, `"patternLength"`, `"song"`, `"chain"`, `"mode"`, `"autoFill"`, `"anyOf"` (step items), `"vel"`, `"prob"`; assert `"$ref"` and `"$defs"` are ABSENT.
2. **Aria-label budget**: iterate all `[aria-label]` elements outside the blacklisted `#llm-config-panel`/`#chat-panel`; assert every label length ≤ 20 (no allowlist — the seven long `#controls-panel` labels are shortened per §3.5).
3. **New-control defaults on load**: `#pattern-length` data-state `16`; `#playback-mode` data-state `loop`; `#scene-btn-a` data-state `on` (b/c/d `off`); `#bar-btn-1` data-state `on` and `#bar-btn-2..4` hidden+disabled; `#fills-toggle` data-state `off`; `#song-status` data-state `idle`; `#chain-input` value attribute `A`.
4. **Composer scene/song payload** (extend the mocked tool-call args or add a second mocked exchange): payload with `patternLength: 32`, `patterns: {A: {...with {step,vel,prob} entries...}, B: {...}}`, `chain: "AABA"`, `song: [{name:"intro",scene:"A",bars:1},{name:"drop",scene:"B",bars:1,ramps:{filterCutoff:{to:9000,bars:1}}}]`, `mode: "song"`, `autoFill: true`. Assert after apply: `#pattern-length` data-state `32`; `#bar-btn-2` visible/enabled; `#chain-input` value attribute `AABA`; `#playback-mode` data-state `song`; `#fills-toggle` data-state `on`; `#song-input` textarea non-empty (normalized JSON); cells reflect patterns.A bar 0; vel<0.45 cell has `data-vel="lo"` while its `data-state` is still exactly `"on"`.
5. **Bar paging**: click `#bar-btn-2`; assert its data-state flips to `on` (bar-btn-1 `off`) and a cell set only in bar 2 (step ≥16) now shows `data-state="on"` at its `s = step-16` position; click `#bar-btn-1` and assert the view flips back.
6. **Scene paging + copy**: click `#scene-btn-b`; assert grid shows scene B's pattern; click `#scene-btn-a`, set `#copy-scene-to` to `C`, click `#copy-scene-btn`, click `#scene-btn-c`; assert scene C mirrors scene A's visible cells.
7. **Legacy payload regression**: keep the existing COMPOSITION_ARGS exchange asserting old 16-step `pattern` lands on scene A bar 0 (already covered by the unchanged test — no new code, just do not remove it).
8. **Song status while playing**: after the song-mode payload (which auto-plays), poll `#song-status` data-state matches regex `^\d+:[^:]{0,8}:[A-D]:\d+/\d+$`; after clicking `#stop-btn`, assert it returns to `idle`.
9. **Chain apply validation**: fill `#chain-input` with `AXBA` via Playwright, click `#chain-apply-btn`; assert the value ATTRIBUTE reverts to the last good chain (serialized attribute never lies).
10. **Prompt pins**: existing `WORKFLOW` assertion unchanged; optionally also assert `"patterns"` and `"song"` appear in the composer system prompt text.
