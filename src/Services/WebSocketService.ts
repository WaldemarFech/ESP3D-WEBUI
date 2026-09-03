import { WebSocketAdapter, WebSocketTransport } from "./WebSocketAdapter"
import { sleep } from "../../src/utils"
import { Command, CommandState } from "./Commands/Command"
import type { Toast } from "../../src/contexts/ToastsContext"

import {
    NotificationHandler,
    parseNotification,
    parseError,
    createConnectionErrorToast,
    createReconnectionToast,
    createMaxReconnectionToast,
} from "./NotificationHandlers"

export enum ControllerStatus {
    CONNECTION_LOST,
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    UNKNOWN_DEVICE,
}

export type ControllerStatusListener = (status: ControllerStatus) => void

interface PendingCommand {
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Service context for dependency injection
 * Provides access to app-level contexts from within the service
 */
export interface ServiceContext {
    dialogs: {
        setShowKeepConnected: (show: boolean) => void
    }
    activity?: {
        stopPolling: (id?: string) => void
    }
    modalsCleared?: () => void
    extensionsNotify?: (type: string, data: any, targetId?: string) => void
    uiSettings?: {
        getValue: (id: string) => any
    }
    connectionSettings?: {
        current?: {
            HostName?: string
        }
    }
}

export class WebSocketService {
    private wsAdapter: WebSocketAdapter
    private buffer: string = ""
    private connectPromise: Promise<ControllerStatus> | undefined
    private connectionEpoch = 0
    private connectionLossHandled = false
    private maxReconnectToastShown = false
    private commands: Command[] = []
    private pendingCommands = new Map<Command, PendingCommand>()
    private _status: ControllerStatus = ControllerStatus.DISCONNECTED
    private currentVersion: string | undefined
    private statusListeners: ControllerStatusListener[] = []

    // Auto-reconnection settings
    private reconnectAttempts: number = 0
    private maxReconnectAttempts: number = 4
    private baseRetryDelayMs: number = 2000
    private reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined
    private isManualDisconnect: boolean = false

    // Notification handler (optional)
    private notificationHandler: NotificationHandler | undefined

    // Ping/keep-alive settings
    private pingIntervalId: ReturnType<typeof setTimeout> | undefined
    private pingDelayMs: number = 5000 // 5 seconds
    private isPingPaused: boolean = false
    private sessionId: string | undefined
    private pingListener: ((timeRemaining: number, maxTime: number) => void) | undefined
    private pingListeners: Array<(timeRemaining: number, maxTime: number) => void> = []
    private sessionTimeoutListener: (() => void) | undefined

    // Error handler (called when ERROR message received from controller)
    private errorHandler: ((errorCode: string, errorMessage: string) => void) | undefined

    // Data routing (for core message processing)
    private dataListener: ((type: string, data: string) => void) | undefined
    private dataListeners: Array<(type: string, data: string) => void> = []

    // Connection state listener (for UI updates)
    // Matches UiContext ConnectionState: { connected: boolean; page: string; extraMsg?: string; updating?: boolean }
    private connectionStateListener:
        | ((state: { connected: boolean; page: string; extraMsg?: string; updating?: boolean }) => void)
        | undefined

    // Service context for dependency injection (app-level contexts)
    private serviceContext: ServiceContext | undefined

    constructor(wsAdapter: WebSocketAdapter, notificationHandler?: NotificationHandler) {
        this.wsAdapter = wsAdapter
        this.notificationHandler = notificationHandler

        // Register one text listener so controller control frames are handled
        // exclusively and cannot contaminate the newline-framed data buffer.
        this.wsAdapter.addReader(this._handleTextData)

        // Register binary data listener for terminal/stream data
        this.wsAdapter.addBinaryReader(this._handleBinaryData)

        // Register error listener and one per-service close listener. The adapter
        // recreates transports; this listener is therefore attached to the adapter,
        // not to a single native socket instance.
        this.wsAdapter.addErrorListener(this._handleWebSocketError)
        this.wsAdapter.addCloseListener(this._handleWebSocketClose)
    }

    /**
     * Sets the service context for dependency injection
     * Provides access to app-level contexts (connectionSettings, dialogs, etc.)
     */
    setServiceContext(context: ServiceContext): void {
        this.serviceContext = context
    }

