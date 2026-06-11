export const meta = {
  name: 'build-byodj',
  description: 'Build BYODJ synth end-to-end: research APIs, architect contract, build files, integrate, review, fix, smoke test',
  phases: [
    { title: 'Research', detail: 'page-agent + Tone.js API research via web' },
    { title: 'Architect', detail: 'define cross-file contract (IDs, aria-labels, interfaces)' },
    { title: 'Build', detail: 'one builder per file, parallel' },
    { title: 'Integrate', detail: 'cross-file consistency pass' },
    { title: 'Review', detail: 'parallel review dimensions, adversarial verify' },
    { title: 'Fix', detail: 'apply confirmed findings' },
    { title: 'Smoke', detail: 'syntax checks, headless load if possible, README update' },
  ],
}

const ROOT = '/Users/saadfarooq/Documents/Projects/BYODJ'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'What is wrong, where (line/section), and the concrete fix' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        },
        required: ['file', 'title', 'detail', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['isReal', 'reason'],
}

// ---------- Phase 1: Research ----------
phase('Research')
log('Researching page-agent and Tone.js APIs')

const [pageAgentApi, toneApi] = await parallel([
  () => agent(`Research the alibaba/page-agent JavaScript library so a developer can integrate it into a static HTML page WITHOUT any build step.

Use WebFetch/WebSearch on:
- https://github.com/alibaba/page-agent (README)
- https://www.npmjs.com/package/page-agent
- The CDN bundle https://cdn.jsdelivr.net/npm/page-agent@latest/dist/iife/page-agent.demo.js (fetch the first part to see the exposed global) and check what IIFE builds exist under dist/iife/ (there may be a non-demo build like page-agent.js)
- Any docs/examples in the repo (look at the repo file tree, examples folder, docs folder)

Report concretely, with exact code snippets where possible:
1. How to load it via <script> tag from CDN (exact URL and the global variable name it exposes)
2. How to construct/configure a PageAgent instance: constructor signature, config options — especially baseURL, apiKey, model (OpenAI-compatible LLM config)
3. How to run a task: the execute() method signature, what it returns
4. How to observe the agent's thought process: callbacks/events/state exposing evaluation_previous_goal, memory, next_goal (or equivalent fields) so a page can display them live
5. customSystemPrompt and customTools options: exact shape
6. Whether multiple PageAgent instances can coexist
7. Any gotchas: how it indexes DOM elements (does it rely on aria-label?), whether it needs elements visible, rate limits, how it handles range inputs and select elements

Your final message is consumed by another program, not a human — return the raw findings as dense markdown, max ~1500 words, with exact API names. If something is unknown after research, say UNKNOWN explicitly rather than guessing.`, { label: 'research:page-agent' }),

  () => agent(`Research Tone.js (latest stable, loaded from CDN with no build step) so a developer can build a web synth + step sequencer in vanilla JS.

Use WebFetch/WebSearch on https://tonejs.github.io/ and its docs. Report concretely with exact code snippets:
1. CDN script tag for the latest stable Tone.js (exact unpkg/jsdelivr URL and version)
2. Browser autoplay policy: how/when to call Tone.start() (must be in a user gesture)
3. A 16-step sequencer pattern: Tone.Transport (or Tone.getTransport()) with scheduleRepeat or Tone.Sequence, setting bpm, '16n' subdivision, start/stop
4. PolySynth + oscillator type (sine/square/sawtooth/triangle), ADSR envelope params and how to set them live
5. A separate noise/membrane synth suitable for drum rows (Tone.MembraneSynth, Tone.NoiseSynth) and triggering them
6. Effects chain: Tone.Filter (cutoff/resonance), Tone.Reverb (wet), Tone.FeedbackDelay (wet), Tone.Distortion — how to chain synth -> filter -> effects -> destination, and how to change wet/frequency live
7. How to change parameters live without clicks/glitches (rampTo, .value)
8. Note name helpers: building scales (e.g. given root note + scale type, computing note names like 'C4')
9. Common pitfalls: timing (use the callback's time argument), disposing/recreating nodes, Transport vs immediate triggering

Your final message is consumed by another program, not a human — return raw dense markdown, max ~1500 words, exact API names for the CURRENT version (note any v14 -> v15 renames like Tone.Transport -> Tone.getTransport()).`, { label: 'research:tonejs' }),
])

