import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { WebSocketAdapter } = await importTypeScript("../src/Services/WebSocketAdapter.ts")
const { WebSocketService, ControllerStatus } = await importTypeScript("../src/Services/WebSocketService.ts")
const { HttpQueueController } = await importTypeScript("../src/contexts/HttpQueueController.ts")
const { Command } = await importTypeScript("../src/Services/Commands/Command.ts")

const closeEvent = () => Object.assign(new Event("close"), { code: 1000, reason: "", wasClean: true })

class FakeTransport {
    binaryType = "blob"
    readyState = WebSocket.CONNECTING
    onopen = null
    onmessage = null
    onerror = null
    onclose = null
    sent = []
    closeCalls = 0
    listeners = new Map()

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
    }

    dispatch(type, event) {
        this[`on${type}`]?.(event)
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }

    captureHandlers() {
        const propertyHandler = {
            open: this.onopen,
            message: this.onmessage,
            error: this.onerror,
            close: this.onclose,
        }
        const listeners = new Map([...this.listeners].map(([type, values]) => [type, [...values]]))
        return (type, event) => {
            propertyHandler[type]?.(event)
            for (const listener of listeners.get(type) ?? []) listener(event)
        }
    }

    open() {
        this.readyState = WebSocket.OPEN
        this.dispatch("open", new Event("open"))
    }

    fail() {
        this.dispatch("error", new Event("error"))
        if (this.readyState !== WebSocket.CLOSED) {
            this.readyState = WebSocket.CLOSED
            this.dispatch("close", closeEvent())
        }
    }

    receive(data) {
        this.dispatch("message", new MessageEvent("message", { data }))
    }

    close() {
        this.closeCalls++
        if (this.readyState === WebSocket.CLOSED) return
        this.readyState = WebSocket.CLOSING
        queueMicrotask(() => {
            this.readyState = WebSocket.CLOSED
            this.dispatch("close", closeEvent())
        })
    }

    send(data) {
        if (this.readyState !== WebSocket.OPEN) throw new Error("transport is not open")
        this.sent.push(data)
    }
}

const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 10))

function createHarness() {
    const transports = []
    const factory = () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
    }
    const adapter = new WebSocketAdapter("ws://fluidnc.local:82/ws", "webui-v3", factory)
    const service = new WebSocketService(adapter)
    service.setReconnectConfig({ maxAttempts: 3, baseDelayMs: 0 })
    service.setPingConfig({ delayMs: 60_000 })
    return { adapter, service, transports }
}

const connectTransport = async (service, transport) => {
    const connection = service.connect()
    transport.open()
    assert.equal(await connection, ControllerStatus.CONNECTED)
}

test.beforeEach(() => {
    globalThis.document = { title: "test" }
})

test("initial open failure schedules a retry that recreates and opens the adapter", async () => {
    const { adapter, service, transports } = createHarness()
    const initialConnection = service.connect()
    transports[0].fail()

    await assert.rejects(initialConnection, /failed to connect/)
    assert.equal(service.isReconnectPending(), true)

    await flushTimers()
    assert.equal(transports.length, 2)
    assert.notEqual(adapter.getNativeWebSocket(), transports[0])
    transports[1].open()
    await flushTimers()

    assert.equal(service.status, ControllerStatus.CONNECTED)
    assert.equal(service.getReconnectAttempts(), 0)
    await service.disconnect()
})

