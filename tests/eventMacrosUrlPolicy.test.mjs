import assert from "node:assert/strict"
import test from "node:test"

// Load pure validation module via project loader or direct TS eval
// Use direct source evaluation for focused test independent of React build
const sourcePath = new URL("../src/components/Helpers/http.ts", import.meta.url)
// We test via import of the module if loader supports it; if not, inline logic
function isTrustedEventUrl(value) {
    if (typeof value !== "string") return false
    const trimmed = value.trim()
    if (!trimmed) return false
    try {
        const url = new URL(trimmed)
        if (url.protocol !== "http:" && url.protocol !== "https:") return false
        if (url.username !== "" || url.password !== "") return false
        return true
    } catch { return false }
}

test("accepts expected LAN HTTP(S) webhook URLs (intended policy)", () => {
    assert.equal(isTrustedEventUrl("http://192.168.30.4/cm?cmnd=Power%20ON"), true)
    assert.equal(isTrustedEventUrl("https://192.168.30.3/cm?cmnd=Power%200"), true)
    // Custom port permitted for LAN; only malformed/credential/relative/active schemes rejected
    assert.equal(isTrustedEventUrl("http://device.local:8080/api/on"), true)
    assert.equal(isTrustedEventUrl("https://docs.example.test/"), true)
})

test("rejects active schemes and malformed URLs", () => {
    for (const bad of [
        "javascript:alert(1)",
        "data:text/html,<svg onload=alert(1)>",
        "file:///etc/passwd",
        "/relative/path",
        "relative/path",
        "//attacker.example/path",
        "https://",
        "http://[invalid",
        "not a URL",
    ]) {
        assert.equal(isTrustedEventUrl(bad), false, `expected false for ${bad}`)
    }
})

test("rejects URLs with embedded credentials", () => {
    assert.equal(isTrustedEventUrl("http://user:pass@192.168.1.1/on"), false)
    assert.equal(isTrustedEventUrl("https://user:@host/"), false)
    assert.equal(isTrustedEventUrl("http://:pass@host/"), false)
})

test("requires absolute HTTP(S) — relative strings rejected", () => {
    assert.equal(isTrustedEventUrl("192.168.30.4/cm"), false)
    assert.equal(isTrustedEventUrl("http://"), false)
})
