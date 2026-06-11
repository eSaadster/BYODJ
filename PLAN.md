# BYODJ — Bring Your Own DJ

> **A PageAgent-powered synth that composes music from natural language.**
> Built on [alibaba/page-agent](https://github.com/alibaba/page-agent) — the in-page GUI agent that controls web interfaces via LLMs.

---

## Elevator Pitch

BYODJ is a web-based synthesizer + step sequencer. You inject PageAgent into the page, plug in your own LLM (OpenAI-compatible API), and tell it what to play in natural language. The agent reads the DOM, adjusts knobs, toggles sequencer cells, and hits Play — turning your vibes into actual music.

> *"Make it sound like a rainy Tuesday in Seattle"* → agent switches to minor, drops tempo to 72bpm, rolls off the filter, adds reverb, and plays sustained pads.

---

## Why This Works

PageAgent sees web pages as indexed interactive elements:

```
[12]<button aria-label="C4">C4</button>
[14]<input type="range" aria-label="Filter Cutoff" value="800">
[16]<select aria-label="Scale">Major</select>
[27]<button aria-label="Play Sequence">▶ Play</button>
```

The agent doesn't know it's making music. It only knows how to click buttons, slide ranges, and toggle cells. But the LLM behind it understands music theory, genres, moods, and cultural references — and translates those into DOM manipulations. **The creativity is real; the execution is mechanical.**

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  BYODJ SYNTH PAGE (single HTML file, no build step)      │
│                                                          │
│  ┌────────────────────┐  ┌────────────────────────────┐  │
│  │  Step Sequencer    │  │  Synth Controls             │  │
│  │  16 steps × 8 rows │  │  Tempo, Filter, ADSR,       │  │
│  │  (toggle grid)     │  │  Waveform, Reverb, Delay,   │  │
│  │                    │  │  Scale, Root Note            │  │
│  └────────────────────┘  └────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  🔧 LLM Config                                     │  │
│  │  [Base URL________________] [API Key____________]  │  │
│  │  [Model ID________________] [Connect & Play ▶]    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  💬 "make it more chaotic but keep the bass funky" │  │
│  │  [Send]                                            │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  🧠 Agent Status                                   │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │ ✅ Previous: Set tempo to 140, switched to   │  │  │
│  │  │    Phrygian mode                             │  │  │
│  │  │ 💾 Memory: Funk bassline in row 0, chaotic   │  │  │
│  │  │    hi-hats in rows 3-4                       │  │  │
│  │  │ 🎯 Next: Add distortion and increase filter  │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         │
         │ PageAgent (injected via <script> tag or npm)
         │ Observes DOM → sends to LLM → clicks/slides/toggles
         ▼
    User's own LLM (OpenAI-compatible endpoint)
    GPT-4o, Claude, Gemini, Qwen, local Ollama, etc.
```

**Audio Engine**: [Tone.js](https://tonejs.github.io/) — batteries-included Web Audio framework (synths, samplers, effects, transport/bpm)

**PageAgent Integration**: injected via `<script src="page-agent">` and configured with user-provided LLM credentials

---

## Core Loop

1. User types a natural language instruction (e.g., *"give me a lo-fi hip hop beat"*)
2. PageAgent's `execute()` is called with the instruction as the task
3. Agent enters ReAct loop:
   - **Observe**: reads current state of all indexed DOM elements (sequencer cells, knob values, dropdown selections)
   - **Think**: LLM reasons about what changes would satisfy the user's intent
   - **Act**: clicks grid cells, slides range inputs, selects dropdown options
4. Agent clicks the **Play** button (indexed element)
5. User **hears** the result in real-time via Tone.js
6. User gives follow-up instruction (*"now add a jazz chord progression"*) → loop repeats

---

## Hackathon Features (Pick Your Fighter)

### Core (MVP)
- [ ] Step sequencer grid (16 steps × 8 rows of toggle buttons)
- [ ] Synth parameter controls (tempo, filter cutoff, ADSR, waveform selector, reverb/delay sends)
- [ ] LLM config panel (base URL, API key, model ID)
- [ ] PageAgent injection and configuration
- [ ] Natural language input → agent executes changes → auto-plays
- [ ] Live agent thought process display (evaluation, memory, next goal)

### Stretch Goals
- [ ] **Multi-Agent Jam Session** — 3 PageAgent instances: bassist, drummer, lead synth. Each controls different rows. Shared DOM, emergent collaboration.
- [ ] **"Explain your composition"** — agent writes liner notes describing what it made and why
- [ ] **MIDI export** — downloadable .mid file of the agent's composition
- [ ] **Style transfer** — "now make this sound like Daft Punk" / "now Minecraft"
- [ ] **Audio visualization** — Web Audio API analyzer node → live waveform/canvas
- [ ] **Share URL** — encode composition state in URL hash for sharing
- [ ] **Battle mode** — two compositions side-by-side, audience votes
- [ ] **Different LLMs = different musicians** — live A/B comparison of compositions from GPT-4o vs Claude vs Qwen

---

## Why It's Hacky

1. **The agent has no ears.** It can't hear the music it makes. It must reason purely from DOM state — which knobs are at which values, which sequencer cells are toggled. When the user says "too harsh," the agent interprets that as "probably too much filter cutoff and distortion — reduce both."

2. **Multi-agent emergence.** When bassist/drummer/lead agents share a page, they can only "communicate" by reading each other's DOM changes. Agent B sees that Agent A filled row 0 and adapts its own rows. Collaboration through side effects.

3. **The thought process IS the UI.** PageAgent's `evaluation_previous_goal`, `memory`, and `next_goal` are displayed live. Watching an LLM reason about music theory purely through aria-labels and range inputs is inherently absurd and entertaining.

4. **Bring Your Own LLM.** No backend. No API costs you pay. Users plug in their own keys. The app is a static HTML file. This makes it zero-cost to run and demo.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Audio | [Tone.js](https://tonejs.github.io/) |
| Agent | [alibaba/page-agent](https://github.com/alibaba/page-agent) (npm or CDN) |
| LLM | OpenAI-compatible API (user-provided) |
| UI | Vanilla HTML/CSS/JS — no framework needed |
| Hosting | Single static HTML file — works from `file://` or any static host |

---

## File Structure

```
BYODJ/
├── PLAN.md              ← this file
├── index.html           ← the synth page (everything in one file)
├── agent-config.js      ← PageAgent setup, custom tools, prompt engineering
├── synth.js             ← Tone.js synth engine, sequencer grid, controls
├── styles.css           ← visual design (optional, can be inline in index.html)
└── README.md            ← project overview, setup instructions, demo gif
```

---

## Reference

- [alibaba/page-agent](https://github.com/alibaba/page-agent) — JavaScript in-page GUI agent. Control web interfaces with natural language.
- PageAgent npm: `npm install page-agent`
- CDN: `https://cdn.jsdelivr.net/npm/page-agent@1.9.0/dist/iife/page-agent.demo.js`
- PageAgent sees pages as indexed interactive elements + text content. No screenshots, no multi-modal LLMs needed.
- Custom tools can be added via `customTools` config. The `execute_javascript` tool allows arbitrary JS on the page.
- Multiple `PageAgent` instances can coexist on the same page, each with different `customSystemPrompt`.
