import type { WebSocketService } from "../../Services/WebSocketService"

export const wifiServiceUnavailableMessage = "WebSocket service is unavailable"

export const requireWifiService = (
    service: WebSocketService | undefined
): WebSocketService => {
    if (!service) throw new Error(wifiServiceUnavailableMessage)
    return service
}
