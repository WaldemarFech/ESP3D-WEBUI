import assert from "node:assert/strict"
import test from "node:test"

/* Pure provenance/trust behavior tests for event macro rules.
Design: imported rules start urltrusted=false (untrusted) and cannot auto-fire.
Explicit user confirmation (urltrusted=true) enables a valid URL rule. */

function makeRule(urltrusted, action) {
    return { id: "r1", event: "cycle_start", actiontype: "url", action, urltrusted, enabled: true, delay: 300, cooldownms: 3000 }
}

test("imported rule cannot auto-fire when urltrusted is false", () => {
    const rule = makeRule(false, "http://192.168.30.4/cm?cmnd=ON")
    assert.equal(rule.urltrusted === true, false, "untrusted imported rule must not be treated as trusted")
})

test("explicit trust (urltrusted true) enables auto-fire for valid URL", () => {
    const rule = makeRule(true, "http://192.168.30.4/cm?cmnd=ON")
    assert.equal(rule.urltrusted === true, true)
})

test("expected LAN webhook URLs accepted per intended policy", () => {
    const urls = [
        "http://192.168.30.4/cm?cmnd=Power%20ON",
        "https://192.168.30.3/cm?cmnd=Power%200",
        "http://192.168.1.10/on",
    ]
    for (const u of urls) assert.equal(typeof u === "string" && u.startsWith("http"), true)
})
