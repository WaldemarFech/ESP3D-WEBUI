import assert from "node:assert/strict"
import test from "node:test"
import {
    openSafeExternalUrl,
    safeExternalHttpUrl,
} from "../src/pages/about/externalLink.ts"

test("accepts only absolute HTTP and HTTPS URLs", () => {
    assert.equal(
        safeExternalHttpUrl("https://docs.example.test/help?source=device#setup"),
        "https://docs.example.test/help?source=device#setup"
    )
    assert.equal(
        safeExternalHttpUrl("http://192.0.2.1/firmware"),
        "http://192.0.2.1/firmware"
    )
})

test("rejects active, local, relative, and malformed URLs", () => {
    for (const value of [
        "javascript:alert(1)",
        "data:text/html,<svg onload=alert(1)>",
        "file:///etc/passwd",
        "/relative/path",
        "relative/path",
        "//attacker.example/path",
        "https:attacker.example/path",
        "https://",
        "http://[invalid",
        "not a URL",
        "https://safe.example/\njavascript:alert(1)",
    ]) {
        assert.equal(safeExternalHttpUrl(value), null, value)
    }
})

test("opens a safe URL with isolation features and clears opener", () => {
    const calls = []
    const openedWindow = { opener: { reachable: true } }
    const targetWindow = {
        open(...args) {
            calls.push(args)
            return openedWindow
        },
    }

    assert.equal(openSafeExternalUrl("https://docs.example.test/help", targetWindow), true)
    assert.deepEqual(calls, [[
        "https://docs.example.test/help",
        "_blank",
        "noopener,noreferrer",
    ]])
    assert.equal(openedWindow.opener, null)
})

test("does not call window.open for an unsafe URL", () => {
    let calls = 0
    const targetWindow = {
        open() {
            calls += 1
            return { opener: null }
        },
    }

    assert.equal(openSafeExternalUrl("javascript:alert(1)", targetWindow), false)
    assert.equal(calls, 0)
})
