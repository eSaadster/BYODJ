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
  var LS_MODE = 'byodj.mode';

  // ---- Pinned system prompt (additive via instructions.system) -----------
  var BYODJ_SYSTEM_PROMPT = `
You are operating BYODJ, a DJ/synth web page. You compose by manipulating its controls. You cannot hear audio; reason from control values and music theory.

PAGE LAYOUT:
- Step sequencer: 16 visible steps x 11 rows of toggle buttons labeled "{name} step {s}". A cell plays when data-state=on; one click toggles it (a fresh click turns it on at velocity 0.9, probability 1). Steps 0-15 run left to right; 0,4,8,12 are the beats. Rows: 0=Kick, 1=Bass, 2=Snare, 3=ClosedHat, 4=OpenHat, 5=LeadRoot, 6=LeadThird, 7=LeadFifth, 8=LeadSeventh (jazzy 7th), 9=LeadHigh (root an octave up), 10=Perc (voice via Perc Voice select). Rows 5-9 play notes from the selected scale; the same step on several lead rows makes a chord.
- The grid shows ONE bar of ONE scene at a time. "Pattern length" select: 16/32/64 steps = 1/2/4 bars per scene. "Edit bar 1".."Edit bar 4" buttons page which bar the 16 visible cells show and edit (active bar data-state=on; bars past the pattern length are disabled). Visible step s edits that bar's step s.
- Scenes: "Scene A".."Scene D" buttons pick the scene you edit (and the looped scene in loop mode); the active one has data-state=on. "Copy scene to" select + "Copy scene" button copy the current scene into the target scene - use this to make B/C/D as variations of A.
- ARRANGE: "Playback mode" select: loop (repeat current scene) | chain | song. "Scene chain" text input takes 1-8 letters A-D, e.g. AABA; click "Apply chain" - chain mode plays scenes in that order. "Song JSON" textarea + "Apply song" button: paste a JSON array of sections {name, scene, bars, root?, scale?, overrides?, ramps?}; sections advance on bar boundaries in song mode. "Song status" is a read-only readout (clicking does nothing); its data-state shows playback position: "idle", "loop A", "chain AABA @2", or "2:breakdwn:B:4/8" (section index : name : scene : bar/bars).
- MIXER: channel sliders "Kick Vol (dB)", "Bass Vol (dB)", "Snare Vol (dB)", "Hats Vol (dB)", "Lead Vol (dB)", "Pad Vol (dB)", "Perc Vol (dB)" (-24..6, 0=neutral), Pan sliders "Kick Pan" etc (-1 left..1 right; keep kick/bass 0, spread hats/perc/lead a little), Mute toggles ("Mute Kick" etc; data-state=on means MUTED) and Solo toggles. Use mutes for drops and breakdowns - never clear a pattern just to silence a part.
- MASTER & GROOVE sliders: Master Vol (dB) -36..6; DJ Filter -100..100 (negative=muffled lowpass sweep, positive=thin highpass sweep, 0=off - the classic DJ build/drop move); Pump 0-1 (mix ducks on every kick: house/EDM breathing); Bitcrush 0-1 (lo-fi grit on the whole mix); Swing 0-0.5 (0=robotic, 0.08=house, 0.18=lofi/hiphop); "Auto fills" toggle (data-state=on): every 4th bar a generated snare/hat fill plays over the last 4 steps without changing your pattern; Humanize 0-1 (timing/velocity micro-variation on hats/snare/lead/perc - 0.2-0.4 human feel, 0 machine-tight); master EQ sliders "EQ Low/Mid/High (dB)" -12..12.
- CONTROLS sliders: Tempo (BPM) 60-200; Filter Cutoff (Hz) 100-10000 (lead brightness, low=dark); Filter Resonance (Q) 0-20; envelope "Env Attack (sec)", "Env Decay (sec)", "Env Sustain (0-1)", "Env Release (sec)" (long attack+release=pads, short=plucky); "Reverb (0 to 1)", "Delay (0 to 1)", "Delay Style" feedback/pingpong, "Distortion (0-1)".
- SOUND DESIGN: Drum Kit (analog, 808=boomy trap, 909=punchy house/techno, lofi=dusty, sampled=recorded HTTP-only); Bass Style (sub=deep thud, saw=reese/electro, acid=303 squelch); Lead Style (saw=filter-swept poly/pluck/bell=glassy celeste/duo/seaboard=fat expressive ROLI-style bloom/keys=warm Rhodes e-piano/piano=REAL sampled acoustic grand with reverb - use for piano-like & emotional leads; piano & keys ignore Filter Cutoff); Pad Layer toggle (sustained chord per bar, follows root/scale) + Pad Voice (warm/glass/strings/dark); Perc Voice (tom/metal/rim) for the Perc row; Lead Octave (3=dark, 4, 5=sparkly); Lead Note Length (16n=plucky arp, 8n, 4n, 2n=pads); Glide (seconds) 0-0.3 bass slides (303-style); Chorus 0-1 wide/dreamy.
- Dropdowns: Lead Waveform (sine=soft, triangle=mellow, square=chiptune, sawtooth=bright, fatsawtooth/fatsquare/fattriangle=huge detuned, pwm/pulse=hollow movement, fmsine/fmsquare=digital, amsine/amtriangle=soft tremolo), Scale (major=happy, minor=sad, dorian=jazzy, phrygian=dark, lydian=dreamy, mixolydian=funky, harmonicMinor=dramatic, blues=gritty, pentatonic=safe), Root Note (C..B). Every dropdown's CURRENT value is in its data-state (song sections can change Root/Scale while playing).
- Transport buttons: "Play Sequence", "Stop Sequence", "Clear Grid", "Randomize Grid", "Clear All", "Export MIDI" (downloads the current arrangement as a .mid file - only click when asked). Clear and Randomize act on the CURRENT scene only; Clear All is a FULL clean slate: all four scenes, the chain and the song, back to loop mode on scene A, AND every mixer/master/groove/sound-design/effects/tempo/scale control back to its default. Click Clear All before starting a completely different song so nothing from the old one bleeds through.

GENRE CHEATSHEET (starting points):
house: 124bpm, kit 909, kick 0,4,8,12, openHat 2,6,10,14, snare 4,12, swing 0.08, bass saw, pump 0.5; arrange AABA where B adds hats/melody.
techno: 134bpm, kit 909, closedHat all 16, phrygian, sawtooth, distortion 0.2, pump 0.3; long loops, sweep DJ Filter for builds and drops.
lofi: 78bpm, kit lofi, swing 0.18, bitcrush 0.4, chorus 0.3, triangle, dorian, cutoff 1200, note length 4n.
trap: 140bpm, kit 808, sparse kick, snare on 8, closedHat runs of consecutive steps, lead octave 5, Auto fills on.
synthwave: 100bpm, fatsawtooth, chorus 0.5, reverb 0.4, minor, note length 8n, octave 3 chords; alternate scenes as verse/chorus.
ambient: 70bpm, few or no drums, lydian, attack 1+, release 3+, note length 2n, reverb 0.7.

RULES:
1. For a brand-NEW song (not a tweak to the current one), click "Clear All" FIRST - it resets patterns, arrangement, mixer, sound design and effects to defaults so nothing from the previous song bleeds through. Then translate mood/genre into settings (tempo, scale, root, kit, bass style, waveform, effects), then program the grid, then arrange (scenes, chain or song, playback mode). Pick a Lead Style that fits the mood (piano/keys for emotional/acoustic/lofi, seaboard for cinematic, saw for aggressive EDM) - don't leave melodic music on the default saw. But if the user only asks for a small tweak, leave Lead Style untouched so their current voice is kept.
2. Typical bar: kick 0,4,8,12; snare 4,12; closed hats on even steps; bass locked with kick; melody sparse (4-10 cells across rows 5-9).
3. Verify each click by re-reading the cell or toggle's data-state. Sliders are set with input_text (a plain number in range); volume sliders are dB and may be negative. Before editing another bar or scene, click its "Edit bar N" or "Scene X" button and confirm data-state=on - the 16 visible cells then show THAT bar of THAT scene.
4. To build more than a loop: program scene A, use Copy scene to seed B/C/D, vary them (B adds layers, C strips for a breakdown), then set Playback mode to chain and Apply chain with e.g. AABA - or paste sections into Song JSON, click Apply song, and check Song status. Use Mute buttons for drops/breakdowns; use "Clear Grid" only before a completely new pattern (it clears just the current scene).
5. ALWAYS click "Play Sequence" as your final action before done (it shows data-state=playing while running, data-state=stopped otherwise).
`.trim();

  // ---- Composer mode: one-shot composition via a custom tool --------------
  var BYODJ_COMPOSER_PROMPT = `
You are the composer for BYODJ, a music synthesizer web page. You cannot hear audio; reason from music theory.

Your tool "set_composition" applies an ENTIRE arranged track in one call - tempo, scale, sound design, mixer, effects, four pattern scenes, and a song arrangement - then starts playback.

SEQUENCER: a scene is patternLength steps (16=1 bar, 32=2 bars, 64=4 bars); every bar is 16 sixteenths with beats at 0,4,8,12 (bar 2 beats: 16,20,24,28; etc). Rows: kick, bass (plays the current root), snare, closedHat, openHat, plus melodic rows from the scale - leadRoot, leadThird, leadFifth, leadSeventh (jazzy), leadHigh (root +1 octave), perc (extra percussion); the same step on several lead rows makes a chord.
A pattern step is an integer (vel 0.9, prob 1) or {step, vel, prob}: vel 0-1 = loudness (accents 0.9-1, ghost notes 0.3-0.5), prob 0-1 = chance it plays each pass (0.6-0.9 on extra hats/ghosts = human variation every loop).

SCENES: patterns.A-D. Make B/C/D VARIATIONS of A, not new songs: B = A + extra hats/melody (lift), C = A stripped for the breakdown (cut kick or melody, keep a hook), D = peak (busiest hats, octave-up notes, accents).

PLAYBACK mode: "loop" repeats scene \`scene\`; "chain" follows chain like "AABA" (1-8 letters); "song" follows the song array - use song for any real track.

SONG: ordered sections {name, scene, bars, root?, scale?, overrides?, ramps?}, switching on bar boundaries.
- Energy curve: intro 4-8 bars (sparse, dark/filtered) -> build 4-8 (add layers, ramp filterCutoff up or djFilter back to 0) -> drop 8-16 (full kit, brightest) -> breakdown 4-8 (kickMute, reverb up) -> build 4 -> drop 8-16 -> outro 4 (strip layers, ramp down). 32-64 bars total is a solid track.
- Chord progressions: per-section root changes move the WHOLE harmony (bass + all lead rows). In minor, roots A->F->C->G = i-VI-III-VII. 1-2 bars per root reads as a progression; 8+ bars reads as a key change. Keep the scale, change the root.
- overrides: any non-pattern fields applied at section start (mixer mutes/vols, effects, sound design like leadStyle/drumKit/bassStyle/padVoice, tempo...). Give each section its own sonic character: an arrangement where every section keeps identical sound design sounds flat — at minimum vary mutes/effects, and swap leadStyle or pad for breakdowns/bridges (e.g. drop=saw, breakdown=bell or keys). ramps: smooth sweeps, e.g. {"filterCutoff":{"to":9000,"bars":8}}; ramp-able: filterCutoff, filterResonance, djFilter, reverb, delay, distortion, chorus, crush, pump, masterVolume.
- autoFill true: a generated snare/hat fill (rising velocity) plays over the last 4 steps of every 4th bar; your pattern data is untouched.

KEY FIELDS (all optional; omitted = kept):
- patternLength 16|32|64; tempo 60-200; swing 0-0.5 (0.08 house, 0.18 lofi/hiphop).
- drumKit analog | 808 (boomy trap) | 909 (punchy house/techno) | lofi (dusty) | sampled (real recorded kit, HTTP only); bassStyle sub | saw (reese) | acid (303 squelch); glide 0-0.3 bass slides.
- leadStyle: saw (classic filter-swept poly, waveform+envelope apply) | pluck (koto/arp) | bell (glassy FM celeste/mallet, long shimmer) | duo (thick detuned) | seaboard (fat expressive detuned saws with bloom + vibrato, ROLI-style - gorgeous at 4n/2n with varied velocity, THE choice for emotive/cinematic synth leads) | keys (warm Rhodes/e-piano with chorus+tremolo - lofi/jazz/neo-soul chords) | piano (REAL multi-sampled acoustic grand with its own plate reverb - ballads, cinematic, house piano stabs, emotive melodies; HTTP-only, falls back to keys on file://). NOTE piano & keys route around the lead low-pass, so filterCutoff/resonance do NOT shape them - use envelope, velocity dynamics and eq. For "piano-like" or emotional/acoustic requests reach for piano first, keys for vintage electric warmth. delayStyle: feedback | pingpong (wide stereo dub echo).
- pad: true = sustained chord following the current root/scale, one chord per bar - the glue for intros, breakdowns and ambient. It follows per-section root changes, so progressions sound arranged. padVoice: warm (analog saws) | glass (airy) | strings (slow orchestral swell) | dark (filtered moody). Mix at padVol -6 to -12; ducks with pump.
- humanize 0-1: timing + velocity micro-variation on hats/snare/lead/perc (kick/bass stay tight). 0.2-0.4 = human feel (lofi/jazz/hiphop); 0 = machine-tight (techno).
- eq {low, mid, high} dB -12..12: master tone. low +2 club weight, high +2 air, mid -2 declutter.
- perc row: extra percussion; percVoice tom (fills/rolls) | metal (techno ride/bell) | rim (clave).
- leadOctave "3" dark | "4" | "5" sparkly; leadNoteLen 16n pluck | 8n | 4n | 2n pads; waveform sine soft, triangle mellow, square chiptune, sawtooth bright, fat* huge detuned, pwm/pulse=hollow movement, fmsquare=digital grit, amsine=soft tremolo; envelope ADSR (long attack+release = pads, short = plucky); filterCutoff 100-10000 (low=dark); filterResonance 0-20.
- scale moods: major happy, minor sad, dorian jazzy, phrygian dark, lydian dreamy, mixolydian funky, harmonicMinor dramatic, blues gritty, pentatonic safe. root C..B.
- Effects 0-1: reverb, delay, distortion, chorus, crush (lo-fi bitcrush), pump (mix ducks on every kick). djFilter -100..100 (negative = muffled lowpass, positive = thin highpass, 0 = off). masterVolume dB -36..6 (top level, NOT in mixer).
- mixer: kickVol/bassVol/snareVol/hatsVol/leadVol/padVol/percVol dB -24..6; kickPan..percPan -1..1 (keep kick/bass at 0, spread hats/perc/lead ±0.2-0.4 for a stereo image); kickMute..percMute and kickSolo..percSolo booleans. Mutes keep patterns - the drop/breakdown move, ideal inside section overrides.

GENRE CHEATSHEET (sound + arrangement):
house: 124, 909, saw bass, leadStyle piano (classic house piano stabs) or saw, pump 0.5, swing 0.08; kick 0,4,8,12, openHat 2,6,10,14, snare 4,12. Song: 4 intro (no kick, djFilter -60) / 8 build (ramp djFilter to 0) / 16 drop / 8 breakdown (kickMute, reverb 0.5) / 16 drop / 4 outro.
techno: 134, 909, phrygian, sawtooth, distortion 0.2, pump 0.3; closedHat all 16 alternating vel 0.9/0.5. Long 8-16 bar sections, one root or i-VII, djFilter ramp into every drop.
lofi: 78, lofi kit, swing 0.18, humanize 0.35, crush 0.4, chorus 0.3, leadStyle keys, dorian, cutoff 1200, 4n; hats prob 0.7-0.9, vel 0.4-0.7. Song: 4 intro / 8 A / 8 B (root up a 4th) / 8 A / 4 outro.
trap: 140, 808, sparse kick, snare on step 8 of each bar, hat rolls = consecutive steps with vel rising 0.4->1, leadOctave "5", autoFill true; 8-bar sections, breakdown = drums muted + leadHigh hook.
synthwave: 100, leadStyle seaboard (or saw fatsawtooth), chorus 0.5, reverb 0.4, minor, 8n, octave "3" chords; i-VI-III-VII via section roots, 2 bars each; verse = sparse chords scene, chorus = scene adding leadHigh + openHat.
ambient: 70, few or no drums, lydian, leadStyle seaboard, pad true + padVoice strings, attack 1+, release 3+, 2n, reverb 0.7; 8-16 bar sections with drifting roots (e.g. C->F->A) and reverb/cutoff ramps instead of drums.
cinematic/emotive: 90, seaboard OR piano lead at 2n/4n with velocity swells (0.4->0.95 across a phrase), pad strings, harmonicMinor or minor, humanize 0.25, eq high +2, sparse kick, section roots as a progression.
piano ballad / neo-soul: 75-95, leadStyle piano (or keys for electric), leadNoteLen 4n/2n, chords across leadRoot/Third/Fifth/Seventh with rootl changes per section (e.g. minor ii-V-i), humanize 0.3, swing 0.1, soft drums or none, reverb 0.4.

WORKFLOW:
1. Design the whole track first: genre settings, an energy curve with section bar counts, a root progression, scenes A-D as variations, and per-section overrides + ramps so each section SOUNDS different (not just a different pattern) — intro/breakdown darker or softer voice, drop full and bright. Then call set_composition ONCE: clearFirst=true, patternLength, patterns, song (or chain), mode, plus all settings.
2. LEAD VOICE — choose it deliberately EVERY new track; never leave melodic music on the plain "saw" default. Match the mood: piano (real grand — ballads, house/piano stabs, emotional, acoustic, "piano-like"), keys (Rhodes — lofi/jazz/neo-soul), seaboard (expressive/cinematic/synthwave), bell (glassy/ambient sparkle), duo (thick detuned), pluck (koto/arp), saw (aggressive filter-swept EDM/techno). BUT if the user only asks to TWEAK an existing track (change tempo, add a section, swap a drum, "make it darker"), OMIT leadStyle entirely so their current voice is kept — sending leadStyle overwrites whatever the user hand-picked.
3. Pattern craft per bar: kick on the beats; snare 4,12 backbeat; hats between with vel/prob variation; bass locked to the kick; melody sparse (4-10 cells per bar across the lead rows, accents on downbeats).
4. Tweaks: pass only what changes - omitted fields, rows and scenes are kept, but song is replaced as a WHOLE: resend ALL sections when changing any. Add play:false to tweak without restarting the track (default play:true restarts from bar 0). Top-level "pattern" still edits scene A (legacy).
5. The tool starts playback and returns a summary. Then finish the task immediately. Do NOT click page controls or verify cells one by one unless the tool reported an error.
6. PIANO-ONLY / SOLO PIANO: when the user asks for piano, piano-only, solo piano, or a ballad with only piano — you MUST include leadStyle:"piano" at the TOP LEVEL of set_composition (not only in section overrides), pad:false, leadNoteLen "4n" or "2n", and patterns with sparse notes on leadRoot/leadThird/leadFifth (and optionally leadSeventh) in every scene the song uses. Leave all drum rows (kick, bass, snare, closedHat, openHat, perc) EMPTY in those patterns AND mute them in mixer. A song array alone with no patterns and no leadStyle will be silent or play the default saw synth — that is a failure for piano requests.
`.trim();

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
    leadHigh: 'Lead: root one octave up', perc: 'Extra percussion row — voice set by percVoice'
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
      clearFirst: { type: 'boolean', description: 'Full clean slate BEFORE applying this composition: clears all scenes, chain and song, and resets every sound control (mixer, sound design, effects, tempo, scale) to defaults. ALWAYS use true for a brand-new composition so nothing from the previous track bleeds through; after the reset, set every field the new track needs.' },
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
              description: 'Partial composition applied at section start: any top-level fields EXCEPT patterns/pattern/song/chain/mode/scene/play/clearFirst/patternLength. This is how sections get their own character — swap sound design (leadStyle, drumKit, bassStyle, padVoice, waveform, leadOctave, leadNoteLen), effects, mixer mutes/vols, pad on/off. E.g. {"mixer":{"kickMute":true},"reverb":0.5,"leadStyle":"bell"} for a breakdown.'
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
      waveform: { type: 'string', enum: ['sine', 'square', 'sawtooth', 'triangle', 'fatsawtooth', 'fatsquare', 'fattriangle', 'pwm', 'pulse', 'fmsine', 'fmsquare', 'amsine', 'amtriangle'], description: 'Lead oscillator: sine=soft, triangle=mellow, square=chiptune, sawtooth=aggressive, fat*=huge detuned, pwm/pulse=hollow with movement, fmsine/fmsquare=glassy/gritty digital, amsine/amtriangle=soft tremolo-like' },
      swing: { type: 'number', description: 'Shuffle 0-0.5. 0=straight, 0.08=house groove, 0.18=lofi/hiphop' },
      drumKit: { type: 'string', enum: ['analog', '808', '909', 'lofi', 'sampled'], description: 'Re-voices all drums: 808=boomy trap, 909=punchy house/techno, lofi=dusty, sampled=real recorded kit (HTTP only — falls back to analog on file://)' },
      bassStyle: { type: 'string', enum: ['sub', 'saw', 'acid'], description: 'sub=deep thud, saw=reese/electro, acid=303 squelch' },
      leadStyle: { type: 'string', enum: ['saw', 'pluck', 'bell', 'duo', 'seaboard', 'keys', 'piano'], description: 'Lead voice — pick to match the emotion: saw=classic filter-swept poly (waveform/envelope apply), pluck=koto/arp string, bell=glassy FM celeste/mallet (long shimmer), duo=thick detuned, seaboard=fat expressive detuned saws with bloom+vibrato (ROLI-style, best at 4n/2n with velocity swells), keys=warm Rhodes/e-piano with chorus+tremolo (lofi/jazz/neo-soul), piano=REAL multi-sampled acoustic grand with its own reverb (ballads/cinematic/house stabs; HTTP-only, falls back to keys on file://). Piano and keys ignore filterCutoff by design (they route around the lead filter), so shape them with envelope/velocity/EQ instead.' },
      delayStyle: { type: 'string', enum: ['feedback', 'pingpong'], description: 'pingpong=wide stereo echo bouncing L/R (dub/space)' },
      percVoice: { type: 'string', enum: ['tom', 'metal', 'rim'], description: 'tom=fills/rolls, metal=techno ride/bell, rim=clave/woodblock' },
      pad: { type: 'boolean', description: 'Sustained chord layer following the current root/scale, one chord per bar. The glue for intros/breakdowns/ambient.' },
      padVoice: { type: 'string', enum: ['warm', 'glass', 'strings', 'dark'], description: 'Pad timbre: warm=analog saws, glass=airy bells, strings=slow orchestral swell, dark=filtered/moody' },
      humanize: { type: 'number', description: '0-1 timing + velocity micro-variation on hats/snare/lead/perc (kick and bass stay tight). 0.2-0.4 = played-by-a-human feel; great for lofi/jazz, keep 0 for techno.' },
      eq: {
        type: 'object',
        description: 'Master 3-band EQ in dB, -12..12 each. E.g. low +2 for club weight, high +2 for air, mid -2 to unmask.',
        properties: {
          low: { type: 'number' }, mid: { type: 'number' }, high: { type: 'number' }
        }
      },
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
        description: 'Channel volumes in dB (-24..6, 0=neutral), pans (-1 left .. 1 right, 0 center), mutes and solos. Use mutes for drops/breakdowns - patterns are kept. Pan hats/perc slightly off-center (±0.2-0.4) and keep kick/bass centered for a studio stereo image.',
        properties: {
          kickVol: { type: 'number' }, bassVol: { type: 'number' }, snareVol: { type: 'number' },
          hatsVol: { type: 'number' }, leadVol: { type: 'number' }, padVol: { type: 'number' }, percVol: { type: 'number' },
          kickPan: { type: 'number' }, bassPan: { type: 'number' }, snarePan: { type: 'number' },
          hatsPan: { type: 'number' }, leadPan: { type: 'number' }, padPan: { type: 'number' }, percPan: { type: 'number' },
          kickMute: { type: 'boolean' }, bassMute: { type: 'boolean' }, snareMute: { type: 'boolean' },
          hatsMute: { type: 'boolean' }, leadMute: { type: 'boolean' }, padMute: { type: 'boolean' }, percMute: { type: 'boolean' },
          kickSolo: { type: 'boolean' }, bassSolo: { type: 'boolean' }, snareSolo: { type: 'boolean' },
          hatsSolo: { type: 'boolean' }, leadSolo: { type: 'boolean' }, padSolo: { type: 'boolean' }, percSolo: { type: 'boolean' }
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

  // page-agent's customTools expect a zod v4 schema: it embeds each tool's
  // inputSchema inside a real zod object() (the AgentOutput macro-tool) and
  // serializes it with zod's toJSONSchema. The IIFE bundle does not expose
  // zod, so this shim satisfies the three zod-internal entry points actually
  // exercised:
  //   - _zod.toJSONSchema(): zod's toJSONSchema short-circuits here and uses
  //     the returned JSON schema verbatim (this is what the LLM sees),
  //   - _zod.run()/_zod.parse(): the parser for this property — passthrough,
  //     i.e. accept anything with zero issues. Field-level validation happens
  //     inside applyComposition, which reports problems back to the LLM as
  //     tool output it can react to,
  //   - safeParse(): in case the schema is ever used standalone.
  // Schema must stay $ref-free: it is embedded inside the AgentOutput
  // document, so fragment refs would resolve against the wrong root.
  function zodLikeSchema(jsonSchema) {
    var passthrough = function (payload) { return payload; };
    return {
      _zod: {
        def: { type: 'custom' },
        // zod object() shapes reject members whose traits lack the $ZodType brand
        traits: new Set(['$ZodType']),
        toJSONSchema: function () { return jsonSchema; },
        run: passthrough,
        parse: passthrough
      },
      safeParse: function (data) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return { success: true, data: data };
        }
        return {
          success: false,
          error: { name: 'ZodError', issues: [{ code: 'custom', path: [], message: 'Expected a JSON object of composition settings' }] }
        };
      }
    };
  }

  var SET_COMPOSITION_TOOL = {
    description: 'Apply a complete musical arrangement to the synth in ONE call: tempo, scale, sound design, mixer, effects, four pattern scenes (A-D, 16/32/64 steps, per-step velocity/probability), a scene chain, and full song-mode sections with per-section roots, overrides and parameter ramps — then start playback. Strongly prefer this over clicking individual controls.',
    inputSchema: zodLikeSchema(COMPOSITION_JSON_SCHEMA),
    execute: function (input) {
      var synth = window.BYODJ_SYNTH;
      if (!synth || typeof synth.applyComposition !== 'function') {
        return 'Error: synth engine unavailable (BYODJ_SYNTH.applyComposition missing).';
      }
      var result = synth.applyComposition(input);
      if (!result.ok) return 'Error: ' + result.error;

      function summarize(playNote) {
        var msg = 'Applied: ' + (result.applied.join(', ') || 'nothing (empty composition)') + '.';
        if (result.warnings.length) msg += ' Warnings: ' + result.warnings.join('; ') + '.';
        msg += ' ' + playNote;
        window.BYODJ_AGENT.log('set_composition → ' + msg);
        return msg;
      }
      if (result.playPromise) {
        return result.playPromise.then(
          function () { return summarize('Playback started. The task is complete — finish now.'); },
          function (err) { return summarize('Playback could not start (' + (err && err.message ? err.message : err) + ') — click the "Play Sequence" button instead.'); }
        );
      }
      return summarize('Playback not started (play=false).');
    }
  };

  // ---- Prompt improver: one-shot chat completion (no PageAgent) -----------
  // Turns a rough idea in the instruction box into a vivid, capability-
  // exercising ask the composer can act on. Plain natural language out —
  // the user reviews/edits it before sending.
  var BYODJ_IMPROVER_PROMPT = `
You turn a rough music idea into ONE vivid, specific instruction for an AI DJ that programs a synth/sequencer. The DJ can: arrange full songs as named sections (intro/build/drop/breakdown/outro with bar counts) over four 16-64-step pattern scenes (A=main groove, B/C/D=variations); change root/scale per section (chord progressions); ramp parameters over a section (filter sweeps, DJ filter builds); override sounds and mutes per section (drops, pad on/off); accent or ghost individual hits (velocity) and give hits a play-probability so loops breathe; layer a sustained chord pad that follows the key; auto-fill every 4th bar; and choose drum kit (analog/808/909/lofi/sampled), bass style (sub/saw/acid 303), lead voice (saw/pluck/bell glassy/duo/seaboard expressive bloom/keys warm Rhodes/piano real sampled grand), pad voice (warm/glass/strings/dark), perc voice (tom/metal/rim), delay style (feedback/pingpong), waveform, swing, glide, humanize (loose human timing), stereo panning per channel, master EQ, and effects (reverb, distortion, chorus, bitcrush, sidechain pump).

Rewrite the user's idea as one natural-language ask (a single short paragraph, no JSON, no technical field names) that: names tempo, key and scale mood; describes the main groove concretely (where hits land, what gets accented vs ghosted, what plays only sometimes); demands a full arrangement with named contrasting sections; and includes at least one sweep or build. Keep the user's genre and intent. Reply with the improved prompt text ONLY.
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
    mode: 'composer',

    currentMode: function () {
      var sel = $('mode-select');
      return (sel && sel.value === 'theater') ? 'theater' : 'composer';
    },

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

      // DJ mode select: restore, persist, and hot-swap the agent on change.
      var modeSel = $('mode-select');
      if (modeSel) {
        var storedMode = safeLocalStorageGet(LS_MODE);
        if (storedMode === 'theater' || storedMode === 'composer') {
          modeSel.value = storedMode;
        }
        modeSel.addEventListener('change', function () {
          safeLocalStorageSet(LS_MODE, modeSel.value);
          if (self.agent) {
            self.log('DJ mode changed to ' + modeSel.value + ' — reconnecting…');
            self.connect();
          }
        });
      }

      // Connect button.
      var connectBtn = $('connect-btn');
      if (connectBtn) {
        connectBtn.addEventListener('click', function () {
          self.connect();
        });
      }

      // Send button + Ctrl/Cmd+Enter in the textarea. While a task runs the
      // button becomes Stop (the built-in panel is hidden in composer mode,
      // so this is the abort path).
      var sendBtn = $('send-btn');
      var textarea = $('instruction-input');
      function submit() {
        if (self.agent && self.agent.status === 'running') {
          self.log('Stopping agent…');
          try { self.agent.stop(); } catch (e) {}
          return;
        }
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

      var improveBtn = $('improve-btn');
      if (improveBtn) {
        improveBtn.addEventListener('click', function () {
          self.improvePrompt();
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

      this.mode = this.currentMode();
      var config = {
        baseURL: baseURL,
        model: model,
        apiKey: apiKey || undefined,
        temperature: 0.2,
        maxRetries: 3,
        language: 'en-US',
        // Merged into page-agent's default attribute list so the agent can
        // see toggle state alongside data-state.
        includeAttributes: ['aria-pressed'],
        viewportExpansion: -1,
        promptForNextTask: false,
        interactiveBlacklist: [
          function () { return document.getElementById('llm-config-panel'); },
          function () { return document.getElementById('chat-panel'); },
        ],
      };

      if (this.mode === 'composer') {
        // One-shot composing: the set_composition tool does everything, so a
        // short step budget suffices, no input-blocking mask, and the agent
        // never needs to ask questions (the panel that would collect answers
        // is hidden in this mode).
        config.maxSteps = 16;
        config.stepDelay = 0;
        config.enableMask = false;
        config.instructions = { system: BYODJ_COMPOSER_PROMPT };
        config.customTools = {
          set_composition: SET_COMPOSITION_TOOL,
          ask_user: null,
        };
      } else {
        config.maxSteps = 80;
        config.stepDelay = 0.3;
        config.enableMask = true;
        config.instructions = { system: BYODJ_SYSTEM_PROMPT };
      }

      try {
        this.agent = new window.PageAgent(config);
      } catch (err) {
        this.agent = null;
        this.log('Failed to create agent: ' + (err && err.message ? err.message : err));
        return;
      }

      this.hidePanelIfComposer();

      // ---- Live thought process: historychange -> status regions ----------
      // page-agent can push several history entries per notification (e.g. an
      // 'error' with the failure reason immediately followed by a 'retry'),
      // so walk everything new instead of only reading the last entry.
      this._histIdx = 0;
      if (typeof this.agent.addEventListener === 'function') {
        this.agent.addEventListener('historychange', function () {
          try {
            var history = self.agent && self.agent.history;
            if (!history) return;
            for (var i = self._histIdx; i < history.length; i++) {
              var entry = history[i];
              if (!entry) continue;
              if (entry.type === 'step') {
                var refl = entry.reflection || {};
                setStatusText('status-eval', refl.evaluation_previous_goal);
                setStatusText('status-memory', refl.memory);
                setStatusText('status-goal', refl.next_goal);
                var action = entry.action || {};
                var inputStr = '';
                try {
                  inputStr = JSON.stringify(action.input);
                } catch (e) {
                  inputStr = String(action.input);
                }
                self.log('Step ' + entry.stepIndex + ': ' + action.name + ' ' + String(inputStr).slice(0, 120));
              } else if (entry.type === 'error') {
                self.log('Error: ' + String(entry.message).slice(0, 400));
              } else if (entry.type === 'retry') {
                self.log('Retrying LLM request (attempt ' + entry.attempt + '/' + entry.maxAttempts + ')…');
              }
            }
            self._histIdx = history.length;
          } catch (e) {
            self.log('Status update error: ' + (e && e.message ? e.message : e));
          }
        });

        // Send becomes Stop while the agent is running. Also re-hide the
        // built-in panel in composer mode in case it re-shows itself on run.
        this.agent.addEventListener('statuschange', function () {
          var sendBtn = $('send-btn');
          if (sendBtn && self.agent) {
            var running = (self.agent.status === 'running');
            sendBtn.textContent = running ? 'Stop' : 'Send';
            sendBtn.setAttribute('aria-label', running ? 'Stop Agent' : 'Send Instruction');
            sendBtn.classList.toggle('running', running);
          }
          self.hidePanelIfComposer();
        });
      } else {
        this.log('Note: this PageAgent build does not expose addEventListener; live status display unavailable, but tasks will still run.');
      }

      // Do NOT call agent.panel.show() — our panels are the UI.

      var sendBtn = $('send-btn');
      if (sendBtn) sendBtn.disabled = false;
      this.log('Agent connected: ' + model + ' (' + this.mode + ' mode)');
    },

    hidePanelIfComposer: function () {
      if (this.mode !== 'composer') return;
      var panel = this.agent && this.agent.panel;
      if (panel && typeof panel.hide === 'function') {
        try { panel.hide(); } catch (e) {}
      }
    },

    // One-shot completion that rewrites the instruction box in place. Reads
    // the LLM config straight from the inputs (works before Connect); the
    // result lands back in the textarea for the user to review and Send.
    improvePrompt: function () {
      var self = this;
      var textarea = $('instruction-input');
      var btn = $('improve-btn');
      if (!textarea || this._improving) return Promise.resolve();
      var idea = textarea.value.trim();
      if (!idea) {
        this.log('Type a rough idea first (e.g. "djent"), then click Improve.');
        return Promise.resolve();
      }
      var baseURL = (($('llm-base-url') && $('llm-base-url').value) || '').trim().replace(/\/+$/, '');
      var apiKey = (($('llm-api-key') && $('llm-api-key').value) || '').trim();
      var model = (($('llm-model') && $('llm-model').value) || '').trim();
      if (!baseURL || !model) {
        this.log('Improve needs the LLM Base URL and Model above (no Connect required).');
        return Promise.resolve();
      }

      this._improving = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Improving…';
      }
      this.log('Improving prompt…');

      var headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      var body = {
        model: model,
        temperature: 0.8,
        max_tokens: 500,
        messages: [
          { role: 'system', content: BYODJ_IMPROVER_PROMPT },
          { role: 'user', content: idea }
        ]
      };

      // Newer OpenAI models reject legacy params with a 400 naming the param
      // (max_tokens -> max_completion_tokens; temperature must be default).
      // Other OpenAI-compatible providers only know the legacy names. Adapt
      // the request to whatever the endpoint complains about and retry.
      function attempt(retriesLeft) {
        return fetch(baseURL + '/chat/completions', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body)
        }).then(function (res) {
          if (res.ok) return res.json();
          return res.text().then(function (t) {
            if (res.status === 400 && retriesLeft > 0) {
              var bad = '';
              try {
                var ej = JSON.parse(t);
                bad = ((ej.error && ej.error.param) || '') + ' ' +
                      ((ej.error && ej.error.message) || '');
              } catch (ePar) { bad = String(t); }
              if (bad.indexOf('max_tokens') !== -1 && body.max_tokens !== undefined) {
                body.max_completion_tokens = body.max_tokens;
                delete body.max_tokens;
                return attempt(retriesLeft - 1);
              }
              if (bad.indexOf('max_completion_tokens') !== -1 && body.max_completion_tokens !== undefined) {
                delete body.max_completion_tokens; // provider knows neither spelling — drop the cap
                return attempt(retriesLeft - 1);
              }
              if (bad.indexOf('temperature') !== -1 && body.temperature !== undefined) {
                delete body.temperature;
                return attempt(retriesLeft - 1);
              }
            }
            throw new Error('HTTP ' + res.status + ' ' + String(t).slice(0, 200));
          });
        });
      }

      return attempt(3).then(function (data) {
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var text = (msg && typeof msg.content === 'string') ? msg.content.trim() : '';
        if (!text) throw new Error('the model returned an empty completion');
        textarea.value = text;
        self.log('Prompt improved — review it, tweak if you like, then Send.');
      }).catch(function (err) {
        self.log('Improve failed: ' + (err && err.message ? err.message : err));
      }).then(function () {
        self._improving = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Improve';
        }
      });
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
