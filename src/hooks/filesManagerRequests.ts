export interface FilesRequestScope {
    download: (scopeId: string) => string
    uploadBatch: (batchId: string, fileCount: number) => string[]
}

export const filesRequestScope: FilesRequestScope = {
    download: (scopeId: string): string => `download-files-${scopeId}`,
    uploadBatch: (batchId: string, fileCount: number): string[] =>
        Array.from(
            { length: fileCount },
            (_entry, index) => `upload-${batchId}-${index}`
        ),
}

export const cancelScopedRequests = (
    requestIds: readonly string[],
    abortRequest: (requestId: string) => void
): void => {
    requestIds.forEach((requestId) => abortRequest(requestId))
}
