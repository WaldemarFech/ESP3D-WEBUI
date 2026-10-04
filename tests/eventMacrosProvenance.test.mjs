import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

// Provenance end to end through the production code: the import path
// (sanitizeImportedEventMacroTrust + formatItem, src/tabs/interface/importHelper.ts)
// produces the urltrusted field that the runtime gate
// (evaluateFireGate, src/targets/CNC/FluidNC/eventMacroGate.ts) then enforces.
const { formatItem, sanitizeImportedEventMacroTrust } = await importTypeScript("../src/tabs/interface/importHelper.ts")
const { evaluateFireGate } = await importTypeScript("../src/targets/CNC/FluidNC/eventMacroGate.ts")

const URL = "http://192.168.30.4/cm?cmnd=Power%20ON"

// Same flattening eventMacros.ts readEnabledRules() applies to a formatted item.
function toRule(formatted) {
    const flat = {}
    formatted.value.forEach((f) => { flat[f.name] = f.initial })
    return {
        id: formatted.id,
        event: flat.event,
        actiontype: flat.actiontype === "macro" ? "macro" : "url",
        action: String(flat.action || "").trim(),
        macroid: String(flat.macroid || "").trim(),
        urltrusted: flat.urltrusted === true,
    }
}

const connected = { connected: true, findMacro: () => undefined }

test("legacy rule without urltrusted gets urltrusted=false and is not auto-fired", () => {
    const formatted = formatItem({ id: "r1", event: "cycle_start", action: URL, enabled: true }, 0, "eventmacros")
    const trustField = formatted.value.find((f) => f.name === "urltrusted")
    assert.equal(trustField.initial, false)
    const decision = evaluateFireGate(toRule(formatted), connected)
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /not explicitly trusted/)
})

test("user's own saved trusted rule (not via file import) keeps trust and fires", () => {
    const formatted = formatItem({ id: "r1", event: "cycle_start", action: URL, enabled: true, urltrusted: true }, 0, "eventmacros")
    assert.deepEqual(evaluateFireGate(toRule(formatted), connected), { fire: "url", url: URL })
})

test("file import strips urltrusted=true so an imported rule cannot auto-fire", () => {
    const imported = { eventmacros: [
        { id: "a", event: "cycle_start", action: URL, enabled: true, urltrusted: true },
        { id: "b", event: "alarm", actiontype: "macro", macroid: "m1", enabled: true, urltrusted: true },
    ] }
    sanitizeImportedEventMacroTrust(imported)
    assert.equal(imported.eventmacros.every((r) => r.urltrusted === false), true)
    const decision = evaluateFireGate(toRule(formatItem(imported.eventmacros[0], 0, "eventmacros")), connected)
    assert.equal(decision.fire, false)
})

test("sanitizer tolerates missing/foreign shapes and leaves other lists alone", () => {
    sanitizeImportedEventMacroTrust(undefined)
    sanitizeImportedEventMacroTrust(null)
    sanitizeImportedEventMacroTrust({ eventmacros: "nope" })
    const other = { macros: [{ id: "m", urltrusted: true }] }
    sanitizeImportedEventMacroTrust(other)
    assert.equal(other.macros[0].urltrusted, true)
})
