export interface ExternalLinkWindow {
    open(url: string, target: string, features: string): { opener: unknown } | null
}

const absoluteHttpUrlPattern = /^https?:\/\/[^/?#\\]+(?:[/?#]|$)/i
const hasAsciiWhitespaceOrControl = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        if (code <= 0x20 || code === 0x7f) return true
    }
    return false
}

export const safeExternalHttpUrl = (value: unknown): string | null => {
    if (
        typeof value !== "string" ||
        hasAsciiWhitespaceOrControl(value) ||
        !absoluteHttpUrlPattern.test(value)
    ) {
        return null
    }

    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
    } catch {
        return null
    }
}

export const openSafeExternalUrl = (value: unknown, targetWindow: ExternalLinkWindow): boolean => {
    const url = safeExternalHttpUrl(value)
    if (!url) return false

    const openedWindow = targetWindow.open(url, "_blank", "noopener,noreferrer")
    if (openedWindow) {
        try {
            openedWindow.opener = null
        } catch {
            // The noopener feature still isolates the new browsing context.
        }
    }
    return true
}