test("HTTP threshold during CONNECTING retires the stale attempt and reconnects", async () => {
    const { service, transports } = createHarness()
    service.setReconnectConfig({ maxAttempts: 3, baseDelayMs: 100 })
    const connection = service.connect()
    const controller = new HttpQueueController({
        httpAdapter: () => ({
            abort: () => {},
            response: Promise.reject(Object.assign(new Error("offline"), { kind: "network" })),
        }),
        processData: () => {},
        getConnectionState: () => ({ connected: false }),
        setConnectionState: () => {},
        getWebSocketService: () => service,
        maxNoAnswerCount: 0,
    })

    const connectionRejected = assert.rejects(connection, /failed to connect/)
    controller.addInQueue({
        id: "connect-probe-one",
        url: "http://controller/connect-probe-one",
        params: {},
        onSuccess: () => {},
        onFail: () => {},
    })
    await flushTimers()

    assert.equal(service.status, ControllerStatus.CONNECTION_LOST)
    assert.equal(service.isReconnectPending(), true)
    assert.equal(transports[0].closeCalls, 1)
    controller.addInQueue({
        id: "connect-probe-two",
        url: "http://controller/connect-probe-two",
        params: {},
        onSuccess: () => {},
        onFail: () => {},
    })
    await flushTimers()
    assert.equal(service.isReconnectPending(), true)
    await connectionRejected
    await new Promise((resolve) => setTimeout(resolve, 120))

    assert.equal(transports.length, 2)
    assert.equal(service.status, ControllerStatus.CONNECTING)
    transports[1].open()
    await flushTimers()
    assert.equal(service.status, ControllerStatus.CONNECTED)
    assert.equal(service.isReconnectPending(), false)

    transports[1].close()
    await flushTimers()
    assert.equal(service.status, ControllerStatus.CONNECTION_LOST)
    assert.equal(service.isReconnectPending(), true)
    await service.disconnect()
})

test("externally detected loss retires an apparently open transport", async () => {
    const { adapter, service, transports } = createHarness()
    await connectTransport(service, transports[0])

    service.handleConnectionLoss("connectionlost")
    await flushTimers()

    assert.equal(transports[0].closeCalls, 1)
    assert.equal(transports.length, 2)
    assert.notEqual(adapter.getNativeWebSocket(), transports[0])
    assert.equal(service.status, ControllerStatus.CONNECTING)

    transports[1].open()
    await flushTimers()
    assert.equal(service.status, ControllerStatus.CONNECTED)
    await service.disconnect()
})

test("an error without a close retires the transport before reconnecting", async () => {
    const { adapter, service, transports } = createHarness()
    await connectTransport(service, transports[0])

    // Browsers may report an error without a matching close event. Keep the
    // fake transport OPEN to reproduce that edge explicitly.
    transports[0].dispatch("error", new Event("error"))
    await flushTimers()

    assert.equal(transports[0].closeCalls, 1)
    assert.equal(transports.length, 2)
    assert.notEqual(adapter.getNativeWebSocket(), transports[0])
    assert.equal(service.status, ControllerStatus.CONNECTING)

    transports[1].open()
    await flushTimers()
    assert.equal(service.status, ControllerStatus.CONNECTED)
    await service.disconnect()
})

test("an established connection reconnects after its transport closes", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])

    transports[0].close()
    await flushTimers()

    assert.equal(service.status, ControllerStatus.CONNECTING)
    assert.equal(transports.length, 2)
    transports[1].open()
    await flushTimers()

    assert.equal(service.status, ControllerStatus.CONNECTED)
    await service.disconnect()
})

test("concurrent open while the current transport closes shares the bound attempt", async () => {
    const { adapter, transports } = createHarness()
    const firstOpen = adapter.open(100)
    transports[0].readyState = WebSocket.CLOSING
    const concurrentOpen = adapter.open(100)

    assert.equal(transports.length, 1)
    transports[0].open()
    await Promise.all([firstOpen, concurrentOpen])
    assert.equal(adapter.isOpen(), true)
    await adapter.close()
})

test("adapter close is bounded when the transport never emits close", async () => {
    const { adapter, transports } = createHarness()
    transports[0].readyState = WebSocket.OPEN
    transports[0].open()
    transports[0].close = function () {
        this.closeCalls++
        this.readyState = WebSocket.CLOSING
    }

    await adapter.close(5)
    assert.equal(transports[0].closeCalls, 1)
    assert.equal(adapter.isOpen(), false)

    const reopened = adapter.open(100)
    assert.equal(transports.length, 2)
    transports[1].open()
    await reopened
    await adapter.close()
})