    /**
     * Establishes connection and initializes the controller
     * Automatically attempts to reconnect on connection loss
     */
    async connect(): Promise<ControllerStatus> {
        if (this.connectPromise) return this.connectPromise
        const epoch = ++this.connectionEpoch
        const connectPromise = this._connect(epoch)
        this.connectPromise = connectPromise
        try {
            return await connectPromise
        } finally {
            if (this.connectPromise === connectPromise) this.connectPromise = undefined
        }
    }

    private async _connect(epoch: number): Promise<ControllerStatus> {
        try {
            this.status = ControllerStatus.CONNECTING
            this.isManualDisconnect = false
            this.connectionLossHandled = false
            this._updateConnectionState({ connected: false, page: "connecting" })
            await this.wsAdapter.open()
            if (epoch !== this.connectionEpoch) throw new Error("WebSocket connection attempt was cancelled")

            this.buffer = ""
            this.status = ControllerStatus.CONNECTED
            this.connectionLossHandled = false
            this.reconnectAttempts = 0
            this.maxReconnectToastShown = false
            this._cancelReconnection()

            // Start ping mechanism
            this._startPing()

            // Update connection state and clear the transient "Connecting"
            // document title even when the routed page was already rendered.
            document.title = this.serviceContext?.connectionSettings?.current?.HostName || "ESP3D"
            this._updateConnectionState({ connected: true, page: "/" })

            // Notify extensions that we're connected
            if (this.serviceContext?.extensionsNotify) {
                this.serviceContext.extensionsNotify("notification", { isConnected: true }, "all")
            }

            return this.status
        } catch (error) {
            if (epoch !== this.connectionEpoch) throw error
            console.error("Failed to connect to controller:", error)
            if (!this.connectionLossHandled) this.status = ControllerStatus.DISCONNECTED
            if (!this.isManualDisconnect) this._scheduleReconnection()
            throw error
        }
    }

    /**
     * Disconnects from the controller
     * @param reason - Reason for disconnection (for UI feedback)
     * @param stopReconnect - If true, marks as manually disconnected (no auto-reconnect)
     * @param cleanup - If true, stops app activity and clears disconnect-owned UI state
     */
    async disconnect(reason: string = "disconnected", stopReconnect: boolean = true, cleanup = true): Promise<void> {
        console.log("Disconnect:", reason);

        ++this.connectionEpoch
        this.connectPromise = undefined
        this.buffer = ""
        this._updateConnectionState({ connected: false, page: reason })
        this._stopPing()
        this._rejectPendingCommands(new Error(`WebSocket disconnected: ${reason}`))
        if (stopReconnect) {
            this.isManualDisconnect = true
            this.status = ControllerStatus.DISCONNECTED
            this._cancelReconnection()
        }

        if (cleanup) this._performDisconnectCleanup()
        return this.wsAdapter.close()
    }

    /**
     * Idempotently handles externally detected connection loss. Unlike
     * disconnect(), this does not invalidate an in-flight connect epoch; it
     * rearms/schedules reconnect even while the socket is still CONNECTING.
     */
    handleConnectionLoss(reason: string = "connectionlost"): void {
        if (this.isManualDisconnect) return
        if (!this.connectionLossHandled) {
            this.connectionLossHandled = true
            this.buffer = ""
            this._stopPing()
            this._rejectPendingCommands(new Error("WebSocket connection lost"))
            console.log("Connection lost, attempting auto-reconnect")
            this.status = ControllerStatus.CONNECTION_LOST
            this._updateConnectionState({ connected: false, page: reason })
            this._showToast(createConnectionErrorToast(reason))
        }
        // Externally detected loss (for example repeated HTTP no-answer) can
        // occur while the browser still reports this socket OPEN. Retire it so
        // reconnect cannot immediately reuse a transport already deemed stale.
        void this.wsAdapter.close().catch((error) => {
            console.error("Failed to retire stale WebSocket:", error)
        })
        this._scheduleReconnection()
    }

    private _handleWebSocketClose = (): void => {
        this._stopPing()
        if (this.status === ControllerStatus.CONNECTED) {
            this.handleConnectionLoss()
        }
    }

