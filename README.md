# BYODJ — Bring Your Own DJ

> Natural language → your LLM → DOM clicks → actual music.
> Powered by [alibaba/page-agent](https://github.com/alibaba/page-agent).

## Quick Pitch

A web synth that you control by **talking to it**. Type *"make a lo-fi hip hop beat with rain sounds"* and watch an AI agent click the sequencer grid, twist the filter knob, and hit play — all by reading the DOM.

**You bring the LLM. We bring the synth.**

## How It Works

```
You: "dark techno, 140bpm, aggressive"
       │
       ▼
  PageAgent reads the DOM (indexed buttons, sliders, selects)
       │
       ▼
  Your LLM decides: set tempo=140, waveform=sawtooth, enable distortion, toggle grid cells
       │
       ▼
  PageAgent clicks the right elements on the page
       │
       ▼
  Tone.js plays the result — you HEAR it instantly
```

## Setup

1. Open `index.html` in a browser (no build step, no server needed)
2. In the **LLM Config** panel, enter your Base URL (any OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`), API key, and model ID (e.g. `gpt-4o-mini`)
3. Pick a **DJ Mode** (see below) and click **Connect** — the endpoint must allow browser CORS
4. Type an instruction in **Talk to the DJ** (e.g. *"dark techno, 140bpm, aggressive"*) and hit **Send** (or Ctrl/Cmd+Enter); the button becomes **Stop** while the agent runs
5. Watch the agent work — follow along in the **Agent Status** panel

No backend. No build step. No API costs from us.

### DJ Modes

- **Composer (default)** — the agent gets a custom `set_composition` tool plus a full map of the page, designs the whole piece up front, and applies it in **one tool call** (tempo, scale, waveform, effects, and the entire grid), then playback starts. Fast and cheap: typically 2 LLM round trips. No screen overlay, no floating panel.
- **Theater** — the original spectacle: the agent reads the DOM and clicks every cell, drags every slider one action at a time while its floating panel narrates. Slow, expensive, mesmerizing. Great for demos.

Both modes share the same synth; switching the dropdown reconnects the agent automatically.

### Manual mode

The synth works standalone without any LLM. Click cells in the sequencer grid to toggle them, tweak the sliders and dropdowns, and press **Play** (or **Random** for instant gratification).

### Security note

Your API key is stored in this browser's localStorage (so it survives reloads), and all LLM calls go directly from your browser to the endpoint you configure. Don't use it on shared machines, and prefer scoped/disposable keys.

## Tech

- [Tone.js](https://tonejs.github.io/) — Web Audio synth engine
- [alibaba/page-agent](https://github.com/alibaba/page-agent) — in-page GUI agent
- Your LLM of choice (GPT-4o, Claude, Gemini, Qwen, Ollama, etc.)

## Status

Built and working. See [PLAN.md](./PLAN.md) for full architecture.

What's in the box:

- **16-step × 8-row sequencer** — Kick, Bass, Snare, Closed/Open Hat, plus three melodic lead rows (root/third/fifth) that follow the selected scale and root
- **Transport** — Play, Stop, Clear, Random
- **Synth controls** — tempo (60–200 BPM), lowpass filter cutoff + resonance, full ADSR envelope, reverb, delay, distortion, lead waveform (sine/square/sawtooth/triangle), scale (major/minor/dorian/phrygian/pentatonic), root note
- **LLM Config panel** — bring any OpenAI-compatible endpoint; credentials persist in localStorage
- **Agent integration** — PageAgent drives the actual UI (clicks cells, sets sliders, picks dropdowns) with a music-theory-aware system prompt, and always hits Play so you hear the result
- **Agent Status panel** — live view of the agent's evaluation, memory, next goal, and a step-by-step action log
