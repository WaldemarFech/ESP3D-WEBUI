const captivePortalProbeHosts = [
    "google.com",
    "connectivitycheck.gstatic.com",
    "googleapis.com",
    "gstatic.com",
    "apple.com",
    "akamaitechnologies.com",
    "appleiphonecell.com",
    "itools.info",
    "ibook.info",
    "airport.us",
    "thinkdifferent.us",
    "akamaiedge.net",
    "msftncsi.com",
    "microsoft.com",
    "msftconnecttest.com",
    "detectportal.firefox.com",
    "network-test.debian.org",
    "nmcheck.gnome.org",
]

export function isCaptivePortalProbeHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
    return captivePortalProbeHosts.some((probeHost) => normalized === probeHost || normalized.endsWith(`.${probeHost}`))
}

export function resolveWebSocketHost(documentHost: string, settings: Record<string, any>): string {
    const configuredHost = typeof settings.WebSocketIP === "string" ? settings.WebSocketIP.trim() : ""
    const normalizedDocumentHost = documentHost.toLowerCase()
    const isDevelopmentHost = normalizedDocumentHost === "localhost" ||
        normalizedDocumentHost === "127.0.0.1" || normalizedDocumentHost === "::1" ||
        normalizedDocumentHost === "[::1]"
    const limitedAp = settings.WiFiMode === "AP" || settings.RadioMode === "AP"
    if (!isDevelopmentHost && limitedAp && isCaptivePortalProbeHost(documentHost) && configuredHost) {
        return configuredHost
    }
    return documentHost
}

const formatHostForUrl = (host: string): string =>
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host

const validPort = (value: unknown): string | undefined => {
    const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : ""
    if (!/^\d+$/.test(text)) return undefined
    const port = Number(text)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? String(port) : undefined
}

export function buildWebSocketUrl(
    documentLocation: { hostname: string; port: string; protocol?: string },
    settings: Record<string, any>
): string {
    const address = formatHostForUrl(resolveWebSocketHost(documentLocation.hostname, settings))
    const path = settings.WebCommunication === "Synchronous" ? "" : "/ws"
    const documentPort = validPort(documentLocation.port)
    const normalizedDocumentHost = documentLocation.hostname.toLowerCase()
    const isDevelopmentHost = normalizedDocumentHost === "localhost" ||
        normalizedDocumentHost === "127.0.0.1" || normalizedDocumentHost === "::1" ||
        normalizedDocumentHost === "[::1]"
    const derivedPort = isDevelopmentHost && documentPort ? validPort(Number(documentPort) + 2) : undefined
    const wsPort = derivedPort || validPort(settings.WebSocketPort) || "82"
    const protocol = documentLocation.protocol === "https:" ? "wss" : "ws"
    return `${protocol}://${address}:${wsPort}${path}`
}
