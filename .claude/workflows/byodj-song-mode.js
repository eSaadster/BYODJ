export const meta = {
  name: 'byodj-song-mode',
  description: 'Implement pattern length, scenes/chain, song mode, velocity/probability/fills + upgraded agent prompts across BYODJ',
  phases: [
    { title: 'Design', detail: '3 design lenses → synthesized SPEC' },
    { title: 'Engine', detail: 'synth.js: scenes, song scheduler, velocity/probability, fills' },
    { title: 'Build', detail: 'UI (index.html/styles.css) + agent prompts/schema in parallel' },
    { title: 'Tests', detail: 'extend tests/e2e_composer.py' },
    { title: 'Review', detail: '4 review dimensions' },
    { title: 'Verify', detail: 'adversarial 3-voter check per finding' },
    { title: 'Fix', detail: 'apply confirmed findings' },
    { title: 'Smoke', detail: 'node --check + Playwright e2e, fix loop' },
  ],
}

const ROOT = '/Users/saadfarooq/Documents/Projects/BYODJ'
const SPEC = ROOT + '/SPEC-SONGMODE.md'

const CONTEXT = `
REPO: ${ROOT} (branch feature/dj-expansion; working tree was clean at workflow start).
FILES:
- index.html — all markup/controls (sequencer panel, mixer, master&groove, controls, sound design, llm config, chat, status). Scripts loaded at end of body: Tone.js CDN, page-agent CDN (?autoInit=false), synth.js, agent-config.js.
- synth.js — IIFE, ES5-style 'var' code, exposes exactly window.BYODJ_SYNTH. Owns: 16-step x 10-row grid (rows: 0 Kick, 1 Bass, 2 Snare, 3 ClosedHat, 4 OpenHat, 5-9 lead scale degrees), Tone.js audio graph (built ONCE, never rebuilt; all changes via .set()/param ramps), transport scheduleRepeat('16n') playback, all control wiring (wireSlider/wireSelect/wireToggle/setRangeControl/setSelectControl/setToggleControl), and applyComposition(comp) — the one-shot composition applier used by the agent tool.
- agent-config.js — IIFE, exposes exactly window.BYODJ_AGENT. Owns: BYODJ_SYSTEM_PROMPT (theater mode: agent clicks DOM), BYODJ_COMPOSER_PROMPT (composer mode: one-shot set_composition tool), COMPOSITION_JSON_SCHEMA, the zodLikeSchema shim (page-agent expects zod v4; shim short-circuits toJSONSchema and passes parse through — field validation happens inside applyComposition and is reported back to the LLM as tool output), SET_COMPOSITION_TOOL, PageAgent lifecycle (connect, modes composer/theater, historychange log).
- styles.css — grid uses CSS grid sized for 1 label column + 16 cell columns per row.
- tests/e2e_composer.py — Playwright e2e with a mocked OpenAI endpoint (page.route on **/chat/completions). It PINS: #cell-r{r}-s{s} IDs, data-state on/off, aria-labels like "LeadSeventh step 0", 160 cells, slider value-attribute syncing, mute toggle dance, play-btn data-state=playing, no mask/panel in composer mode, "WORKFLOW" appearing in the composer system prompt, set_composition + clearFirst + pattern present in the serialized tool schema, ask_user absent.

HARD CONSTRAINTS (violating any is a critical bug):
1. Classic scripts only — no modules, no build step. Match existing ES5 'var' style in synth.js. Exactly one global per file (BYODJ_SYNTH, BYODJ_AGENT).
2. Page must keep working from file:// (BitCrusher worklet is already gated behind a protocol check — follow that pattern for anything similar).
3. page-agent serializes element state ONLY from attributes: data-state, the value ATTRIBUTE (kept in sync via setAttribute in wireSlider), aria-pressed. It TRUNCATES attribute values at 20 chars — every aria-label must stay <= 20 chars ("LeadSeventh step 15" = 19 chars is the current max). Any new state the LLM agent must see needs a serialized attribute (data-state or value), not a JS property or class.
4. applyComposition must drive the same DOM controls a human would (setRangeControl/setSelectControl/setToggleControl) so serialized attributes, <output> elements, and the audio engine stay in sync.
5. Tone.Channel mute quirk: mute writes -Infinity into the SAME volume param; see setChannelVolume's flip-off/write/flip-on dance. Preserve it.
6. Audio graph nodes are created once in buildAudio and never disposed/rebuilt.
7. Keep existing IDs and behaviors working: cell-r{r}-s{s}, play/stop/clear/random buttons, every existing slider/select ID. Old set_composition payloads (top-level pattern of 16-step rows) must still work — they apply to scene A.

FEATURE SET TO IMPLEMENT (all four):
F1. Pattern length: a global pattern length of 16, 32, or 64 steps (1/2/4 bars), selectable via a new control. The grid DOM stays 16 visible columns; a bar selector (tabs/buttons) pages which bar of the current scene is shown/edited. cell-r{r}-s{s} always refers to the VISIBLE window (s 0-15); the underlying step is bar*16+s.
F2. Scenes + chain: four patterns A/B/C/D (each rows x patternLength). Scene selector buttons to pick the edited/looped scene, a copy-scene affordance, and a chain (e.g. "AABA") used in chain playback mode.
F3. Song mode: playback mode select (loop | chain | song). A song is an ordered list of sections: { name, scene, bars, optional root/scale override (chord progressions / key changes), optional overrides (any partial composition fields incl. mixer mutes/volumes — applied at section start via the applyComposition pathway), optional ramps ({param: {to, bars}} for ramp-able params like filterCutoff/djFilter/reverb/masterVolume, ramped over the given bars) }. Sections advance on bar boundaries inside the existing scheduleRepeat. Song state visible to the theater agent via serialized attributes (e.g. data on a song/status element) and editable by humans at least via a simple textarea+apply (full song editing is primarily the composer tool's job).
F4. Musical depth: per-cell velocity (0-1) and probability (0-1, evaluated each pass) — clicking a cell toggles on at defaults (vel 0.9, prob 1); richer values come from set_composition (steps may be integers OR {step, vel, prob}). An auto-fill toggle: when on, every 4th bar the engine plays a generated snare/hat fill over the last 4 steps (rising velocity), without destroying the user's pattern data.
AGENT UPGRADE: rewrite BOTH prompts and the COMPOSITION_JSON_SCHEMA so the LLM knows the new tools/fields and how to compose BETTER tracks: song structure (intro/build/drop/breakdown/outro with bar counts and an energy curve), chord progressions via per-section root changes (e.g. i-VI-III-VII), velocity dynamics, fills, scene variation (B as a variation of A, not a different song), genre-specific arrangement guidance. The composer prompt must keep a "WORKFLOW" section (the e2e pins that word) and remain reasonably tight — it is sent on every LLM call.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'description'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          description: { type: 'string', description: 'What is wrong, why it matters, with concrete evidence (code excerpts / line refs)' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {
    isReal: { type: 'boolean', description: 'true only if the finding is a genuine bug/violation you could not refute' },
    reasoning: { type: 'string' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'filesChanged'],
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviationsFromSpec: { type: 'array', items: { type: 'string' }, description: 'Anything you did differently from SPEC-SONGMODE.md and why' },
    newControlIds: { type: 'array', items: { type: 'string' } },
  },
}

const SMOKE_SCHEMA = {
  type: 'object',
  required: ['passed', 'summary', 'failures'],
  properties: {
    passed: { type: 'boolean' },
    envSkipped: { type: 'boolean', description: 'true if the Playwright e2e could not run for environment reasons (not code bugs)' },
    summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' }, description: 'Each concrete failure with the exact error/assertion text' },
  },
}

// ---------------------------------------------------------------- Design
phase('Design')
log('Designing: 3 lenses (engine, LLM/composer, UI/serialization) → one synthesized spec')

const LENSES = [
  {
    key: 'engine',
    prompt: `You are designing the AUDIO ENGINE & DATA MODEL changes for the BYODJ feature set below. Read ${ROOT}/synth.js fully first.\n${CONTEXT}\nProduce a precise engine design: exact state shape (scenes/patterns arrays, cell representation for velocity+probability, chain, song, playback-mode state machine), exactly how the existing scheduleRepeat callback changes (step/bar/section advancement, scene switching on bar boundaries, probability evaluation, fill injection, velocity → triggerAttackRelease velocity arg), how section overrides reuse applyComposition, how ramps map onto the existing rampTo calls (compute seconds from bpm and bars), what happens on play/stop/mode-switch mid-playback, and the exact new/changed BYODJ_SYNth public API functions with signatures. Flag every place the current code assumes NUM_STEPS=16 or a single grid. Return the design as organized markdown text.`,
  },
  {
    key: 'composer',
    prompt: `You are designing the LLM-AGENT layer changes for the BYODJ feature set below. Read ${ROOT}/agent-config.js and ${ROOT}/tests/e2e_composer.py fully first.\n${CONTEXT}\nProduce: (1) the complete new COMPOSITION_JSON_SCHEMA additions as literal JSON Schema (patterns A-D with steps as integer-or-object, patternLength, chain, mode, song sections with overrides+ramps+root, fills, velocity defaults) with back-compat for the old top-level pattern; (2) the full rewritten BYODJ_COMPOSER_PROMPT text — must keep a WORKFLOW section heading, stay tight (it ships on every call), and teach the model to build an actual arranged track: energy curve, section bar counts, chord progressions via per-section roots, scene B/C/D as variations, velocity dynamics, fills, updated genre cheatsheet entries that now include arrangement; (3) the full rewritten BYODJ_SYSTEM_PROMPT (theater mode) covering the new DOM controls the click-agent can operate; (4) any changes the zod shim or SET_COMPOSITION_TOOL execute/summarize path needs. Return organized markdown with the literal prompt/schema texts inline.`,
  },
  {
    key: 'ui',
    prompt: `You are designing the UI & DOM-serialization changes for the BYODJ feature set below. Read ${ROOT}/index.html, ${ROOT}/styles.css, and the buildGrid/wireControls parts of ${ROOT}/synth.js first.\n${CONTEXT}\nProduce: exact new markup (every new element with id, aria-label <= 20 chars, data-state where the LLM agent needs to read state) for: pattern-length select, bar pager (4 bar buttons, hidden/disabled beyond current length), scene selector A-D + copy-scene control, chain text input + apply, playback-mode select, fills toggle, song textarea + apply button + a song status readout element whose serialized attributes expose current section/scene/bar so the theater agent can see arrangement state. Decide where each lands in the existing panels. Specify CSS additions (keep the existing visual language). Specify exactly how a human edits velocity (recommendation: click toggles on/off only; velocity/prob are composer-tool features — justify or improve). List every aria-label with its char count. Return organized markdown.`,
  },
]

const designs = await parallel(LENSES.map(l => () =>
  agent(l.prompt, { label: 'design:' + l.key, phase: 'Design' })
))

const synthesis = await agent(
  `You are the architecture synthesizer for the BYODJ song-mode build.\n${CONTEXT}\nBelow are three design documents from different lenses. Merge them into ONE authoritative, conflict-free spec and WRITE it to ${SPEC} (overwrite if present). The spec must be directly implementable with zero further decisions: final state shapes, final control IDs + aria-labels (each <= 20 chars, state the count), final BYODJ_SYNTH API signatures, the final literal COMPOSITION_JSON_SCHEMA JSON, the final literal text of both prompts, scheduler pseudocode, back-compat table (old payload/behavior → new handling), and a checklist of e2e test changes. Where the lenses conflict, pick one and note why in a Decisions section. Keep file ownership clear: synth.js (engine+wiring), index.html+styles.css (markup/CSS), agent-config.js (prompts/schema/tool), tests/e2e_composer.py.\n\n=== ENGINE LENS ===\n${designs[0] || '(missing)'}\n\n=== COMPOSER LENS ===\n${designs[1] || '(missing)'}\n\n=== UI LENS ===\n${designs[2] || '(missing)'}\n\nReturn a short summary of key decisions after writing the file.`,
  { label: 'design:synthesize', phase: 'Design' }
)

log('Spec written: ' + SPEC)

// ---------------------------------------------------------------- Engine
phase('Engine')
log('Implementing the engine in synth.js (single agent — everything interleaves in one file)')

const engine = await agent(
  `Implement the ENGINE portion of the BYODJ song-mode spec. Read ${SPEC} fully, then ${ROOT}/synth.js fully, then edit ${ROOT}/synth.js (and ONLY that file) to implement everything the spec assigns to synth.js: scene/pattern data model with velocity+probability cells, pattern length 16/32/64 with bar-windowed grid DOM, scene select/copy, chain, playback modes loop/chain/song, song sections with overrides (via the applyComposition pathway) and ramps, auto-fills, and the extended applyComposition fields with back-compat (old top-level pattern → scene A; integer steps → default vel 0.9 prob 1). Wire every new control ID named in the spec using the existing wireSlider/wireSelect/wireToggle/wireButton helpers (they console.error and continue if an element is missing — that is fine, the UI agent adds the markup in parallel). Preserve every hard constraint from the spec (file://, attribute serialization, mute dance, single global, ES5 style, graph built once). Validate inputs in applyComposition the way the existing code does — warnings back to the LLM, never throws. When done run: node --check ${ROOT}/synth.js and fix any syntax error.\n${CONTEXT}`,
  { label: 'impl:synth.js', phase: 'Engine', schema: IMPL_SCHEMA }
)

