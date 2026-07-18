"""End-to-end test of BYODJ composer + song mode with a mocked OpenAI endpoint.

Covers (in addition to the original composer-mode pins):
- extended set_composition schema fields reaching the LLM (patterns/chain/song/
  patternLength/mode/autoFill, anyOf step items with vel/prob; no $ref/$defs)
- a second mocked exchange whose payload uses scenes + a song arrangement +
  velocity-object steps, asserted via serialized data-state/value attributes
- scene/bar/mode/fills controls with correct aria-labels and load defaults
- bar paging, scene paging + copy-scene, chain-apply validation revert
- #song-status serialized playback position in song mode
- back-compat: the OLD payload shape (top-level 16-step pattern) lands on scene A
"""
import json
import threading
import http.server
import functools
import sys
from playwright.sync_api import sync_playwright

ROOT = "/Users/saadfarooq/Documents/Projects/BYODJ"
PORT = 8766

requests_seen = []

# Legacy payload shape (back-compat pin): top-level 16-step pattern rows must
# still apply — they land on scene A. leadStyle is included because clearFirst
# + melodic rows without one is now rejected (the voice must be deliberate).
COMPOSITION_ARGS = {
    "clearFirst": True,
    "leadStyle": "saw",
    "tempo": 128,
    "scale": "phrygian",
    "root": "A",
    "waveform": "sawtooth",
    "filterCutoff": 900,
    "envelope": {"attack": 0.005, "release": 0.4},
    "reverb": 0.35,
    "distortion": 0.4,
    "swing": 0.18,
    "drumKit": "808",
    "djFilter": -40,
    "mixer": {"bassMute": True, "leadVol": -6},
    "pattern": {
        "kick": [0, 4, 8, 12],
        "snare": [4, 12],
        "closedHat": [0, 2, 4, 6, 8, 10, 12, 14],
        "bass": [0, 4, 8, 12],
        "leadRoot": [0, 7],
        "leadFifth": [3, 11],
        "leadHigh": [0, 8],
    },
}

# Song-mode payload: scenes, velocity/probability step objects, chain, song
# arrangement with a per-section ramp, song playback mode, auto-fills.
SONG_COMPOSITION_ARGS = {
    "patternLength": 32,
    "patterns": {
        "A": {
            "kick": [0, 4, 8, 12, 16, 20, 24, 28],
            "snare": [4, {"step": 12, "vel": 0.4, "prob": 0.8}, 20, 28],
            "closedHat": [{"step": 2, "vel": 0.3}, {"step": 6, "vel": 0.95}, 10, 14],
            "openHat": [{"step": 30, "vel": 0.5}],
        },
        "B": {
            "kick": [0, 8, 16, 24],
            "leadRoot": [{"step": 17, "vel": 0.8}],
        },
    },
    "chain": "AABA",
    "song": [
        {"name": "intro", "scene": "A", "bars": 1},
        {"name": "drop", "scene": "B", "bars": 1,
         "ramps": {"filterCutoff": {"to": 9000, "bars": 1}}},
    ],
    "mode": "song",
    "autoFill": True,
}

def llm_response(req_idx):
    if req_idx == 0:
        action = {"set_composition": COMPOSITION_ARGS}
        evaluation = "Starting"
        memory = "Dark techno at 128bpm in A phrygian"
        next_goal = "Apply the full composition"
    elif req_idx == 1:
        action = {"done": {"text": "Dark techno applied", "success": True}}
        evaluation = "Composition applied successfully"
        memory = "Dark techno at 128bpm in A phrygian"
        next_goal = "Finish"
    elif req_idx == 2:
        action = {"set_composition": SONG_COMPOSITION_ARGS}
        evaluation = "Starting song arrangement"
        memory = "Arranging a 2-section song with scene variations"
        next_goal = "Apply the song arrangement"
    else:
        action = {"done": {"text": "Song arranged", "success": True}}
        evaluation = "Song arrangement applied successfully"
        memory = "Song mode running intro/drop sections"
        next_goal = "Finish"
    agent_output = {
        "evaluation_previous_goal": evaluation,
        "memory": memory,
        "next_goal": next_goal,
        "action": action,
    }
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": 1,
        "model": "mock-model",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": f"call_{req_idx}",
                    "type": "function",
                    "function": {"name": "AgentOutput", "arguments": json.dumps(agent_output)},
                }],
            },
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
    }

