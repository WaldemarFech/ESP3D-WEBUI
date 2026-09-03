interface SemanticUploadResult {
    ok: boolean
    message: string
}

const responseObject = (response: unknown): Record<string, unknown> | null => {
    if (typeof response === "string") {
        const text = response.trim()
        if (!text) return null
        try {
            const parsed: unknown = JSON.parse(text)
            return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null
        } catch {
            return null
        }
    }

    return response != null && typeof response === "object" && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : null
}

const statusText = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value).trim() : ""

const parseFirmwareUploadResponse = (response: unknown): SemanticUploadResult => {
    const payload = responseObject(response)
    if (!payload) return { ok: false, message: "Firmware update returned an empty or malformed response" }

    const status = statusText(payload.status)
    if (status === "3") return { ok: true, message: "Firmware update accepted" }

    const labels: Record<string, string> = {
        "0": "no upload result",
        "1": "upload failed",
        "2": "upload cancelled",
        "4": "upload still in progress",
    }
    return {
        ok: false,
        message: `Firmware update did not complete (${labels[status] || `unexpected status ${status || "missing"}`})`,
    }
}

export { parseFirmwareUploadResponse }
export type { SemanticUploadResult }