log('Engine done: ' + (engine ? engine.summary : 'AGENT FAILED'))

// ---------------------------------------------------------------- Build (UI + agent config in parallel — disjoint files)
phase('Build')
const engineNotes = engine ? ('Engine implementation notes: ' + engine.summary + ' New control IDs wired: ' + (engine.newControlIds || []).join(', ') + '. Deviations: ' + ((engine.deviationsFromSpec || []).join('; ') || 'none')) : 'Engine agent failed — read synth.js to see actual state.'

const built = await parallel([
  () => agent(
    `Implement the UI portion of the BYODJ song-mode spec. Read ${SPEC} fully, then ${ROOT}/index.html, ${ROOT}/styles.css, and the wireControls/buildGrid sections of ${ROOT}/synth.js (already updated — match the IDs it wires EXACTLY). Edit ONLY index.html and styles.css: add every new control/panel from the spec (pattern-length select, bar pager, scene selector + copy, chain input + apply, mode select, fills toggle, song textarea + apply + status readout) with the exact IDs synth.js wires, aria-labels <= 20 chars, data-state attributes where specified, and CSS that matches the existing visual language. Do not break any existing element or ID. ${engineNotes}\n${CONTEXT}`,
    { label: 'impl:ui', phase: 'Build', schema: IMPL_SCHEMA }
  ),
  () => agent(
    `Implement the AGENT-LAYER portion of the BYODJ song-mode spec. Read ${SPEC} fully, then ${ROOT}/agent-config.js fully, and the applyComposition function in ${ROOT}/synth.js (already updated — the schema must describe what it ACTUALLY accepts). Edit ONLY agent-config.js: replace COMPOSITION_JSON_SCHEMA with the spec's extended schema, replace BYODJ_COMPOSER_PROMPT and BYODJ_SYSTEM_PROMPT with the spec's rewritten prompts (composer prompt MUST contain the literal word WORKFLOW — the e2e pins it; keep ask_user disabled in composer mode), and update SET_COMPOSITION_TOOL's description/summary text if the spec says so. Keep the zodLikeSchema shim mechanism exactly as is. When done run: node --check ${ROOT}/agent-config.js and fix any syntax error. ${engineNotes}\n${CONTEXT}`,
    { label: 'impl:agent-config', phase: 'Build', schema: IMPL_SCHEMA }
  ),
])