test("adapter recreation preserves listeners and ignores events from the stale transport", async () => {
    const { adapter, transports } = createHarness()
    const data = []
    let closeCount = 0
    adapter.addReader((value) => data.push(value))
    adapter.addCloseListener(() => closeCount++)

    const firstOpen = adapter.open(100)
    const dispatchLate = transports[0].captureHandlers()
    transports[0].fail()
    await assert.rejects(firstOpen, /failed to connect/)

    const secondOpen = adapter.open(100)
    assert.equal(transports.length, 2)
    dispatchLate("message", new MessageEvent("message", { data: "stale" }))
    dispatchLate("error", new Event("error"))
    dispatchLate("close", closeEvent())
    transports[1].open()
    await secondOpen
    transports[1].receive("fresh")

    assert.deepEqual(data, ["fresh"])
    assert.equal(closeCount, 1)
    await adapter.close()
})

test("newline-free control frames do not prefix the next command response", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])
    transports[0].receive("CURRENT_ID:session-123")
    assert.equal(service.getSessionId(), "session-123")
    transports[0].receive("PING:25000:60000")

    const combinedCommand = new Command("combined")
    const combined = service.send(combinedCommand, 100)
    transports[0].receive("currentID:session-456\nok\n")
    assert.equal(service.getSessionId(), "session-456")
    assert.equal(await combined, combinedCommand)
    assert.deepEqual(combinedCommand.response, ["ok"])

    const command = new Command("status")
    const completed = service.send(command, 100)
    transports[0].receive("ok\n")
    assert.equal(await completed, command)
    assert.deepEqual(command.response, ["ok"])
    await service.disconnect()
})

test("a reconnect clears a partial line from the previous transport generation", async () => {
    const { service, transports } = createHarness()
    const routed = []
    service.setDataListener((_type, value) => routed.push(value))
    await connectTransport(service, transports[0])
    transports[0].receive("partial")
    transports[0].close()
    await flushTimers()
    transports[1].open()
    await flushTimers()
    transports[1].receive("fresh\n")

    assert.deepEqual(routed, ["fresh"])
    await service.disconnect()
})

test("disconnect invalidates an in-flight connect so a late open cannot resurrect it", async () => {
    const { service, transports } = createHarness()
    const connection = service.connect()
    const disconnect = service.disconnect("disconnected")
    transports[0].open()

    await disconnect
    await assert.rejects(connection, /cancelled/)
    assert.equal(service.status, ControllerStatus.DISCONNECTED)
    assert.equal(service.isReconnectPending(), false)
})

test("connection loss rejects pending commands and does not poison later sends", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])
    const firstCommand = new Command("first")
    const pending = service.send(firstCommand)
    await flushTimers()

    transports[0].close()
    await assert.rejects(pending, /connection lost/)
    await flushTimers()
    transports[1].open()
    await flushTimers()

    const secondCommand = new Command("second")
    const completed = service.send(secondCommand, 100)
    transports[1].receive("ok\n")
    assert.equal(await completed, secondCommand)
    assert.deepEqual(transports[1].sent.includes("second\n"), true)
    await service.disconnect()
})

test("manual disconnect rejects pending commands and clears the queue", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])
    const firstCommand = new Command("first")
    const pending = service.send(firstCommand)
    await flushTimers()

    await service.disconnect("disconnected")
    await assert.rejects(pending, /WebSocket disconnected/)
    assert.equal(service.isReconnectPending(), false)
})