    /**
     * Schedules a reconnection attempt
     */
    private _scheduleReconnection(): void {
        // Check if reconnection is allowed
        if (this.isManualDisconnect) {
            return
        }

        if (this.reconnectTimeoutId) return
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`)
            // Retire any final in-flight attempt before publishing terminal
            // cleanup. Otherwise a late open can resurrect CONNECTED after the
            // app has already stopped polling and cleared disconnect-owned UI.
            ++this.connectionEpoch
            this.connectPromise = undefined
            this.isManualDisconnect = true
            this.status = ControllerStatus.DISCONNECTED
            void this.wsAdapter.close().catch((error) => {
                console.error("Failed to retire final WebSocket attempt:", error)
            })
            if (!this.maxReconnectToastShown) {
                this.maxReconnectToastShown = true
                this._showToast(createMaxReconnectionToast())
            }
            this._updateConnectionState({ connected: false, page: "connectionlost" })
            this._performDisconnectCleanup()
            return
        }

        this.reconnectTimeoutId = setTimeout(async () => {
            this.reconnectTimeoutId = undefined
            if (this.isManualDisconnect) return
            this.reconnectAttempts++
            this._showToast(createReconnectionToast(this.reconnectAttempts, this.maxReconnectAttempts))
            try {
                await this.connect()
            } catch {
                // connect() schedules the next attempt after a failed open.
            }
        }, this.baseRetryDelayMs)
    }

    /**
     * Performs disconnect cleanup (called when max reconnections reached)
     * Stops polling, clears modals, and notifies extensions
     */
    private _performDisconnectCleanup(): void {
        // Stop any polling activity
        if (this.serviceContext?.activity) {
            this.serviceContext.activity.stopPolling()
        }

        // Clear all modals
        if (this.serviceContext?.modalsCleared) {
            this.serviceContext.modalsCleared()
        }

        // Notify extensions that we're disconnected
        if (this.serviceContext?.extensionsNotify) {
            this.serviceContext.extensionsNotify("notification", { isConnected: false }, "all")
        }
    }

    /**
     * Cancels any pending reconnection attempt
     */
    private _cancelReconnection(): void {
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId)
            this.reconnectTimeoutId = undefined
        }
    }

    /**
     * Sets or updates the notification handler
     */
    setNotificationHandler(handler: NotificationHandler | undefined): void {
        this.notificationHandler = handler
    }

    /**
     * Displays a toast notification if handler is available
     */
    private _showToast(toast: Omit<Toast, "id">): void {
        if (this.notificationHandler) {
            this.notificationHandler.addToast(toast)
        } else {
            console.log(`[${toast.type.toUpperCase()}] ${toast.content}`)
        }
    }

    /**
     * Handles incoming system messages (NOTIFICATION, ERROR, PING, CURRENTID, etc.)
     * Using arrow function to preserve 'this' context when passed as a callback
     */
    private _handleTextData = (message: string): void => {
        const lineBreakIndex = message.search(/[\r\n]/)
        if (lineBreakIndex > 0) {
            const firstLine = message.substring(0, lineBreakIndex)
            if (this._handleSystemMessage(firstLine)) {
                this.onData(message.substring(lineBreakIndex + 1))
                return
            }
        }
        if (!this._handleSystemMessage(message)) this.onData(message)
    }

    private _handleSystemMessage = (message: string): boolean => {
        const parts = message.split(":")
        if (parts.length < 2) return false

        const messageType = parts[0].replace(/_/g, "").toUpperCase()

        switch (messageType) {
            case "CURRENTID": {
                // Receive and store session ID both internally and in service context
                if (parts[1]) {
                    const sessionId = parts[1].replace(/[\r\n]+$/, "")
                    console.log(`Received session ID: ${  sessionId}`)
                    this.setSessionId(sessionId)
                }
                break
            }
            case "ACTIVEID": {
                // Another session connected - check if it's a different session
                if (parts[1]) {
                    const incomingSessionId = parts[1]

                    // Disconnect if this is a different session ID than ours
                    if (incomingSessionId !== this.getSessionId()) {
                        // The setting is labelled "Allow multiple WebUI connections":
                        // true permits this session to remain connected. Older targets
                        // may still emit ACTIVEID, so retain this cross-target guard.
                        const allowMultiple = this.serviceContext?.uiSettings?.getValue("disconnectonotherlogin") ?? true
                        if (!allowMultiple) {
                            console.warn(`Another session connected with different ID ${incomingSessionId}, disconnecting`)
                            this._showToast(createConnectionErrorToast("already connected"))
                            this.disconnect("already connected")
                        } else {
                            console.log(`Another session connected with different ID ${incomingSessionId}, multiple connections allowed`)
                        }
                    }
                }
                break
            }
            case "PING": {
                // Handle ping response
                this._handlePingResponse(parts)
                break
            }
            case "NOTIFICATION": {
                console.log(`Notification: ${  message}`)

                const notification = parseNotification(message)
                if (notification) {
                    this._showToast(notification)
                }
                break
            }
            case "ERROR": {
                console.log(message)

                // Parse error and call error handler if set
                const parts = message.split(":")
                if (parts.length >= 3) {
                    const errorCode = parts[1]
                    const errorMessage = parts.slice(2).join(":")

                    // Call error handler if registered (for aborting HTTP requests, etc.)
                    if (this.errorHandler) {
                        this.errorHandler(errorCode, errorMessage)
                    }
                }

                const error = parseError(message)
                if (error) {
                    this._showToast(error)
                }
                break
            }
            default:
                return false
        }
        return true
    }

    private onData = (data: string): void => {
        this.buffer += data.replace(/\r/g, "")

        let endLineIndex = this.buffer.indexOf("\n")
        while (endLineIndex >= 0) {
            const line = this.buffer.substring(0, endLineIndex)
            this.buffer = this.buffer.substring(endLineIndex + 1)

            // Check if this is a system message
            if (this.commands.length) {
                if (this.commands[0].debugReceive) {
                    console.log(`<<< ${  line}`)
                }
                this.commands[0].appendLine(line)
                if (this.commands[0].state === CommandState.DONE) {
                    this.commands = this.commands.slice(1)
                }
            } else {
                // Route unhandled core messages to data listeners
                console.log(`<<< ${  line}`)
                this._notifyDataListeners("core", line)
            }
            endLineIndex = this.buffer.indexOf("\n")
        }
    }

    /**
     * Writes raw data to the controller
     */
    async write(data: string | Buffer): Promise<void> {
        // Wait for other commands to finish
        while (this.commands.length > 0) {
            await sleep(100)
        }

        const stringData = typeof data === "string" ? data : data.toString()
        await this.wsAdapter.write(stringData)
        await sleep(100)
    }

    /**
     * Sends a command and waits for response
     */
    async send<T extends Command>(command: T, timeoutMs: number = 0): Promise<T> {
        if (!this.wsAdapter.isOpen()) {
            throw new Error("WebSocket is not connected")
        }

        if (command.debugSend) {
            console.log(`sending ${  command.getCommand()}`)
        }

        // Wait for other commands to finish
        while (this.commands.length > 0) {
            await sleep(100)
        }

        this.commands.push(command)
        const result = new Promise<T>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const pending: PendingCommand = { reject, timer }
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this._rejectCommand(command, new Error("Command timed out"))
                }, timeoutMs)
                pending.timer = timer
            }
            this.pendingCommands.set(command, pending)
            command.onDone = async () => {
                this.pendingCommands.delete(command)
                if (timer) clearTimeout(timer)
                resolve(command)
            }
        })

        this.buffer = ""
        try {
            await this.wsAdapter.write(`${command.getCommand()  }\n`)
        } catch (error) {
            this._rejectCommand(command, error)
        }
        return result
    }

    private _removeCommand(command: Command): void {
        const pending = this.pendingCommands.get(command)
        if (pending?.timer) clearTimeout(pending.timer)
        this.pendingCommands.delete(command)
        this.commands = this.commands.filter((c) => c !== command)
    }

    private _rejectCommand(command: Command, reason: unknown): void {
        const pending = this.pendingCommands.get(command)
        if (!pending) return
        this._removeCommand(command)
        pending.reject(reason)
    }

    private _rejectPendingCommands(reason: unknown): void {
        const pendingCommands = [...this.pendingCommands.values()]
        this.pendingCommands.clear()
        this.commands = []
        this.buffer = ""
        pendingCommands.forEach((pending) => {
            if (pending.timer) clearTimeout(pending.timer)
            pending.reject(reason)
        })
    }

    /**
     * Reconnects to the controller
     */
    async hardReset(): Promise<void> {
        this.status = ControllerStatus.CONNECTING
        try {
            this._cancelReconnection()
            this.reconnectAttempts = 0
            await this.disconnect("disconnected", false, false)
            const resetEpoch = this.connectionEpoch
            await sleep(500)
            if (this.isManualDisconnect || resetEpoch !== this.connectionEpoch) return
            await this.connect()
        } catch (error) {
            console.error("Hard reset failed:", error)
            this.status = ControllerStatus.DISCONNECTED
            throw error
        }
    }

    /**
     * Configures auto-reconnection settings
     */
    setReconnectConfig(options: { maxAttempts?: number; baseDelayMs?: number }): void {
        if (options.maxAttempts !== undefined) {
            this.maxReconnectAttempts = options.maxAttempts
        }
        if (options.baseDelayMs !== undefined) {
            this.baseRetryDelayMs = options.baseDelayMs
        }
    }

    /**
     * Gets current reconnection attempt count
     */
    getReconnectAttempts(): number {
        return this.reconnectAttempts
    }

    /**
     * Checks if a reconnection is pending
     */
    isReconnectPending(): boolean {
        return this.reconnectTimeoutId !== undefined
    }

    /**
     * Sets the session ID (typically from CURRENTID message)
     */
    setSessionId(sessionId: string): void {
        this.sessionId = sessionId
    }

    /**
     * Gets the current session ID
     */
    getSessionId(): string | undefined {
        return this.sessionId
    }

    /**
     * Pauses ping messages (useful during HTTP requests)
     */
    setPingPaused(paused: boolean): void {
        this.isPingPaused = paused
    }

    /**
     * Checks if ping is paused
     */
    isPingPausedStatus(): boolean {
        return this.isPingPaused
    }

    /**
     * Configures ping settings
     */
    setPingConfig(options: { delayMs?: number }): void {
        if (options.delayMs !== undefined) {
            this.pingDelayMs = options.delayMs
        }
    }

    /**
     * Starts the ping mechanism (automatic after connect)
     */
    private _startPing(): void {
        if (this.pingIntervalId) {
            return // Already running
        }

        const sendPing = () => {
            if (this.isManualDisconnect) {
                return
            }

            if (!this.isPingPaused && this.wsAdapter.isOpen()) {
                const pingmsg = `PING:${this.sessionId || "none"}`
                this.wsAdapter.write(pingmsg).catch((error) => {
                    console.error("Failed to send ping:", error)
                })
            }

            // Schedule next ping
            this.pingIntervalId = setTimeout(sendPing, this.pingDelayMs)
        }

        // Send first ping immediately, then schedule the rest
        sendPing()
    }

    /**
     * Stops the ping mechanism
     */
    private _stopPing(): void {
        if (this.pingIntervalId) {
            clearTimeout(this.pingIntervalId)
            this.pingIntervalId = undefined
        }
    }

    /**
     * Handles PING response messages
     * Format: PING:timeRemaining:maxTime
     */
    private _handlePingResponse(parts: string[]): void {
        if (parts.length < 3) {
            return
        }

        const timeRemaining = parseInt(parts[1], 10)
        const maxTime = parseInt(parts[2], 10)

        // Notify listeners
        if (this.pingListener) {
            try {
                this.pingListener(timeRemaining, maxTime)
            } catch (_error) {
                console.error("Error in ping listener:", _error)
            }
        }
        this.pingListeners.forEach((listener) => {
            try {
                listener(timeRemaining, maxTime)
            } catch (_error) {
                console.error("Error in ping listener:", _error)
            }
        })

        // Check for session timeout
        if (timeRemaining <= 0) {
            console.warn("Session timeout detected (timeRemaining <= 0)")
            if (this.sessionTimeoutListener) {
                this.sessionTimeoutListener()
            }
            this.disconnect("sessiontimeout", true)
        }
    }

    /**
     * Adds a listener for ping responses
     * Called when PING response is received from controller
     */
    addPingListener(listener: (timeRemaining: number, maxTime: number) => void): () => void {
        this.pingListeners.push(listener)

        // Return unregister function
        return () => {
            this.pingListeners = this.pingListeners.filter((l) => l !== listener)
        }
    }

    setPingListener(listener: ((timeRemaining: number, maxTime: number) => void) | undefined): void {
        this.pingListener = listener
    }

    /**
     * Sets a callback for session timeout
     */
    setSessionTimeoutListener(callback: (() => void) | undefined): void {
        this.sessionTimeoutListener = callback
    }

    /**
     * Sets a callback for when ERROR messages are received from the controller
     * Allows app to handle errors (e.g., abort HTTP requests)
     */
    setErrorHandler(callback: ((errorCode: string, errorMessage: string) => void) | undefined): void {
        this.errorHandler = callback
    }

    /**
     * Adds a status listener
     */
    addListener(listener: ControllerStatusListener): void {
        this.statusListeners.push(listener)
    }

    /**
     * Removes a status listener
     */
    removeListener(listener: ControllerStatusListener): void {
        this.statusListeners = this.statusListeners.filter((l) => l !== listener)
    }

    /**
     * Sets the status and notifies all listeners
     */
    set status(status: ControllerStatus) {
        this._status = status
        this.statusListeners.forEach((l) => l(status))
    }

    /**
     * Gets the current status
     */
    get status(): ControllerStatus {
        return this._status
    }

    /**
     * Handles binary data (terminal/stream data from ArrayBuffer)
     */
    private _handleBinaryData = (data: ArrayBuffer): void => {
        try {
            const decodedString = new TextDecoder("utf-8").decode(data)
            // FluidNC emits command replies as binary WebSocket frames. Feed
            // them through the command parser while a request is pending; only
            // unsolicited binary payload is terminal/stream data for the UI.
            if (this.commands.length > 0) this.onData(decodedString)
            else this._notifyDataListeners("stream", decodedString)
        } catch (error) {
            console.error("Error decoding binary data:", error)
        }
    }

    /**
     * Handles WebSocket errors (equivalent to onErrorCB in WsContext)
     * Shows error toast and increments reconnection counter
     */
    private _handleWebSocketError = (_error: Event): void => {
        console.log("WebSocket error occurred")
        if (this.status !== ControllerStatus.CONNECTED || this.connectionLossHandled || this.isManualDisconnect) return
        this.handleConnectionLoss()
    }

    /**
     * Adds a listener for core data routing
     * Called for non-command messages that should be processed by the UI
     */
    addDataListener(listener: (type: string, data: string) => void): () => void {
        this.dataListeners.push(listener)
        // Return unregister function
        return () => {
            this.dataListeners = this.dataListeners.filter((l) => l !== listener)
        }
    }

    /**
     * Replaces the context-owned data route while preserving any additional
     * listeners registered by callers.
     */
    setDataListener(listener: ((type: string, data: string) => void) | undefined): void {
        this.dataListener = listener
    }

    /**
     * Notifies all data listeners
     */
    private _notifyDataListeners(type: string, data: string): void {
        if (this.dataListener) {
            try {
                this.dataListener(type, data)
            } catch (error) {
                console.error("Error in data listener:", error)
            }
        }
        this.dataListeners.forEach((listener) => {
            try {
                listener(type, data)
            } catch (error) {
                console.error("Error in data listener:", error)
            }
        })
    }

    /**
     * Sets the connection state listener for UI updates
     */
    setConnectionStateListener(
        listener:
            | ((state: { connected: boolean; page: string; extraMsg?: string; updating?: boolean }) => void)
            | undefined
    ): void {
        this.connectionStateListener = listener
    }

    /**
     * Updates connection state and notifies UI
     */
    private _updateConnectionState(state: {
        connected: boolean
        page: string
        extraMsg?: string
        updating?: boolean
    }): void {
        if (this.connectionStateListener) {
            try {
                this.connectionStateListener(state)
            } catch (_error) {
                console.error("Error in connection state listener:", _error)
            }
        }
    }

    /**
     * Gets the native WebSocket for advanced usage or fallback scenarios
     */
    getNativeWebSocket(): WebSocketTransport {
        return this.wsAdapter.getNativeWebSocket()
    }
}