const ui = built[0], agentCfg = built[1]
log('Build done — UI: ' + (ui ? ui.summary : 'FAILED') + ' | Agent config: ' + (agentCfg ? agentCfg.summary : 'FAILED'))

// ---------------------------------------------------------------- Tests
phase('Tests')
const tests = await agent(
  `Update ${ROOT}/tests/e2e_composer.py for the BYODJ song-mode build. Read ${SPEC}, then the CURRENT ${ROOT}/synth.js, ${ROOT}/agent-config.js, ${ROOT}/index.html, then the test file. Update the mocked composition + assertions so the suite covers the new features end-to-end: extended schema fields reach the LLM (patterns/chain/song/patternLength/mode in the serialized tool payload), a mocked set_composition call that uses scenes + a song arrangement + velocity-object steps applies correctly (assert via data-state/value attributes and any song-status serialized attributes), scene/bar/mode controls exist with correct aria-labels, back-compat (the OLD payload shape still lands on scene A), fills toggle exists, and all still-valid existing assertions are kept (update ones the spec legitimately changed, e.g. visible cell count if it changed — but the spec keeps 160 visible cells). Keep the mock-server pattern; the test must remain a single python3 file runnable as-is. Syntax-check with: python3 -m py_compile ${ROOT}/tests/e2e_composer.py and fix errors.\n${CONTEXT}`,
  { label: 'impl:e2e', phase: 'Tests', schema: IMPL_SCHEMA }
)
log('Tests updated: ' + (tests ? tests.summary : 'FAILED'))