if (!pageAgentApi || !toneApi) {
  log('A research agent failed — proceeding with what we have')
}

// ---------- Phase 2: Architect ----------
phase('Architect')

const contract = await agent(`You are the architect for BYODJ, a hackathon web synth controlled by an LLM page agent. Read ${ROOT}/PLAN.md first.

Research findings on page-agent:
<page-agent-research>
${pageAgentApi || 'UNAVAILABLE — use the PLAN.md reference section and be conservative.'}
</page-agent-research>

Research findings on Tone.js:
<tonejs-research>
${toneApi || 'UNAVAILABLE — use well-known Tone.js v14 APIs.'}
</tonejs-research>

Produce a precise build contract that three independent builders will implement WITHOUT talking to each other. The app is static (no build step), opened via file:// — four files: index.html, styles.css, synth.js, agent-config.js.

The contract MUST specify exactly:
1. **Script load order** in index.html (CDN tags for Tone.js and page-agent, then synth.js, then agent-config.js) and any defer/module decisions.
2. **Every interactive element**: its id, element type, aria-label, and value range/options. Cover: the 16x8 sequencer grid (8 rows: which rows are which instruments — e.g. rows 0-1 bass/kick via MembraneSynth, row 2 snare/noise, rows 3-4 hats, rows 5-7 melodic via PolySynth with scale-degree mapping; decide and pin it down), tempo slider (60-200), filter cutoff + resonance sliders, ADSR (4 sliders), waveform select, reverb wet, delay wet, distortion amount, scale select (at least major/minor/dorian/phrygian/pentatonic), root note select, Play button, Stop button, Clear Grid button, Randomize button. Sequencer cells need a deterministic id scheme (e.g. cell-r{row}-s{step}) and aria-labels the agent can reason about (e.g. "Row 0 Kick Step 5, currently off") including on/off state via aria-pressed.
3. **LLM config panel**: ids for base URL input, API key input, model input, connect button.
4. **Prompt/chat panel**: ids for the instruction textarea, send button, and the agent-status display regions (previous evaluation, memory, next goal, plus a scrolling log).
5. **The JS contract between files**: synth.js exposes a single global (e.g. window.BYODJ_SYNTH) with named functions and their exact signatures (init/play/stop, setters that the UI wires to, getGridState, etc.). agent-config.js exposes window.BYODJ_AGENT with its functions. Who attaches DOM event listeners to which elements (synth.js owns all synth-control wiring including building the grid DOM; agent-config.js owns LLM config + chat panel + status display + PageAgent lifecycle). Note: the grid is BUILT dynamically by synth.js into a container div with a pinned id.
6. **PageAgent integration plan**: exact CDN URL, global name, constructor config shape mapping the user's base URL/key/model, how execute() is called with the user instruction, how thought-process updates are surfaced into the status DOM, and the customSystemPrompt text (write it — it should teach the agent the page layout: what each row is, that it should toggle cells via the buttons, set sliders, choose scale, and ALWAYS press Play at the end).
7. **Audio architecture**: which Tone nodes exist, the signal chain, how grid state maps to scheduled notes each 16th step.
8. Visual direction for styles.css in 3 sentences (dark synthwave aesthetic, grid with glowing active cells, current-step column highlight via a class like .playhead).

Be decisive — pin every name. Your final message is consumed by builder programs: output ONLY the contract as dense markdown, max ~2500 words.`, { label: 'architect' })

if (!contract) throw new Error('Architect failed — cannot build without a contract')

// ---------- Phase 3: Build ----------
phase('Build')
log('Building index.html+styles.css, synth.js, agent-config.js in parallel')

