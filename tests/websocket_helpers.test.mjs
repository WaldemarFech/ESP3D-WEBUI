import assert from "node:assert/strict"
import test from "node:test"
import { buildWebSocketUrl, resolveWebSocketHost } from "../src/Services/WebSocketUrl.ts"

test("uses configured WebSocketIP for captive portal AP host", () => {
    assert.equal(resolveWebSocketHost("connectivitycheck.gstatic.com", {
        WiFiMode: "AP",
        WebSocketIP: "192.168.4.1",
    }), "192.168.4.1")
})

test("does not treat captive-portal lookalike hostnames as probes", () => {
    assert.equal(resolveWebSocketHost("evilgoogle.com.example", {
        WiFiMode: "AP",
        WebSocketIP: "192.168.4.1",
    }), "evilgoogle.com.example")
})

test("preserves localhost development host", () => {
    assert.equal(resolveWebSocketHost("localhost", {
        WiFiMode: "AP",
        WebSocketIP: "192.168.4.1",
    }), "localhost")
})

test("builds configured protocol path and derived development port", () => {
    assert.equal(buildWebSocketUrl({ hostname: "localhost", port: "5173", protocol: "http:" }, {
        WebCommunication: "WebSocket",
        WebSocketPort: "82",
    }), "ws://localhost:5175/ws")
})

test("uses secure WebSockets on an HTTPS page", () => {
    assert.equal(buildWebSocketUrl({ hostname: "fluidnc.local", port: "", protocol: "https:" }, {
        WebCommunication: "WebSocket",
        WebSocketPort: "82",
    }), "wss://fluidnc.local:82/ws")
})

test("uses the configured WebSocket port for a non-development page with an explicit HTTP port", () => {
    assert.equal(buildWebSocketUrl({ hostname: "fluidnc.local", port: "8080", protocol: "https:" }, {
        WebCommunication: "WebSocket",
        WebSocketPort: "8443",
    }), "wss://fluidnc.local:8443/ws")
})

test("formats IPv6 loopback and derives its development WebSocket port", () => {
    assert.equal(buildWebSocketUrl({ hostname: "::1", port: "5173", protocol: "http:" }, {
        WebCommunication: "WebSocket",
        WebSocketPort: "82",
    }), "ws://[::1]:5175/ws")
})

test("formats IPv6 hosts and rejects invalid derived ports", () => {
    assert.equal(buildWebSocketUrl({ hostname: "2001:db8::1", port: "invalid", protocol: "http:" }, {
        WebCommunication: "Synchronous",
        WebSocketPort: "83",
    }), "ws://[2001:db8::1]:83")
    assert.equal(buildWebSocketUrl({ hostname: "localhost", port: "65535", protocol: "http:" }, {
        WebCommunication: "WebSocket",
        WebSocketPort: "82",
    }), "ws://localhost:82/ws")
})
