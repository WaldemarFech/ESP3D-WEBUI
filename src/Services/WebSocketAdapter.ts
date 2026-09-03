/**
 * WebSocket adapter that provides a SerialPort-like interface
 * for use with WebSocketService.
 */

export type DataListener = (data: string) => void
export type BinaryDataListener = (data: ArrayBuffer) => void
export type ErrorListener = (error: Event) => void
export type CloseListener = (event: CloseEvent) => void

export interface WebSocketTransport {
    binaryType: BinaryType
    readyState: number
    onopen: ((event: Event) => void) | null
    onmessage: ((event: MessageEvent) => void) | null
    onerror: ((event: Event) => void) | null
    onclose: ((event: CloseEvent) => void) | null
    addEventListener(type: "open" | "error", listener: (event: Event) => void): void
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void
    addEventListener(type: "close", listener: (event: CloseEvent) => void): void
    removeEventListener(type: "open" | "error", listener: (event: Event) => void): void
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
    removeEventListener(type: "close", listener: (event: CloseEvent) => void): void
    close(): void
    send(data: string): void
}

export type WebSocketTransportFactory = (url: string, protocol: string) => WebSocketTransport

const defaultTransportFactory: WebSocketTransportFactory = (url, protocol) => new WebSocket(url, protocol)

export class WebSocketAdapter {
    private ws: WebSocketTransport
    private readonly url: string
    private readonly protocol: string
    private readonly transportFactory: WebSocketTransportFactory
    private dataListeners: DataListener[] = []
    private binaryDataListeners: BinaryDataListener[] = []
    private errorListeners: ErrorListener[] = []
    private closeListeners: CloseListener[] = []
    private isOpenFlag = false
    private openPromise: Promise<void> | undefined
    private readonly openTimeoutMs = 8_000

    constructor(url: string, protocol = "webui-v3", transportFactory = defaultTransportFactory) {
        this.url = url
        this.protocol = protocol
        this.transportFactory = transportFactory
        this.ws = this.createTransport()
    }

    private createTransport(): WebSocketTransport {
        const transport = this.transportFactory(this.url, this.protocol)
        transport.binaryType = "arraybuffer"
        transport.onopen = () => {
            if (transport !== this.ws) return
            this.isOpenFlag = true
            console.log("WebSocket connected")
        }
        transport.onmessage = (event) => {
            if (transport !== this.ws) return
            if (event.data instanceof ArrayBuffer) this.notifyBinaryListeners(event.data)
            else this.notifyListeners(event.data as string)
        }
        transport.onerror = (error) => {
            if (transport !== this.ws) return
            console.error("WebSocket error:", error)
            this.notifyErrorListeners(error)
        }
        transport.onclose = (event) => {
            if (transport !== this.ws) return
            this.isOpenFlag = false
            console.log("WebSocket disconnected")
            this.closeListeners.forEach((listener) => {
                try {
                    listener(event)
                } catch (error) {
                    console.error("Error in close listener:", error)
                }
            })
        }
        return transport
    }

    private recreateIfClosed(): void {
        if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
            this.isOpenFlag = false
            this.ws = this.createTransport()
        }
    }

    isOpen(): boolean {
        return this.isOpenFlag && this.ws.readyState === WebSocket.OPEN
    }

    async open(timeoutMs = this.openTimeoutMs): Promise<void> {
        if (this.isOpen()) return
        // A pending attempt is bound to one immutable transport. Do not replace
        // that transport underneath concurrent callers while it is closing.
        if (this.openPromise) return this.openPromise
        this.recreateIfClosed()

        const transport = this.ws
        const openPromise = new Promise<void>((resolve, reject) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | undefined
            const settle = (error?: Error) => {
                if (settled) return
                settled = true
                if (timeout) clearTimeout(timeout)
                transport.removeEventListener("open", onOpen)
                transport.removeEventListener("close", onClose)
                transport.removeEventListener("error", onError)
                if (this.openPromise === openPromise) this.openPromise = undefined
                if (error) reject(error)
                else resolve()
            }
            const onOpen = () => settle()
            const onClose = () => settle(new Error("WebSocket failed to connect"))
            const onError = () => settle(new Error("WebSocket failed to connect"))
            timeout = setTimeout(() => {
                try {
                    if (transport.readyState === WebSocket.CONNECTING || transport.readyState === WebSocket.OPEN) transport.close()
                } catch (error) {
                    console.error("Failed to close timed-out WebSocket:", error)
                }
                settle(new Error("WebSocket connection timeout"))
            }, timeoutMs)
            transport.addEventListener("open", onOpen)
            transport.addEventListener("close", onClose)
            transport.addEventListener("error", onError)
            if (this.isOpen() && transport === this.ws) settle()
            else if (transport.readyState === WebSocket.CLOSED) settle(new Error("WebSocket failed to connect"))
        })
        this.openPromise = openPromise
        return openPromise
    }

    async close(timeoutMs = this.openTimeoutMs): Promise<void> {
        const transport = this.ws
        this.openPromise = undefined
        if (transport.readyState === WebSocket.CLOSED) return
        await new Promise<void>((resolve) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | undefined
            const settle = () => {
                if (settled) return
                settled = true
                if (timeout) clearTimeout(timeout)
                transport.removeEventListener("close", onClose)
                if (transport === this.ws) this.isOpenFlag = false
                resolve()
            }
            const onClose = () => settle()
            transport.addEventListener("close", onClose)
            timeout = setTimeout(settle, timeoutMs)
            try {
                transport.close()
            } catch {
                settle()
            }
        })
    }

    async write(data: Buffer | string): Promise<void> {
        if (!this.isOpen()) throw new Error("WebSocket is not connected")
        this.ws.send(typeof data === "string" ? data : data.toString())
    }

    addReader(listener: DataListener): () => void {
        this.dataListeners.push(listener)
        return () => { this.dataListeners = this.dataListeners.filter((item) => item !== listener) }
    }

    removeReader(listener: DataListener): void { this.dataListeners = this.dataListeners.filter((item) => item !== listener) }

    addBinaryReader(listener: BinaryDataListener): () => void {
        this.binaryDataListeners.push(listener)
        return () => { this.binaryDataListeners = this.binaryDataListeners.filter((item) => item !== listener) }
    }

    removeBinaryReader(listener: BinaryDataListener): void { this.binaryDataListeners = this.binaryDataListeners.filter((item) => item !== listener) }

    addErrorListener(listener: ErrorListener): () => void {
        this.errorListeners.push(listener)
        return () => { this.errorListeners = this.errorListeners.filter((item) => item !== listener) }
    }

    addCloseListener(listener: CloseListener): () => void {
        this.closeListeners.push(listener)
        return () => { this.closeListeners = this.closeListeners.filter((item) => item !== listener) }
    }

    getNativeWebSocket(): WebSocketTransport { return this.ws }
    getUrl(): string { return this.url }
    getProtocol(): string { return this.protocol }

    async waitForConnection(timeoutMs = this.openTimeoutMs): Promise<void> { return this.open(timeoutMs) }

    private notifyListeners(data: string): void {
        this.dataListeners.forEach((listener) => { try { listener(data) } catch (error) { console.error("Error in data listener:", error) } })
    }

    private notifyBinaryListeners(data: ArrayBuffer): void {
        this.binaryDataListeners.forEach((listener) => { try { listener(data) } catch (error) { console.error("Error in binary data listener:", error) } })
    }

    private notifyErrorListeners(error: Event): void {
        this.errorListeners.forEach((listener) => { try { listener(error) } catch (err) { console.error("Error in error listener:", err) } })
    }
}
