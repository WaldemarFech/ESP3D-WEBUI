import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { evaluateFireGate, resolveCurrentRule, isUrlMacroType, macroTargetUrl } =
    await importTypeScript("../src/targets/CNC/FluidNC/eventMacroGate.ts")

const URL = "http://192.168.30.3/cm?cmnd=Power%20On"
const urlRule = (over = {}) => ({ id: "r1", event: "cycle_start", actiontype: "url", action: URL, macroid: "", urltrusted: true, ...over })
const macroRule = (over = {}) => ({ id: "r2", event: "alarm", actiontype: "macro", action: "", macroid: "m1", urltrusted: false, ...over })
const ctx = (macros = {}, ...rest) => ({ connected: rest.length ? rest[0] : true, findMacro: (id) => macros[id] })

test("trusted valid URL rule fires its URL", () => {
    assert.deepEqual(evaluateFireGate(urlRule(), ctx()), { fire: "url", url: URL })
})

test("untrusted or invalid URL rule is skipped", () => {
    assert.equal(evaluateFireGate(urlRule({ urltrusted: false }), ctx()).fire, false)
    assert.equal(evaluateFireGate(urlRule({ urltrusted: undefined }), ctx()).fire, false)
    const bad = evaluateFireGate(urlRule({ action: "javascript:alert(1)" }), ctx())
    assert.equal(bad.fire, false)
    assert.equal(bad.loud, true)
})

test("non-URL saved macro (CMD) fires without URL trust", () => {
    const macros = { m1: { action: "M5", type: "CMD" } }
    assert.deepEqual(evaluateFireGate(macroRule(), ctx(macros)), { fire: "macro", macro: macros.m1 })
})

test("URI/URI_SILENT saved macro requires explicit trust (no bypass via macro reference)", () => {
    for (const type of ["URI", "URI_SILENT"]) {
        const macros = { m1: { action: URL, type } }
        const untrusted = evaluateFireGate(macroRule(), ctx(macros))
        assert.equal(untrusted.fire, false, `${type} must not fire untrusted`)
        assert.match(untrusted.reason, /not explicitly trusted/)
        assert.deepEqual(evaluateFireGate(macroRule({ urltrusted: true }), ctx(macros)), { fire: "macro", macro: macros.m1 })
    }
})

test("URL macro with an invalid URL is rejected even when trusted", () => {
    for (const action of ["javascript:alert(1)", "http://u:p@host/", "[SILENT] file:///etc/passwd", ""]) {
        const d = evaluateFireGate(macroRule({ urltrusted: true }), ctx({ m1: { action, type: "URI_SILENT" } }))
        assert.equal(d.fire, false, action)
        assert.equal(d.loud, true)
    }
})

test("legacy [SILENT] prefix is validated on the URL behind it", () => {
    assert.equal(macroTargetUrl({ action: `  [SILENT] ${URL} `, type: "URI" }), URL)
    const d = evaluateFireGate(macroRule({ urltrusted: true }), ctx({ m1: { action: `[SILENT]${URL}`, type: "URI" } }))
    assert.equal(d.fire, "macro")
})

test("missing referenced macro is a loud skip", () => {
    const d = evaluateFireGate(macroRule(), ctx({}))
    assert.equal(d.fire, false)
    assert.equal(d.loud, true)
})

test("connection gate: nothing but ws_disconnect fires while not connected", () => {
    for (const connected of [false, undefined]) {
        assert.equal(evaluateFireGate(urlRule(), ctx({}, connected)).fire, false)
        assert.equal(evaluateFireGate(macroRule(), ctx({ m1: { action: "M5", type: "CMD" } }, connected)).fire, false)
        assert.equal(evaluateFireGate(urlRule({ event: "ws_disconnect" }), ctx({}, connected)).fire, "url")
    }
    assert.equal(evaluateFireGate(urlRule({ event: "ws_connect" }), ctx({}, true)).fire, "url")
})

test("pending timer re-resolves the CURRENT rule by id", () => {
    const snap = urlRule()
    assert.equal(resolveCurrentRule(snap, []), undefined, "deleted/disabled rule must not fire")
    assert.equal(resolveCurrentRule(snap, [urlRule({ event: "cycle_stop" })]), undefined, "re-pointed rule must not fire")
    const edited = urlRule({ action: "http://192.168.30.9/new", urltrusted: false })
    assert.equal(resolveCurrentRule(snap, [urlRule({ id: "other" }), edited]), edited)
    // and the fresh copy, not the snapshot, is what the gate judges
    assert.equal(evaluateFireGate(resolveCurrentRule(snap, [edited]), ctx()).fire, false)
})

test("isUrlMacroType", () => {
    assert.equal(isUrlMacroType("URI"), true)
    assert.equal(isUrlMacroType("URI_SILENT"), true)
    for (const t of ["CMD", "FS", "SD", undefined, null, "uri"]) assert.equal(isUrlMacroType(t), false)
})