const builders = [
  {
    label: 'build:html+css',
    prompt: `You are building the UI shell for BYODJ. Read ${ROOT}/PLAN.md for context. Implement EXACTLY this contract (do not rename anything):

<contract>
${contract}
</contract>

Write TWO files:
1. ${ROOT}/index.html — full page: header/title, sequencer grid CONTAINER (empty div per contract — synth.js builds the cells), all synth control elements (sliders/selects/buttons) with the exact ids and aria-labels from the contract, LLM config panel, chat/instruction panel, agent status panel (previous evaluation / memory / next goal / log regions), transport buttons. Include the exact CDN script tags and local script tags in the contract's load order. Every control needs a visible label AND the contract's aria-label. Add data attributes for current value display next to sliders (a <span class="val"> the JS can update).
2. ${ROOT}/styles.css — dark synthwave aesthetic per the contract's visual direction: deep background, neon accent colors, CSS grid for the 17-column sequencer layout (1 row-label col + 16 steps) or whatever the contract pins, glowing .on cells, .playhead column highlight, responsive enough for a laptop screen, monospace agent-status panel styled like a terminal. Style classes that synth.js will toggle (.on, .playhead) even though the grid cells are created dynamically.

Do NOT write any JavaScript logic beyond the script tags. Do NOT create synth.js or agent-config.js. When done, return a one-paragraph summary listing every element id you created.`,
  },
  {
    label: 'build:synth.js',
    prompt: `You are building the audio engine for BYODJ. Read ${ROOT}/PLAN.md for context. Implement EXACTLY this contract (do not rename anything):

<contract>
${contract}
</contract>

Tone.js research (follow these exact APIs):
<tonejs-research>
${toneApi || 'Use well-known Tone.js v14 APIs conservatively.'}
</tonejs-research>

Write ONE file: ${ROOT}/synth.js. It must:
1. Build the 16x8 sequencer grid DOM into the contract's container div: cells with the exact id scheme and aria-labels (including live on/off state via aria-pressed AND updating the aria-label text on toggle so the page agent can read state), row labels naming the instrument.
2. Create the Tone.js audio graph per the contract: drum synths for the drum rows, PolySynth for melodic rows, signal chain through filter -> distortion -> delay -> reverb -> destination (per contract order), all parameters wired.
3. Implement the step sequencer: 16th-note loop on the Transport, reading grid state, triggering the right synth per row, using the callback time argument, with a playhead class moved across columns via Tone.Draw or requestAnimationFrame-safe scheduling.
4. Scale logic: map melodic rows to scale degrees of the selected scale + root note per the contract.
5. Wire ALL synth-control DOM listeners (sliders/selects/transport buttons per the contract's ownership rules): live param updates with rampTo where appropriate, update the .val spans, Tone.start() inside the Play click handler (autoplay policy), Stop, Clear Grid, Randomize (musically sensible random: sparse drums, scale notes).
6. Expose the contract's exact global (window.BYODJ_SYNTH or whatever it pins) with the exact function signatures.
7. Defensive: file may load before DOM ready — use DOMContentLoaded; don't crash if Tone is missing (show a console error).

Vanilla JS only, no imports (Tone is a global from CDN). When done, return a one-paragraph summary of the public API you exposed.`,
  },
  {
    label: 'build:agent-config.js',
    prompt: `You are building the PageAgent integration for BYODJ. Read ${ROOT}/PLAN.md for context. Implement EXACTLY this contract (do not rename anything):

<contract>
${contract}
</contract>

page-agent research (follow these exact APIs — if the research marks something UNKNOWN, code defensively with feature detection and a clear on-page error message):
<page-agent-research>
${pageAgentApi || 'UNAVAILABLE — follow the contract and PLAN.md reference section; feature-detect the global.'}
</page-agent-research>

Write ONE file: ${ROOT}/agent-config.js. It must:
1. Wire the LLM config panel (base URL, API key, model inputs + connect button per the contract's ids). Persist values to localStorage and restore on load. On connect: instantiate/configure the PageAgent per the research findings with the contract's customSystemPrompt; show connection status in the UI.
2. Wire the chat panel: on send, call the agent's execute() with the user instruction; disable the send button while running; append user message + agent result to the scrolling log region.
3. Surface the agent's thought process live into the status regions (previous evaluation / memory / next goal) using whatever callback/event/state mechanism the research found; if none exists, poll or hook what is available and degrade gracefully.
4. Include the contract's customSystemPrompt verbatim as a const — it teaches the agent the page: row-to-instrument mapping, that cells are toggle buttons with state in aria-label/aria-pressed, sliders ranges, that it must press Play when done.
5. Handle errors visibly: bad credentials, network failures, missing PageAgent global — all rendered into the status log, never just console.
6. Defensive: DOMContentLoaded wrapper; do not crash if the PageAgent CDN failed to load (show a message in the status panel with the script tag to check).

Vanilla JS only, no imports. When done, return a one-paragraph summary including which PageAgent API surface you used.`,
  },
]