// ---------------------------------------------------------------- Review → Verify (pipeline: each dimension's findings verify immediately)
phase('Review')
log('Reviewing across 4 dimensions, adversarially verifying each finding with 3 independent skeptics')

const DIMENSIONS = [
  { key: 'correctness', prompt: `Review the BYODJ song-mode implementation for ENGINE CORRECTNESS bugs. Read ${SPEC}, then ${ROOT}/synth.js in full, focusing on: the scheduleRepeat step/bar/section state machine (off-by-one in bar wraps, scene switches, section advancement, song looping/end), pattern-length changes mid-playback, probability/velocity handling, fill injection (must not corrupt pattern data), ramp time math (bars → seconds from current BPM), applyComposition validation/back-compat (old integer-step pattern → scene A), play/stop/mode-switch mid-playback, and stale playhead/Draw scheduling. Report only genuine bugs with evidence, not style preferences.` },
  { key: 'integration', prompt: `Review the BYODJ song-mode implementation for CROSS-FILE INTEGRATION breaks. Read ${SPEC}, then ${ROOT}/synth.js (wireControls + buildGrid + applyComposition), ${ROOT}/index.html, ${ROOT}/agent-config.js (schema + prompts), and ${ROOT}/tests/e2e_composer.py. Hunt: control IDs wired in synth.js but missing/mismatched in index.html (and vice versa), schema fields that applyComposition does not actually accept (or accepts but schema/prompts omit), prompt claims that do not match real DOM/labels, e2e assertions that contradict the actual markup/behavior, and <output>/value-attribute sync gaps on new controls. Report only genuine mismatches with both sides quoted.` },
  { key: 'agent-quality', prompt: `Review the BYODJ song-mode implementation for LLM-AGENT USABILITY problems. Read ${SPEC}, then ${ROOT}/agent-config.js prompts/schema and ${ROOT}/index.html. Check: every aria-label <= 20 chars (count them — page-agent truncates attribute values at 20); all state the agent must read is in serialized attributes (data-state / value attribute / aria-pressed), not classes or JS-only state; the composer prompt contains the literal word WORKFLOW, teaches arrangement (energy curve, sections, chord progressions via per-section roots, velocity, fills, scene variations) and matches the real schema; the theater prompt describes controls that actually exist and are operable by click/input_text; ask_user still disabled in composer mode; prompt length still reasonable. Report concrete problems only.` },
  { key: 'regression', prompt: `Review the BYODJ song-mode implementation for REGRESSIONS of previously-working behavior. Read ${SPEC}, then diff-read ${ROOT}/synth.js, ${ROOT}/index.html, ${ROOT}/styles.css, ${ROOT}/agent-config.js against their git HEAD versions (use: git -C ${ROOT} diff HEAD -- <file>). Check: file:// still works (no new worklets/fetches; BitCrusher gating intact), mute volume dance intact, audio graph still built once, single globals preserved, existing IDs/behaviors intact (cell-r{r}-s{s}, transport buttons, every old slider/select), clearGrid/randomizeGrid still sane with the new data model, old set_composition payloads still fully work, CSS does not break the existing grid layout (16 columns + label). Report only genuine regressions with evidence.` },
]

