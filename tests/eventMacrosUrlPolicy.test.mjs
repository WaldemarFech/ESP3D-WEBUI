import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

// Exercises the PRODUCTION helper (src/components/Helpers/http.ts), not a copy,
// so a change to the runtime URL policy is caught here.
const { isTrustedEventUrl } = await importTypeScript("../src/components/Helpers/http.ts")

test("accepts expected LAN HTTP(S) webhook URLs", () => {
    assert.equal(isTrustedEventUrl("http://192.168.30.4/cm?cmnd=Power%20ON"), true)
    assert.equal(isTrustedEventUrl("https://192.168.30.3/cm?cmnd=Power%200"), true)
    assert.equal(isTrustedEventUrl("http://device.local:8080/api/on"), true)
    assert.equal(isTrustedEventUrl("  https://docs.example.test/  "), true)
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
        "",
        "   ",
    ]) {
        assert.equal(isTrustedEventUrl(bad), false, `expected false for ${bad}`)
    }
})

test("rejects non-string values", () => {
    for (const bad of [undefined, null, 42, {}, ["http://a/"]]) {
        assert.equal(isTrustedEventUrl(bad), false)
    }
})

test("rejects URLs with embedded credentials", () => {
    assert.equal(isTrustedEventUrl("http://user:pass@192.168.1.1/on"), false)
    assert.equal(isTrustedEventUrl("https://user:@host/"), false)
    assert.equal(isTrustedEventUrl("http://:pass@host/"), false)
})

test("requires absolute HTTP(S) - relative strings rejected", () => {
    assert.equal(isTrustedEventUrl("192.168.30.4/cm"), false)
    assert.equal(isTrustedEventUrl("http://"), false)
})