const buildResults = await parallel(builders.map(b => () => agent(b.prompt, { label: b.label, phase: 'Build' })))
if (buildResults.filter(Boolean).length < 3) {
  log('WARNING: at least one builder failed — integrator will detect and rebuild missing pieces')
}

// ---------- Phase 4: Integrate ----------
phase('Integrate')

const integration = await agent(`You are the integrator for BYODJ at ${ROOT}. Three builders independently wrote index.html, styles.css, synth.js, agent-config.js against this contract:

<contract>
${contract}
</contract>

Read ALL FOUR files completely, then fix every cross-file mismatch by EDITING the files:
1. Every id/aria-label referenced in synth.js and agent-config.js exists in index.html (or is created dynamically by synth.js) — exact string match. Fix whichever side deviates from the contract.
2. Script tags: correct CDN URLs, correct order (Tone, page-agent, synth.js, agent-config.js), stylesheet linked.
3. The globals each script exposes/consumes line up; no duplicate event listeners on the same element from both files.
4. CSS classes toggled by JS (.on, .playhead, status classes) exist in styles.css.
5. If any file is missing or truncated, write it yourself from the contract.
6. Run: node --check ${ROOT}/synth.js && node --check ${ROOT}/agent-config.js — fix any syntax errors.

Return a terse list of every mismatch you found and fixed (file: what changed). If clean, say CLEAN.`, { label: 'integrate' })

log('Integration: ' + String(integration).slice(0, 200))

// ---------- Phase 5: Review ----------
phase('Review')

const DIMENSIONS = [
  { key: 'tone-audio', prompt: `Audio-engine correctness review of ${ROOT}/synth.js (read index.html too for context). Tone.js research for API ground truth:\n<research>\n${toneApi || ''}\n</research>\nHunt for: wrong/renamed Tone.js APIs for the loaded CDN version, Tone.start() not gated on a user gesture, scheduling without the time argument (timing drift), triggerAttackRelease misuse, effects wired in a chain that silences output (e.g. wet defaults), reverb needing async generate(), Transport never started/stopped, grid state desync with audio, scale math producing wrong notes, listeners on elements that don't exist. Only report REAL bugs that would break sound or behavior, not style.` },
  { key: 'page-agent', prompt: `PageAgent-integration review of ${ROOT}/agent-config.js (read index.html too). page-agent research for API ground truth:\n<research>\n${pageAgentApi || ''}\n</research>\nHunt for: wrong constructor/config shape vs the researched API, wrong global name or CDN URL in index.html, execute() misuse, thought-process callbacks hooked to nonexistent events, the customSystemPrompt mis-describing the actual page (row mapping, ids, ranges — cross-check against index.html and synth.js grid building), missing error paths (no key, network fail, missing global), localStorage of API key without any warning text in the UI. Only report REAL defects.` },
  { key: 'dom-wiring', prompt: `Cross-file DOM wiring review of ALL files in ${ROOT} (index.html, styles.css, synth.js, agent-config.js). Hunt for: getElementById/querySelector targets that don't exist in the final DOM, duplicate ids, event listeners attached twice to one element across the two JS files, dynamically-built grid cells whose aria-label/aria-pressed don't update on toggle (the page agent NEEDS current state readable from the DOM), CSS classes toggled in JS but undefined in styles.css, .val spans never updated, controls present in HTML but wired nowhere. Only report REAL defects.` },
  { key: 'agent-usability', prompt: `Review ${ROOT}'s files from the perspective of the LLM page agent that must drive this UI. PageAgent reads indexed interactive elements with their aria-labels and values. Hunt for: interactive elements with missing/ambiguous aria-labels, sequencer cell labels that don't state row instrument + step number + current on/off state, slider elements missing min/max/step attributes, state changes invisible in the DOM (agent can't verify its actions), a customSystemPrompt that contradicts the real element labels, no way for the agent to know the grid dimensions. Only report defects that would make the agent fail its task.` },
]