test("hard reset cancels an already pending reconnect before starting its own connect", async () => {
    const { service, transports } = createHarness()
    service.setReconnectConfig({ maxAttempts: 3, baseDelayMs: 50 })
    const initialConnection = service.connect()
    transports[0].fail()
    await assert.rejects(initialConnection, /failed to connect/)
    assert.equal(service.isReconnectPending(), true)

    const reset = service.hardReset()
    await new Promise((resolve) => setTimeout(resolve, 525))
    assert.equal(transports.length, 2)
    transports[1].open()
    await reset
    await new Promise((resolve) => setTimeout(resolve, 75))

    assert.equal(transports.length, 2)
    assert.equal(service.status, ControllerStatus.CONNECTED)
    await service.disconnect()
})

test("manual disconnect during hard-reset delay prevents stale reconnect", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])

    const reset = service.hardReset()
    await flushTimers()
    await service.disconnect("manual", true)
    await reset

    assert.equal(transports.length, 1)
    assert.equal(service.status, ControllerStatus.DISCONNECTED)
})

test("terminal reconnect failure invalidates a late final open", async () => {
    const { service, transports } = createHarness()
    service.setReconnectConfig({ maxAttempts: 1, baseDelayMs: 0 })
    await connectTransport(service, transports[0])

    transports[0].close()
    await flushTimers()
    assert.equal(transports.length, 2)
    assert.equal(service.status, ControllerStatus.CONNECTING)

    // A second loss signal while the only allowed retry is still opening must
    // retire that attempt and make its eventual open stale.
    service.handleConnectionLoss()
    assert.equal(service.status, ControllerStatus.DISCONNECTED)
    transports[1].open()
    await flushTimers()

    assert.equal(service.status, ControllerStatus.DISCONNECTED)
    assert.equal(service.isReconnectPending(), false)
})

test("send rejects instead of reporting an unsent command as successful", async () => {
    const { service } = createHarness()
    await assert.rejects(service.send(new Command("unsent"), 100), /not connected/)
    await service.disconnect()
})

test("ping write rejection is consumed instead of becoming unhandled", async () => {
    const { service, transports } = createHarness()
    const unhandled = []
    const listener = (reason) => unhandled.push(reason)
    process.on("unhandledRejection", listener)
    try {
        transports[0].send = () => { throw new Error("ping send failed") }
        await connectTransport(service, transports[0])
        await flushTimers()
        assert.deepEqual(unhandled, [])
    } finally {
        process.removeListener("unhandledRejection", listener)
        await service.disconnect()
    }
})

test("an ERROR control frame does not implicitly cancel unrelated HTTP work", async () => {
    const { service, transports } = createHarness()
    let errorCalls = 0
    service.setErrorHandler(() => errorCalls++)
    service.setErrorHandler(undefined)
    transports[0].receive("ERROR:42:controller failure")

    assert.equal(errorCalls, 0)
    await service.disconnect()
})

test("binary FluidNC command response completes the pending command", async () => {
    const { service, transports } = createHarness()
    await connectTransport(service, transports[0])
    const command = new Command("$Settings/List")
    const completed = service.send(command, 100)

    transports[0].receive(new TextEncoder().encode("setting:value\nok\n").buffer)

    assert.equal(await completed, command)
    assert.deepEqual(command.response, ["setting:value", "ok"])
    await service.disconnect()
})

test("binary payload is routed exactly once as stream and never as core", async () => {
    const { service, transports } = createHarness()
    const routed = []
    service.setDataListener((type, value) => routed.push([type, value]))
    const bytes = new TextEncoder().encode("status-line\n")

    transports[0].receive(bytes.buffer)

    assert.deepEqual(routed, [["stream", "status-line\n"]])
    await service.disconnect()
})

test("context-owned data listener can be refreshed without retaining the stale closure", async () => {
    const { service, transports } = createHarness()
    const oldContext = []
    const newContext = []
    const additional = []

    service.setDataListener((_type, value) => oldContext.push(value))
    service.addDataListener((_type, value) => additional.push(value))
    service.setDataListener((_type, value) => newContext.push(value))
    transports[0].receive("line\n")

    assert.deepEqual(oldContext, [])
    assert.deepEqual(newContext, ["line"])
    assert.deepEqual(additional, ["line"])
    await service.disconnect()
})