def main():
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT),
        functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()

    failures = []
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        def handle_llm(route):
            body = json.loads(route.request.post_data or "{}")
            idx = len(requests_seen)
            requests_seen.append(body)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(llm_response(idx)),
            )

        page.route("**/chat/completions", handle_llm)
        page.goto(f"http://127.0.0.1:{PORT}/index.html")
        page.wait_for_selector("#cell-r0-s0")

        # 0a. song-mode controls exist with correct aria-labels + load defaults
        for sel, label in [
            ("#scene-btn-a", "Scene A"), ("#scene-btn-b", "Scene B"),
            ("#scene-btn-c", "Scene C"), ("#scene-btn-d", "Scene D"),
            ("#copy-scene-to", "Copy scene to"), ("#copy-scene-btn", "Copy scene"),
            ("#chain-input", "Scene chain"), ("#chain-apply-btn", "Apply chain"),
            ("#playback-mode", "Playback mode"), ("#pattern-length", "Pattern length"),
            ("#bar-btn-1", "Edit bar 1"), ("#bar-btn-2", "Edit bar 2"),
            ("#bar-btn-3", "Edit bar 3"), ("#bar-btn-4", "Edit bar 4"),
            ("#fills-toggle", "Auto fills"), ("#song-input", "Song JSON"),
            ("#song-apply-btn", "Apply song"), ("#song-status", "Song status"),
        ]:
            got = page.get_attribute(sel, "aria-label")
            if got != label:
                failures.append(f"{sel} aria-label expected {label!r}, got {got!r}")

        if page.get_attribute("#pattern-length", "data-state") != "16":
            failures.append("pattern-length data-state default != 16")
        if page.get_attribute("#playback-mode", "data-state") != "loop":
            failures.append("playback-mode data-state default != loop")
        if page.get_attribute("#copy-scene-to", "data-state") != "B":
            failures.append("copy-scene-to data-state default != B")
        if page.get_attribute("#scene-btn-a", "data-state") != "on":
            failures.append("scene-btn-a data-state default != on")
        for sc in ("b", "c", "d"):
            if page.get_attribute(f"#scene-btn-{sc}", "data-state") != "off":
                failures.append(f"scene-btn-{sc} data-state default != off")
        if page.get_attribute("#bar-btn-1", "data-state") != "on":
            failures.append("bar-btn-1 data-state default != on")
        bar_flags = page.evaluate(
            "() => [2,3,4].map(n => { const b = document.getElementById('bar-btn-'+n);"
            " return [b.hidden, b.disabled]; })"
        )
        for i, (hidden, disabled) in enumerate(bar_flags, start=2):
            if not hidden or not disabled:
                failures.append(f"bar-btn-{i} should be hidden+disabled at length 16")
        if page.get_attribute("#fills-toggle", "data-state") != "off":
            failures.append("fills-toggle data-state default != off")
        if page.get_attribute("#song-status", "data-state") != "idle":
            failures.append("song-status data-state default != idle")
        if page.get_attribute("#chain-input", "value") != "A":
            failures.append("chain-input value attribute default != A")

        # 0b. aria-label truncation budget: page-agent truncates attribute
        # values at 20 chars; EVERY agent-visible label must fit. Only the
        # interactiveBlacklist panels (#llm-config-panel, #chat-panel) are
        # exempt — page-agent never serializes them.
        long_labels = page.evaluate(
            "() => [...document.querySelectorAll('[aria-label]')]"
            ".filter(el => !el.closest('#llm-config-panel') && !el.closest('#chat-panel'))"
            ".map(el => el.getAttribute('aria-label')).filter(l => l.length > 20)"
        )
        if long_labels:
            failures.append("aria-labels over 20-char budget: " + " | ".join(long_labels))

        # 0c. lead-style defaults to keys (the neutral fallback voice), with
        # the new non-saw voices present as options.
        if page.input_value("#lead-style") != "keys":
            failures.append("lead-style load default != keys: " + page.input_value("#lead-style"))
        if page.get_attribute("#lead-style", "data-state") != "keys":
            failures.append("lead-style data-state default != keys")
        lead_opts = page.evaluate(
            "() => [...document.getElementById('lead-style').options].map(o => o.value)")
        for opt in ("organ", "flute"):
            if opt not in lead_opts:
                failures.append(f"lead-style missing new voice option {opt!r}: {lead_opts}")

        # 0d. leadStyle guard: clearFirst + melodic rows but no leadStyle is
        # REJECTED before anything is applied; drums-only clearFirst passes.
        guard = page.evaluate(
            "() => window.BYODJ_SYNTH.applyComposition("
            "{clearFirst: true, tempo: 99, pattern: {leadRoot: [0, 4]}})")
        if guard.get("ok") is not False or "leadStyle" not in guard.get("error", ""):
            failures.append("clearFirst+melody without leadStyle not rejected: " + json.dumps(guard)[:200])
        if page.input_value("#tempo-slider") != "120":
            failures.append("rejected composition still mutated tempo: " + page.input_value("#tempo-slider"))
        if page.get_attribute("#cell-r5-s0", "data-state") != "off":
            failures.append("rejected composition still wrote lead cells")
        drums_only = page.evaluate(
            "() => { const r = window.BYODJ_SYNTH.applyComposition("
            "{clearFirst: true, play: false, pattern: {kick: [0]}});"
            " return {ok: r.ok, warnings: r.warnings}; }")
        if drums_only.get("ok") is not True:
            failures.append("drums-only clearFirst should pass the guard: " + json.dumps(drums_only)[:200])
        page.evaluate("() => window.BYODJ_SYNTH.clearAll()")

        # connect in composer mode (default)
        page.fill("#llm-base-url", "https://mockllm.test/v1")
        page.fill("#llm-api-key", "sk-mock")
        page.fill("#llm-model", "mock-model")
        page.click("#connect-btn")
        page.wait_for_timeout(300)

        log0 = page.inner_text("#agent-log")
        if "composer mode" not in log0:
            failures.append(f"connect log missing composer mode: {log0!r}")

        page.fill("#instruction-input", "dark techno, 128bpm, aggressive")
        page.click("#send-btn")

        # wait until the task completes (Done/Failed line in log)
        try:
            page.wait_for_function(
                "() => /Done:|Failed:|Agent error:/.test(document.getElementById('agent-log').innerText)",
                timeout=20000,
            )
        except Exception:
            failures.append("task never completed; log: " + page.inner_text("#agent-log"))

        log = page.inner_text("#agent-log")

        # 1. tool schema reached the LLM
        if len(requests_seen) < 2:
            failures.append(f"expected 2 LLM calls, got {len(requests_seen)}")
        else:
            # actions are nested inside the single AgentOutput tool's schema
            tools = requests_seen[0].get("tools", [])
            payload = json.dumps(tools)
            if '"set_composition"' not in payload:
                failures.append(f"set_composition absent from AgentOutput schema: {payload[:300]}")
            if '"pattern"' not in payload or '"clearFirst"' not in payload:
                failures.append(f"composition schema (shim) missing from request: {payload[:500]}")
            # 1b. song-mode schema surface in the serialized tool payload
            for token in ('"patterns"', '"patternLength"', '"song"', '"chain"',
                          '"mode"', '"autoFill"', '"anyOf"', '"vel"', '"prob"'):
                if token not in payload:
                    failures.append(f"composition schema missing {token} in serialized tools")
            for token in ('"$ref"', '"$defs"'):
                if token in payload:
                    failures.append(f"serialized tools must stay $ref-free, found {token}")
            if "ask_user" in payload:
                failures.append("ask_user should be disabled in composer mode")
            all_msgs = json.dumps(requests_seen[0].get("messages", []))
            if "WORKFLOW" not in all_msgs:
                failures.append("composer system prompt not found in any message")
            # 1c. composer prompt teaches the new arrangement features
            if "patterns" not in all_msgs:
                failures.append("composer prompt does not mention patterns")
            if "song" not in all_msgs:
                failures.append("composer prompt does not mention song")

        # 2. composition was applied to the page (legacy payload -> scene A)
        for s in (0, 4, 8, 12):
            if page.get_attribute(f"#cell-r0-s{s}", "data-state") != "on":
                failures.append(f"kick step {s} not on")
        if page.get_attribute("#cell-r0-s1", "data-state") != "off":
            failures.append("kick step 1 should be off")
        for s, want in [("#cell-r2-s4", "on"), ("#cell-r5-s7", "on"), ("#cell-r7-s11", "on")]:
            if page.get_attribute(s, "data-state") != want:
                failures.append(f"{s} expected {want}")
        if page.input_value("#tempo-slider") != "128":
            failures.append("tempo slider not 128: " + page.input_value("#tempo-slider"))
        if page.inner_text("#tempo-slider-value") != "128":
            failures.append("tempo output not updated")
        if page.input_value("#scale-select") != "phrygian":
            failures.append("scale not phrygian")
        if page.input_value("#root-select") != "A":
            failures.append("root not A")

        # 2a. legacy payload landed on scene A while the grid still shows
        # scene A / bar 1 with the default 16-step length
        if page.get_attribute("#scene-btn-a", "data-state") != "on":
            failures.append("legacy payload should leave scene A selected")
        if page.get_attribute("#pattern-length", "data-state") != "16":
            failures.append("legacy payload should keep patternLength 16")

        # 2b. DJ-expansion: grid size + new rows 8/9
        cell_count = page.evaluate("() => document.querySelectorAll('#sequencer-grid .cell').length")
        if cell_count != 176:
            failures.append(f"expected 176 cells, got {cell_count}")
        if page.get_attribute("#cell-r9-s15", "aria-label") != "LeadHigh step 15":
            failures.append("cell-r9-s15 aria-label wrong: " + str(page.get_attribute("#cell-r9-s15", "aria-label")))
        if page.get_attribute("#cell-r8-s0", "aria-label") != "LeadSeventh step 0":
            failures.append("cell-r8-s0 aria-label wrong: " + str(page.get_attribute("#cell-r8-s0", "aria-label")))
        if page.get_attribute("#cell-r10-s0", "aria-label") != "Perc step 0":
            failures.append("cell-r10-s0 aria-label wrong: " + str(page.get_attribute("#cell-r10-s0", "aria-label")))
        if page.get_attribute("#cell-r10-s15", "aria-label") != "Perc step 15":
            failures.append("cell-r10-s15 aria-label wrong: " + str(page.get_attribute("#cell-r10-s15", "aria-label")))
        if page.get_attribute("#cell-r9-s0", "data-state") != "on":
            failures.append("leadHigh pattern did not land: cell-r9-s0 data-state != on")

        # 2c. DJ-expansion: master/groove + sound design + mixer controls
        if page.get_attribute("#swing-amount", "value") != "0.18":
            failures.append("swing value attribute not 0.18: " + str(page.get_attribute("#swing-amount", "value")))
        if page.inner_text("#swing-amount-value") != "0.18":
            failures.append("swing output not 0.18: " + page.inner_text("#swing-amount-value"))
        if page.input_value("#drum-kit") != "808":
            failures.append("drum-kit select not 808: " + page.input_value("#drum-kit"))
        if page.get_attribute("#dj-filter", "value") != "-40":
            failures.append("dj-filter value attribute not -40: " + str(page.get_attribute("#dj-filter", "value")))
        if page.get_attribute("#level-lead", "value") != "-6":
            failures.append("level-lead value attribute not -6: " + str(page.get_attribute("#level-lead", "value")))

        # 2d-i. deliberate leadStyle from the payload landed (saw chosen on purpose)
        if page.input_value("#lead-style") != "saw":
            failures.append("lead-style not saw after payload: " + page.input_value("#lead-style"))

        # 2d. DJ-expansion: mute toggle landed from the tool call
        if page.get_attribute("#mute-bass", "data-state") != "on":
            failures.append("mute-bass data-state != on after set_composition")
        if page.get_attribute("#mute-bass", "aria-pressed") != "true":
            failures.append("mute-bass aria-pressed != true after set_composition")

        # 3. playback started (transport state serialized on the play button)
        if page.get_attribute("#play-btn", "data-state") != "playing":
            failures.append("play button data-state != playing: " + str(page.get_attribute("#play-btn", "data-state")))

        # 4. no mask, panel hidden
        mask_visible = page.evaluate(
            "() => [...document.querySelectorAll('div')].some(d => {"
            "  const s = getComputedStyle(d);"
            "  return s.position === 'fixed' && s.zIndex === '2147483641' && s.display !== 'none'; })"
        )
        if mask_visible:
            failures.append("input-blocking mask is visible in composer mode")
        panel_visible = page.evaluate(
            "() => { const w = window.BYODJ_AGENT.agent && window.BYODJ_AGENT.agent.panel"
            " && window.BYODJ_AGENT.agent.panel.wrapper;"
            " if (!w) return false; const s = getComputedStyle(w);"
            " return s.display !== 'none' && s.visibility !== 'hidden'; }"
        )
        if panel_visible:
            failures.append("built-in panel is visible in composer mode")

        # 5. status regions updated from reflection
        if "Dark techno at 128bpm" not in page.inner_text("#status-memory"):
            failures.append("status memory not updated: " + page.inner_text("#status-memory"))

        # 6. log shows the tool ran and the task finished
        if "set_composition" not in log:
            failures.append("log missing set_composition entry")
        if "Done:" not in log:
            failures.append("log missing Done line")

        # 6b. human path: clicking the mute button flips it back off
        page.click("#mute-bass")
        if page.get_attribute("#mute-bass", "data-state") != "off":
            failures.append("mute-bass click did not flip data-state back to off")
        if page.get_attribute("#mute-bass", "aria-pressed") != "false":
            failures.append("mute-bass click did not flip aria-pressed back to false")

        # ---------- second composer exchange: scenes + song arrangement ----------

        # stop first so the mode change applies immediately (not bar-queued)
        page.click("#stop-btn")
        if page.get_attribute("#play-btn", "data-state") != "stopped":
            failures.append("play button data-state != stopped after stop click")
        if page.get_attribute("#song-status", "data-state") != "idle":
            failures.append("song-status not idle after stop: " + str(page.get_attribute("#song-status", "data-state")))

        page.fill("#instruction-input", "arrange a full song with scene variations")
        page.click("#send-btn")
        try:
            page.wait_for_function(
                "() => (document.getElementById('agent-log').innerText"
                ".match(/Done:|Failed:|Agent error:/g) || []).length >= 2",
                timeout=20000,
            )
        except Exception:
            failures.append("song task never completed; log: " + page.inner_text("#agent-log"))

        if len(requests_seen) != 4:
            failures.append(f"expected 4 LLM calls after both tasks, got {len(requests_seen)}")

        # 8. song-mode payload landed: serialized data-state/value attributes
        if page.get_attribute("#pattern-length", "data-state") != "32":
            failures.append("pattern-length data-state != 32 after song payload: " + str(page.get_attribute("#pattern-length", "data-state")))
        bar_flags = page.evaluate(
            "() => [1,2,3,4].map(n => { const b = document.getElementById('bar-btn-'+n);"
            " return [b.hidden, b.disabled]; })"
        )
        if bar_flags[1][0] or bar_flags[1][1]:
            failures.append("bar-btn-2 should be visible+enabled at patternLength 32")
        if not (bar_flags[2][0] and bar_flags[2][1] and bar_flags[3][0] and bar_flags[3][1]):
            failures.append("bar-btn-3/4 should stay hidden+disabled at patternLength 32")
        if page.get_attribute("#chain-input", "value") != "AABA":
            failures.append("chain-input value attribute != AABA: " + str(page.get_attribute("#chain-input", "value")))
        if page.get_attribute("#playback-mode", "data-state") != "song":
            failures.append("playback-mode data-state != song: " + str(page.get_attribute("#playback-mode", "data-state")))
        if page.get_attribute("#fills-toggle", "data-state") != "on":
            failures.append("fills-toggle data-state != on after autoFill:true")
        if page.get_attribute("#fills-toggle", "aria-pressed") != "true":
            failures.append("fills-toggle aria-pressed != true after autoFill:true")
        song_json = page.input_value("#song-input")
        if not song_json.strip():
            failures.append("song-input textarea empty after song payload (normalized JSON expected)")
        elif "intro" not in song_json or "drop" not in song_json:
            failures.append("song-input normalized JSON missing section names: " + song_json[:200])

        # 8b. patterns.A bar 1 is visible (edit scene A, bar 1) with vel tiers
        for sel, want in [("#cell-r0-s0", "on"), ("#cell-r0-s4", "on"),
                          ("#cell-r2-s4", "on"), ("#cell-r3-s2", "on")]:
            if page.get_attribute(sel, "data-state") != want:
                failures.append(f"{sel} expected data-state {want} after patterns.A")
        if page.get_attribute("#cell-r3-s2", "data-vel") != "lo":
            failures.append("cell-r3-s2 (vel 0.3) data-vel != lo: " + str(page.get_attribute("#cell-r3-s2", "data-vel")))
        if page.get_attribute("#cell-r3-s6", "data-vel") != "hi":
            failures.append("cell-r3-s6 (vel 0.95) data-vel != hi: " + str(page.get_attribute("#cell-r3-s6", "data-vel")))
        if page.get_attribute("#cell-r2-s12", "title") != "vel 0.40 prob 0.80":
            failures.append("cell-r2-s12 title (vel/prob tooltip) wrong: " + str(page.get_attribute("#cell-r2-s12", "title")))
        # openHat lives only at step 30 (bar 2) — invisible from bar 1
        if page.get_attribute("#cell-r4-s14", "data-state") != "off":
            failures.append("cell-r4-s14 should be off in bar 1 (openHat only at step 30)")

        # 9. song mode auto-played; #song-status serializes the position as
        # {idx}:{name}:{scene}:{bar}/{bars}
        if page.get_attribute("#play-btn", "data-state") != "playing":
            failures.append("play button data-state != playing after song payload")
        try:
            page.wait_for_function(
                "() => /^\\d+:[^:]{0,8}:[A-D]:\\d+\\/\\d+$/.test("
                "document.getElementById('song-status').getAttribute('data-state'))",
                timeout=10000,
            )
        except Exception:
            failures.append("song-status never showed song position: " + str(page.get_attribute("#song-status", "data-state")))
        page.click("#stop-btn")
        if page.get_attribute("#song-status", "data-state") != "idle":
            failures.append("song-status did not return to idle after stop: " + str(page.get_attribute("#song-status", "data-state")))

        # 10. bar paging: the visible 16 cells re-page to bar 2 (steps 16-31)
        page.click("#bar-btn-2")
        if page.get_attribute("#bar-btn-2", "data-state") != "on":
            failures.append("bar-btn-2 data-state != on after click")
        if page.get_attribute("#bar-btn-1", "data-state") != "off":
            failures.append("bar-btn-1 data-state != off after switching to bar 2")
        if page.get_attribute("#cell-r4-s14", "data-state") != "on":
            failures.append("cell-r4-s14 should be on in bar 2 (openHat step 30)")
        if page.get_attribute("#cell-r0-s0", "data-state") != "on":
            failures.append("cell-r0-s0 should be on in bar 2 (kick step 16)")
        page.click("#bar-btn-1")
        if page.get_attribute("#bar-btn-1", "data-state") != "on":
            failures.append("bar-btn-1 data-state != on after clicking back")
        if page.get_attribute("#cell-r4-s14", "data-state") != "off":
            failures.append("cell-r4-s14 should be off again after returning to bar 1")

        # 11. scene paging + copy scene
        page.click("#scene-btn-b")
        if page.get_attribute("#scene-btn-b", "data-state") != "on":
            failures.append("scene-btn-b data-state != on after click")
        if page.get_attribute("#scene-btn-a", "data-state") != "off":
            failures.append("scene-btn-a data-state != off after selecting B")
        if page.get_attribute("#cell-r0-s0", "data-state") != "on":
            failures.append("scene B kick step 0 should be on")
        if page.get_attribute("#cell-r0-s4", "data-state") != "off":
            failures.append("scene B kick step 4 should be off (B is a sparser variation)")
        page.click("#scene-btn-a")
        if page.get_attribute("#cell-r0-s4", "data-state") != "on":
            failures.append("scene A kick step 4 should be on again after switching back")
        page.select_option("#copy-scene-to", "C")
        if page.get_attribute("#copy-scene-to", "data-state") != "C":
            failures.append("copy-scene-to data-state mirror != C after select")
        page.click("#copy-scene-btn")
        page.click("#scene-btn-c")
        if page.get_attribute("#scene-btn-c", "data-state") != "on":
            failures.append("scene-btn-c data-state != on after click")
        if page.get_attribute("#cell-r0-s4", "data-state") != "on":
            failures.append("scene C should mirror scene A after copy (kick step 4)")
        if page.get_attribute("#cell-r3-s2", "data-vel") != "lo":
            failures.append("scene C copy lost velocity tier on cell-r3-s2")

        # 12. chain apply validation: invalid input reverts the serialized
        # value attribute to the last good chain
        page.fill("#chain-input", "AXBA")
        page.click("#chain-apply-btn")
        if page.get_attribute("#chain-input", "value") != "AABA":
            failures.append("chain-input value attribute did not revert to AABA: " + str(page.get_attribute("#chain-input", "value")))
        if page.input_value("#chain-input") != "AABA":
            failures.append("chain-input field did not revert to AABA: " + page.input_value("#chain-input"))

        # ---------- end of song-mode additions ----------

        # 7. theater mode reconnect sanity: mode swap rebuilds the agent
        page.select_option("#mode-select", "theater")
        page.wait_for_timeout(300)
        log2 = page.inner_text("#agent-log")
        if "theater mode" not in log2:
            failures.append("theater reconnect missing from log: " + log2[-200:])
        has_agent = page.evaluate("() => !!window.BYODJ_AGENT.agent")
        if not has_agent:
            failures.append("agent missing after theater reconnect")

        log = page.inner_text("#agent-log")
        if log.count("set_composition") < 2:
            failures.append("log missing the second set_composition entry")

        real_errors = [e for e in console_errors if "favicon" not in e]
        if real_errors:
            failures.append("console errors: " + " | ".join(real_errors[:5]))

        browser.close()
    server.shutdown()

    print(f"LLM calls: {len(requests_seen)}")
    print("LOG:\n" + log)
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("\nALL CHECKS PASSED")

if __name__ == "__main__":
    main()
