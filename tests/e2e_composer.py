"""End-to-end test of BYODJ composer mode with a mocked OpenAI endpoint."""
import json
import threading
import http.server
import functools
import sys
from playwright.sync_api import sync_playwright

ROOT = "/Users/saadfarooq/Documents/Projects/BYODJ"
PORT = 8766

requests_seen = []

COMPOSITION_ARGS = {
    "clearFirst": True,
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

def llm_response(req_idx):
    if req_idx == 0:
        action = {"set_composition": COMPOSITION_ARGS}
    else:
        action = {"done": {"text": "Dark techno applied", "success": True}}
    agent_output = {
        "evaluation_previous_goal": "Starting" if req_idx == 0 else "Composition applied successfully",
        "memory": "Dark techno at 128bpm in A phrygian",
        "next_goal": "Apply the full composition" if req_idx == 0 else "Finish",
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
            if "ask_user" in payload:
                failures.append("ask_user should be disabled in composer mode")
            all_msgs = json.dumps(requests_seen[0].get("messages", []))
            if "WORKFLOW" not in all_msgs:
                failures.append("composer system prompt not found in any message")

        # 2. composition was applied to the page
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

        # 2b. DJ-expansion: grid size + new rows 8/9
        cell_count = page.evaluate("() => document.querySelectorAll('#sequencer-grid .cell').length")
        if cell_count != 160:
            failures.append(f"expected 160 cells, got {cell_count}")
        if page.get_attribute("#cell-r9-s15", "aria-label") != "LeadHigh step 15":
            failures.append("cell-r9-s15 aria-label wrong: " + str(page.get_attribute("#cell-r9-s15", "aria-label")))
        if page.get_attribute("#cell-r8-s0", "aria-label") != "LeadSeventh step 0":
            failures.append("cell-r8-s0 aria-label wrong: " + str(page.get_attribute("#cell-r8-s0", "aria-label")))
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

        # 7. theater mode reconnect sanity: mode swap rebuilds the agent
        page.select_option("#mode-select", "theater")
        page.wait_for_timeout(300)
        log2 = page.inner_text("#agent-log")
        if "theater mode" not in log2:
            failures.append("theater reconnect missing from log: " + log2[-200:])
        has_agent = page.evaluate("() => !!window.BYODJ_AGENT.agent")
        if not has_agent:
            failures.append("agent missing after theater reconnect")

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
