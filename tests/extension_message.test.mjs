import assert from "node:assert/strict"
import test from "node:test"
import {
    createExtensionMessageListener,
    isAuthorizedExtensionMessage,
    parseExtensionMessage,
    registerExtensionMessageListener,
} from "../src/areas/extensionMessage.ts"

const commandMessage = {
    target: "webui",
    type: "cmd",
    id: "terminal",
    content: "$H",
}

const documentWith = (...frames) => ({
    querySelectorAll(selector) {
        assert.equal(selector, "iframe.extensionContainer")
        return frames
    },
})

test("rejects a hostile unrelated window even with a valid command payload", () => {
    const extensionWindow = {}
    const hostileWindow = {}
    const event = {
        source: hostileWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    }

    assert.equal(isAuthorizedExtensionMessage(
        event,
        documentWith({ contentWindow: extensionWindow, src: "http://fluidnc.local/ext.html" }),
        "http://fluidnc.local/"
    ), false)
})

test("accepts a registered blob extension only with its embedded origin", () => {
    const extensionWindow = {}
    const frame = { contentWindow: extensionWindow, src: "blob:http://fluidnc.local/id" }

    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), true)

    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "https://attacker.example",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), false)
})

test("enforces a derivable same-origin non-blob iframe origin", () => {
    const extensionWindow = {}
    const frame = { contentWindow: extensionWindow, src: "/extensions/panel.html" }

    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "https://attacker.example",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), false)

    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), true)
})

test("enforces parsed cross-origin iframe origins despite stable source identity", () => {
    const extensionWindow = {}
    const frame = {
        contentWindow: extensionWindow,
        src: "https://extensions.example/panel.html",
    }
    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "https://extensions.example",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), true)

    assert.equal(isAuthorizedExtensionMessage({
        source: extensionWindow,
        origin: "https://attacker.example",
        data: commandMessage,
    }, documentWith(frame), "http://fluidnc.local/"), false)
})

test("accepts unsandboxed srcdoc by inherited origin and rejects opaque sandboxed frames", () => {
    const srcdocWindow = {}
    const srcdocFrame = {
        contentWindow: srcdocWindow,
        src: "about:srcdoc",
        srcdoc: "<script>parent.postMessage({ target: 'webui' }, '*')</script>",
    }
    assert.equal(isAuthorizedExtensionMessage({
        source: srcdocWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    }, documentWith(srcdocFrame), "http://fluidnc.local/"), true)

    assert.equal(isAuthorizedExtensionMessage({
        source: srcdocWindow,
        origin: "null",
        data: commandMessage,
    }, documentWith({
        ...srcdocFrame,
        hasAttribute: name => name === "sandbox",
    }), "http://fluidnc.local/"), false)
})

test("rejects malformed, inherited, and incorrectly typed command payloads", () => {
    assert.equal(parseExtensionMessage(null), null)
    assert.equal(parseExtensionMessage("not an object"), null)
    assert.equal(parseExtensionMessage({ target: "webui", type: "cmd", content: 42 }), null)
    assert.equal(parseExtensionMessage({
        target: "webui",
        type: "upload",
        url: "files",
        path: "/",
        filename: "bad.bin",
        size: 1,
        content: { not: "a BlobPart" },
    }), null)
    assert.equal(parseExtensionMessage({
        target: "webui",
        type: "sound",
        content: "seq",
        seq: [{ f: "loud", d: 100 }],
    }), null)
    assert.equal(parseExtensionMessage({ target: "elsewhere", type: "cmd", content: "$H" }), null)
    assert.equal(parseExtensionMessage({ target: "webui", type: "unknown", content: "$H" }), null)

    const inherited = Object.create(commandMessage)
    assert.equal(parseExtensionMessage(inherited), null)
})

test("authorization follows the currently registered iframe set", () => {
    const extensionWindow = {}
    let frames = [{ contentWindow: extensionWindow, src: "about:blank" }]
    const documentLike = {
        querySelectorAll() {
            return frames
        },
    }
    const event = {
        source: extensionWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    }

    assert.equal(isAuthorizedExtensionMessage(
        event,
        documentLike,
        "http://fluidnc.local/"
    ), true)
    frames = []
    assert.equal(isAuthorizedExtensionMessage(
        event,
        documentLike,
        "http://fluidnc.local/"
    ), false)
})

test("listener resolves the current callback instead of retaining a stale one", () => {
    const extensionWindow = {}
    const calls = []
    let handler = () => calls.push("old")
    const listener = createExtensionMessageListener(
        documentWith({ contentWindow: extensionWindow, src: "about:blank" }),
        () => handler,
        "http://fluidnc.local/"
    )

    handler = () => calls.push("current")
    listener({
        source: extensionWindow,
        origin: "http://fluidnc.local",
        data: commandMessage,
    })

    assert.deepEqual(calls, ["current"])
})

test("registration cleanup removes the same message listener", () => {
    const calls = []
    const target = {
        addEventListener(type, listener) {
            calls.push(["add", type, listener])
        },
        removeEventListener(type, listener) {
            calls.push(["remove", type, listener])
        },
    }
    const listener = () => {}

    const cleanup = registerExtensionMessageListener(target, listener)
    cleanup()

    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(([action, type]) => [action, type]), [
        ["add", "message"],
        ["remove", "message"],
    ])
    assert.equal(calls[0][2], listener)
    assert.equal(calls[1][2], listener)
})
