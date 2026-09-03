import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import { h, render } from "preact"
import * as preactHooks from "preact/hooks"
import { act } from "preact/test-utils"
import ts from "typescript"

function createRenderRoot() {
    const document = {
        location: { hostname: "fluidnc.local", port: "", protocol: "http:" },
        createElement: (name) => createNode(1, name, document),
        createElementNS: (_namespace, name) => createNode(1, name, document),
        createTextNode: (data) => ({ nodeType: 3, data, ownerDocument: document, parentNode: null }),
        createComment: (data) => ({ nodeType: 8, data, ownerDocument: document, parentNode: null }),
    }
    return { document, root: createNode(1, "div", document) }
}

function createNode(nodeType, name, ownerDocument) {
    return {
        nodeType,
        localName: name,
        nodeName: name.toUpperCase(),
        ownerDocument,
        parentNode: null,
        childNodes: [],
        style: {},
        appendChild(node) {
            return this.insertBefore(node, null)
        },
        insertBefore(node, reference) {
            const index = reference == null ? -1 : this.childNodes.indexOf(reference)
            if (node.parentNode) node.parentNode.removeChild(node)
            if (index < 0) this.childNodes.push(node)
            else this.childNodes.splice(index, 0, node)
            node.parentNode = this
            return node
        },
        removeChild(node) {
            const index = this.childNodes.indexOf(node)
            if (index >= 0) this.childNodes.splice(index, 1)
            node.parentNode = null
            return node
        },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
    }
}

async function loadHookHarness() {
    const adapters = []
    const services = []
    const serviceContextCalls = []
    const notificationHandlerCalls = []
    const connectionStateListenerCalls = []
    const pingListenerCalls = []
    const sessionTimeoutListenerCalls = []
    const errorHandlerCalls = []
    const dataListenerCalls = []

    class FakeAdapter {
        constructor(url) {
            this.url = url
            adapters.push(this)
        }
    }

    class FakeService {
        constructor(adapter) {
            this.adapter = adapter
            services.push(this)
        }

        setServiceContext(value) { serviceContextCalls.push(value) }
        setNotificationHandler(value) { notificationHandlerCalls.push(value) }
        setConnectionStateListener(value) { connectionStateListenerCalls.push(value) }
        setPingListener(value) { pingListenerCalls.push(value) }
        setSessionTimeoutListener(value) { sessionTimeoutListenerCalls.push(value) }
        setErrorHandler(value) { errorHandlerCalls.push(value) }
        setDataListener(value) { dataListenerCalls.push(value) }
    }

    let uiContext = {
        connection: { setConnectionState() {} },
        dialogs: { setShowKeepConnected() {} },
        uisettings: { getValue() {} },
        ui: { ready: false },
    }
    const toastsContext = { toasts: { addToast() {} } }
    const modalsContext = { modals: { clearModals() {} } }
    const settingsContext = {
        connectionSettings: {
            current: { WebSocketPort: "82", WebCommunication: "WebSocket" },
        },
        activity: { stopPolling() {} },
    }
    const targetContext = { processData() {} }

    const mocks = {
        "preact/hooks": preactHooks,
        "../Services/WebSocketService": { WebSocketService: FakeService },
        "../Services/WebSocketAdapter": { WebSocketAdapter: FakeAdapter },
        "../contexts": {
            useUiContext: () => uiContext,
            useToastsContext: () => toastsContext,
            useModalsContext: () => modalsContext,
            useSettingsContext: () => settingsContext,
        },
        "../targets": { useTargetContext: () => targetContext },
        "../components/Helpers": { dispatchToExtensions() {} },
        "../targets/CNC/FluidNC/eventMacros": { ingestConnectionState() {} },
        "../Services/WebSocketUrl": {
            buildWebSocketUrl: () => "ws://fluidnc.local:82/ws",
        },
    }

    const { document, root } = createRenderRoot()
    globalThis.document = document
    const context = vm.createContext({ console, document })
    const source = await readFile(new URL("../src/hooks/useWebSocketService.ts", import.meta.url), "utf8")
    const output = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2021,
            module: ts.ModuleKind.ES2022,
            isolatedModules: true,
        },
        fileName: "useWebSocketService.ts",
    }).outputText
    const hookModule = new vm.SourceTextModule(output, {
        context,
        identifier: "file:///useWebSocketService.ts",
    })

    await hookModule.link((specifier) => {
        const exports = mocks[specifier]
        if (!exports) throw new Error(`Unexpected import: ${specifier}`)
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
        }, { context, identifier: `mock:${specifier}` })
    })
    await hookModule.evaluate()

    return {
        root,
        hook: hookModule.namespace.useWebSocketService,
        getService: hookModule.namespace.getWebSocketService,
        adapters,
        services,
        serviceContextCalls,
        notificationHandlerCalls,
        connectionStateListenerCalls,
        pingListenerCalls,
        sessionTimeoutListenerCalls,
        errorHandlerCalls,
        dataListenerCalls,
        setUiContext(value) { uiContext = value },
        getUiContext() { return uiContext },
    }
}

test("creates the singleton after readiness in an effect and refreshes callbacks", async () => {
    const harness = await loadHookHarness()
    const observed = []

    function Probe() {
        observed.push(harness.hook())
        return null
    }

    await act(() => {
        render(h(Probe, { revision: 0 }), harness.root)
        assert.equal(harness.adapters.length, 0, "render must not construct the transport adapter")
        assert.equal(observed.at(-1), undefined)
    })
    assert.equal(harness.adapters.length, 0, "settings readiness gates service construction")
    assert.equal(harness.getService(), undefined)

    const initialUiContext = harness.getUiContext()
    harness.setUiContext({ ...initialUiContext, ui: { ready: true } })
    await act(() => {
        render(h(Probe, { revision: 1 }), harness.root)
        assert.equal(harness.adapters.length, 0, "rerender must still be construction-free")
    })

    assert.equal(harness.adapters.length, 1)
    assert.equal(harness.services.length, 1)
    assert.equal(harness.getService(), harness.services[0])
    assert.equal(observed.at(-1), harness.services[0])
    assert.equal(harness.serviceContextCalls.length, 1)
    assert.equal(harness.notificationHandlerCalls.length, 1)
    assert.equal(harness.connectionStateListenerCalls.length, 1)
    assert.equal(harness.pingListenerCalls.length, 1)
    assert.equal(harness.sessionTimeoutListenerCalls.length, 1)
    assert.deepEqual(harness.errorHandlerCalls, [undefined])
    assert.equal(harness.dataListenerCalls.length, 1)

    const refreshedDialogs = { setShowKeepConnected() {} }
    harness.setUiContext({ ...harness.getUiContext(), dialogs: refreshedDialogs })
    await act(() => {
        render(h(Probe, { revision: 2 }), harness.root)
        assert.equal(harness.adapters.length, 1)
    })

    assert.equal(harness.services.length, 1, "rerenders preserve the singleton")
    assert.equal(harness.serviceContextCalls.length, 2)
    assert.equal(harness.serviceContextCalls.at(-1).dialogs, refreshedDialogs)

    await act(() => render(null, harness.root))
    await act(() => render(h(Probe, { revision: 3 }), harness.root))
    assert.equal(harness.services.length, 1, "remounts reuse the singleton")
    assert.equal(observed.at(-1), harness.services[0])

    await act(() => render(null, harness.root))
})