const reviewed = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt + '\n' + CONTEXT, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (rev, d) => {
    if (!rev || !rev.findings || !rev.findings.length) return []
    return parallel(rev.findings.map(f => () =>
      parallel([0, 1, 2].map(i => () =>
        agent(
          `Adversarially verify this code-review finding against the ACTUAL code in ${ROOT} (skeptic #${i + 1} — read the cited file(s) yourself; do not trust the description). Finding: ${JSON.stringify(f)}. Try hard to REFUTE it: is the cited behavior actually present, actually wrong, and actually consequential? If you cannot confirm it from the real code, isReal=false.`,
          { label: 'verify:' + d.key, phase: 'Verify', schema: VERDICT_SCHEMA }
        )
      )).then(votes => {
        const real = votes.filter(Boolean).filter(v => v.isReal).length
        return { ...f, dimension: d.key, votes: real, confirmed: real >= 2 }
      })
    ))
  }
)

const allFindings = reviewed.filter(Boolean).flat().filter(Boolean)
const confirmed = allFindings.filter(f => f.confirmed)
log(`Review: ${allFindings.length} raw findings, ${confirmed.length} confirmed after 3-voter verification`)

// ---------------------------------------------------------------- Fix
phase('Fix')
let fixSummary = 'no confirmed findings'
if (confirmed.length) {
  const fix = await agent(
    `Fix every confirmed review finding below in ${ROOT}. Read ${SPEC} and each cited file before editing. Apply minimal, correct fixes that preserve all hard constraints; if two findings conflict, resolve in favor of the spec and say so. After editing run: node --check ${ROOT}/synth.js && node --check ${ROOT}/agent-config.js && python3 -m py_compile ${ROOT}/tests/e2e_composer.py and fix any errors.\nFINDINGS:\n${JSON.stringify(confirmed, null, 2)}\n${CONTEXT}`,
    { label: 'fix:confirmed', phase: 'Fix', schema: IMPL_SCHEMA }
  )
  fixSummary = fix ? fix.summary : 'fix agent failed'
}
log('Fix: ' + fixSummary)

