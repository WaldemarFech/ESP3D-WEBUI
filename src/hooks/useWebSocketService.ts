import { useEffect, useState } from "preact/hooks"
import { WebSocketService } from "../Services/WebSocketService"
import { WebSocketAdapter } from "../Services/WebSocketAdapter"
import { useUiContext, useToastsContext, useModalsContext, useSettingsContext } from "../contexts"
import { useTargetContext } from "../targets"
import { dispatchToExtensions } from "../components/Helpers"
import { ingestConnectionState } from "../targets/CNC/FluidNC/eventMacros"
import { buildWebSocketUrl } from "../Services/WebSocketUrl"

let webSocketServiceInstance: WebSocketService | undefined

/**
 * Returns the persistent WebSocket service once its lifecycle owner has created it.
 * The first render is intentionally allowed to return undefined: constructing the
 * adapter also constructs the native WebSocket transport, so creation belongs in
 * an effect rather than render.
 */
export function useWebSocketService(): WebSocketService | undefined {
    const { connection, dialogs, uisettings, ui } = useUiContext()
    const { toasts } = useToastsContext()
    const { modals } = useModalsContext()
    const { processData } = useTargetContext()
    const { connectionSettings, activity } = useSettingsContext()
    const [service, setService] = useState<WebSocketService | undefined>(() => webSocketServiceInstance)
    const configuredPort = connectionSettings.current?.WebSocketPort
    const settingsReady = ui.ready

    useEffect(() => {
        if (!webSocketServiceInstance) {
            if (!settingsReady || !configuredPort) return
            const wsUrl = buildWebSocketUrl(document.location, {
                ...connectionSettings.current,
                WebSocketPort: configuredPort,
            })
            webSocketServiceInstance = new WebSocketService(new WebSocketAdapter(wsUrl))
        }

        const currentService = webSocketServiceInstance

        // Refresh context-owned callbacks on every provider update. The
        // transport singleton persists, but these closures must not remain
        // bound to whichever render happened to create it first.
        currentService.setServiceContext({
            dialogs,
            activity,
            modalsCleared: () => modals.clearModals(),
            extensionsNotify: (type, data, targetId) => dispatchToExtensions(type, data, targetId),
            uiSettings: uisettings,
            connectionSettings,
        })
        currentService.setNotificationHandler({
            addToast: (toast) => toasts.addToast(toast),
            clearModals: () => modals.clearModals(),
        })
        currentService.setConnectionStateListener((state) => {
            connection.setConnectionState(state)
            ingestConnectionState(state.connected)
        })
        currentService.setPingListener((timeRemaining) => {
            if (timeRemaining < 30000 && timeRemaining > 0) dialogs.setShowKeepConnected(true)
        })
        currentService.setSessionTimeoutListener(() => dialogs.setShowKeepConnected(false))
        currentService.setErrorHandler(undefined)
        currentService.setDataListener(processData)
        setService(currentService)
    }, [
        settingsReady,
        configuredPort,
        connection,
        dialogs,
        toasts,
        modals,
        processData,
        connectionSettings,
        activity,
        uisettings,
    ])

    return service
}

/** Gets the service after its lifecycle owner has created it. */
export function getWebSocketService(): WebSocketService | undefined {
    return webSocketServiceInstance
}
