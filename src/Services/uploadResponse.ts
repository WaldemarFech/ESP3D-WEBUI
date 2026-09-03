interface SemanticUploadResult {
    ok: boolean
    message: string
}

interface FileUploadSuccessDependencies {
    onAccepted: (result: unknown) => void
    onRejected: (message: string) => void
}

interface FileUploadBatchFailureDependencies {
    cancelBatch: () => void
    closeProgress: () => void
    stopLoading: () => void
    showError: (message: string) => void
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

const parseFileUploadResponse = (response: unknown): SemanticUploadResult => {
    const payload = responseObject(response)
    if (!payload) return { ok: false, message: "File upload returned an empty or malformed response" }

    const status = statusText(payload.status)
    if (status.toLowerCase() === "ok") return { ok: true, message: "File upload accepted" }

    return {
        ok: false,
        message: `File upload failed (${status || "missing status"})`,
    }
}

const createFileUploadSuccessHandler = ({
    onAccepted,
    onRejected,
}: FileUploadSuccessDependencies): ((result: unknown) => void) => {
    return (result: unknown): void => {
        const uploadResult = parseFileUploadResponse(result)
        if (!uploadResult.ok) {
            onRejected(uploadResult.message)
            return
        }
        onAccepted(result)
    }
}

const createFileUploadBatchFailureHandler = ({
    cancelBatch,
    closeProgress,
    stopLoading,
    showError,
}: FileUploadBatchFailureDependencies): ((message: string) => void) => {
    let failed = false
    return (message: string): void => {
        if (failed) return
        failed = true
        cancelBatch()
        closeProgress()
        stopLoading()
        showError(message)
    }
}

export {
    createFileUploadBatchFailureHandler,
    createFileUploadSuccessHandler,
    parseFileUploadResponse,
}
export type {
    FileUploadBatchFailureDependencies,
    FileUploadSuccessDependencies,
    SemanticUploadResult,
}