// ---------------------------------------------------------------- Smoke loop
phase('Smoke')
let smoke = null
let round = 0
while (round < 3) {
  round++
  log(`Smoke round ${round}: syntax checks + Playwright e2e`)
  smoke = await agent(
    `Smoke-test the BYODJ build in ${ROOT}. Steps: (1) node --check ${ROOT}/synth.js and node --check ${ROOT}/agent-config.js. (2) python3 -m py_compile ${ROOT}/tests/e2e_composer.py. (3) Check python3 -c "import playwright" — if missing, set envSkipped=true and do NOT install anything; otherwise run: python3 ${ROOT}/tests/e2e_composer.py (it starts its own server on port 8766; if the port is busy, kill the stale listener first). If chromium is not installed for playwright (launch error mentions executable), that is also envSkipped, not a code failure. Report passed=true only if every check that could run succeeded. Put each concrete failure (exact assertion/error text) in failures.`,
    { label: 'smoke:round' + round, phase: 'Smoke', schema: SMOKE_SCHEMA }
  )
  if (!smoke) { log('Smoke agent failed; stopping'); break }
  if (smoke.passed) { log('Smoke passed' + (smoke.envSkipped ? ' (e2e env-skipped: syntax checks only)' : '')); break }
  if (round >= 3) { log('Smoke still failing after 3 rounds'); break }
  log(`Smoke failed (${smoke.failures.length} failures) — dispatching fixer`)
  await agent(
    `The BYODJ smoke test failed. Fix the root causes in ${ROOT} (synth.js / index.html / styles.css / agent-config.js / tests/e2e_composer.py — fix the CODE unless the test assertion itself is wrong per ${SPEC}). Reproduce first where cheap, then apply minimal fixes preserving all hard constraints, then re-run the failing check yourself to confirm.\nFAILURES:\n${JSON.stringify(smoke.failures, null, 2)}\n${CONTEXT}`,
    { label: 'fix:smoke' + round, phase: 'Smoke', schema: IMPL_SCHEMA }
  )
}

return {
  spec: SPEC,
  specSummary: synthesis,
  engine: engine && engine.summary,
  ui: ui && ui.summary,
  agentConfig: agentCfg && agentCfg.summary,
  tests: tests && tests.summary,
  rawFindings: allFindings.length,
  confirmedFindings: confirmed,
  fixSummary,
  smoke,
}