const reviewResults = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt + `\n\nReturn structured findings. detail must include the concrete fix. Report at most 6 findings — only ones you are confident in.`, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review, d) => {
    if (!review || !review.findings.length) return []
    return parallel(review.findings.map(f => () =>
      agent(`Adversarially verify this code-review finding about the BYODJ project at ${ROOT}. Read the actual file(s) and try to REFUTE it — is it actually wrong in the code as written, or did the reviewer misread? Finding:\nFile: ${f.file}\nTitle: ${f.title}\nDetail: ${f.detail}\n\nSet isReal=true only if you confirmed the defect exists in the current code.`, { label: `verify:${d.key}`, phase: 'Review', schema: VERDICT_SCHEMA })
        .then(v => v && v.isReal ? { ...f, dimension: d.key } : null)
    ))
  }
)

const confirmed = reviewResults.filter(Boolean).flat().filter(Boolean)
log(`${confirmed.length} confirmed findings across ${DIMENSIONS.length} review dimensions`)

// ---------- Phase 6: Fix ----------
phase('Fix')

let fixReport = 'No confirmed findings — nothing to fix.'
if (confirmed.length) {
  // dedupe near-identical findings by file+title
  const seen = new Set()
  const unique = confirmed.filter(f => {
    const k = f.file + '|' + f.title.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  fixReport = await agent(`Fix ALL of these confirmed defects in the BYODJ project at ${ROOT}. Read each file before editing; apply minimal, correct fixes; keep the architecture intact. After fixing, run node --check on both .js files.

Defects:
${unique.map((f, i) => `${i + 1}. [${f.severity}] ${f.file} — ${f.title}\n   ${f.detail}`).join('\n')}

Return a terse per-defect report: fixed / already-fixed / why skipped.`, { label: 'fix-all' })
}

// ---------- Phase 7: Smoke ----------
phase('Smoke')

const [smoke, docs] = await parallel([
  () => agent(`Smoke-test the BYODJ static app at ${ROOT}.
1. node --check synth.js and agent-config.js — must pass.
2. Check index.html references: every <script src> / <link href> local file exists; CDN URLs return 200 (curl -sI).
3. If a headless browser is available cheaply (check: npx playwright --version or python3 -c "import playwright"), load index.html headlessly, capture console errors, and verify the grid container gets 128 cell buttons rendered. If playwright would need a download/install, SKIP it (do not install anything) and instead do a static pass: trace every getElementById in both JS files against ids present in index.html or created dynamically.
4. Report: PASS/FAIL per check, with any console/syntax errors verbatim. Fix nothing — just report.`, { label: 'smoke-test' }),
  () => agent(`Update ${ROOT}/README.md for the now-built BYODJ project. Read index.html, synth.js, agent-config.js first. Update the Status section (built, list actual features), expand Setup with real steps matching the actual UI (open index.html, enter base URL/key/model in the LLM panel, connect, type an instruction, agent drives the synth), add a short "Manual mode" note (the synth works standalone — click cells, press Play), and a security note that the API key is stored in localStorage and calls go directly from the browser. Keep the existing tone and structure; don't touch PLAN.md.`, { label: 'docs:readme' }),
])

return {
  integration: String(integration || '').slice(0, 1500),
  confirmedFindings: confirmed.map(f => `[${f.severity}] ${f.file}: ${f.title}`),
  fixReport: String(fixReport || '').slice(0, 2000),
  smoke: String(smoke || '').slice(0, 2500),
  readme: String(docs || '').slice(0, 300),
}