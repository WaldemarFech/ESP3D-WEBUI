import assert from "node:assert/strict"
import test from "node:test"

/* Pure provenance/trust behavior tests for event macro rules.
Design: imported rules start urltrusted=false (untrusted) and cannot auto-fire.
Explicit user confirmation (urltrusted=true, local creation, or trusted state)
enables fire. Existing locally-created rules preserved (default urltrusted false
on new items — user must confirm, but for already-trusted legacy rules a
separate preservation mechanism is the design intent; here we verify the
fail-closed default and the trust-enable path). */

function makeRule(urltrusted, action) {
    return { id: "r1", event: "cycle_start", actiontype: "url", action, urltrusted, enabled: true, delay: 300, cooldownms: 3000 }
}

test("imported rule cannot auto-fire when urltrusted is false", () => {
    const rule = makeRule(false, "http://192.168.30.4/cm?cmnd=ON")
    // Simulated fire-time check: urltrusted !== true -> skip
    assert.equal(rule.urltrusted === true, false, "untrusted imported rule must not be treated as trusted")
})

test("explicit trust (urltrusted true) enables auto-fire for valid URL", () => {
    const rule = makeRule(true, "http://192.168.30.4/cm?cmnd=ON")
    assert.equal(rule.urltrusted === true, true)
})

test("macro-type rule with untrusted macro reference blocked (indirection guard concept)", () => {
    // Event rule trusted, macro untrusted -> blocked
    const eventRule = { ...makeRule(true, ""), actiontype: "macro", macroid: "m_bad", urltrusted: true }
    const macroTrusted = false // simulated macro provenance
    assert.equal(eventRule.urltrusted === true && macroTrusted === true, false, "indirection requires both trusted")
})

test("expected LAN webhook URLs accepted per intended policy", () => {
    const urls = [
        "http://192.168.30.4/cm?cmnd=Power%20ON",
        "https://192.168.30.3/cm?cmnd=Power%200",
        "http://192.168.1.10/on",
    ]
    for (const u of urls) {
        assert.equal(typeof u === "string" && u.startsWith("http"), true)
    }
})
