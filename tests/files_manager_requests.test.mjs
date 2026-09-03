import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { cancelScopedRequests, filesRequestScope } = await importTypeScript(
    "../src/hooks/filesManagerRequests.ts"
)
const {
    createFileUploadBatchFailureHandler,
    createFileUploadSuccessHandler,
} = await importTypeScript("../src/Services/uploadResponse.ts")
const { HttpQueueController } = await importTypeScript(
    "../src/contexts/HttpQueueController.ts"
)

const flush = () => new Promise((resolve) => setImmediate(resolve))

const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const request = (id, onSuccess = () => {}) => ({
    id,
    url: `http://files/${id}`,
    params: { id },
    onSuccess,
    onFail: () => {},
})

function createController(httpAdapter) {
    return new HttpQueueController({
        httpAdapter,
        processData: () => {},
        getConnectionState: () => ({ connected: true }),
        setConnectionState: () => {},
        getWebSocketService: () => undefined,
    })
}

const failure = (message, code, kind) => {
    const error = new Error(message)
    error.code = code
    error.kind = kind
    return error
}

test("Files request IDs are operation- and batch-scoped", () => {
    assert.equal(
        filesRequestScope.download("download-a"),
        "download-files-download-a"
    )
    assert.deepEqual(filesRequestScope.uploadBatch("batch-a", 3), [
        "upload-batch-a-0",
        "upload-batch-a-1",
        "upload-batch-a-2",
    ])
})

test("Files download cancellation cannot cancel an extension download", async () => {
    const filesDownloadId = filesRequestScope.download("files-a")
    const extensionRequestScope = {
        download: (scopeId) => `download-extension-${scopeId}`,
    }
    const extensionDownloadId = extensionRequestScope.download("extension-a")
    const filesDownload = deferred()
    const extensionDownload = deferred()
    const started = []
    const aborted = []
    const successes = []

    const controller = createController((_url, params) => {
        started.push(params.id)
        const active = params.id === filesDownloadId
            ? filesDownload
            : extensionDownload
        return {
            abort: () => {
                aborted.push(params.id)
                active.reject(failure("Request aborted", 499, "cancelled"))
            },
            response: active.promise,
        }
    })

    controller.addInQueue(request(filesDownloadId))
    controller.addInQueue(
        request(extensionDownloadId, (result) => successes.push(result))
    )

    controller.cancelRequests(filesDownloadId)
    await flush()
    extensionDownload.resolve("extension-result")
    await flush()
    await flush()

    assert.notEqual(filesDownloadId, extensionDownloadId)
    assert.deepEqual(aborted, [filesDownloadId])
    assert.deepEqual(started, [filesDownloadId, extensionDownloadId])
    assert.deepEqual(successes, ["extension-result"])
})

test("upload batch cancellation retains unrelated queued work", async () => {
    const uploadIds = filesRequestScope.uploadBatch("batch-a", 2)
    const firstUpload = deferred()
    const started = []
    const aborted = []
    const successes = []

    const controller = createController((_url, params) => {
        started.push(params.id)
        if (params.id === uploadIds[0]) {
            return {
                abort: () => {
                    aborted.push(params.id)
                    firstUpload.reject(
                        failure("Request aborted", 499, "cancelled")
                    )
                },
                response: firstUpload.promise,
            }
        }
        return {
            abort: () => aborted.push(params.id),
            response: Promise.resolve(params.id),
        }
    })

    controller.addInQueue(request(uploadIds[0]))
    controller.addInQueue(request("unrelated", (result) => successes.push(result)))
    controller.addInQueue(request(uploadIds[1]))

    cancelScopedRequests(uploadIds, (id) => controller.cancelRequests(id))
    await flush()
    await flush()

    assert.deepEqual(aborted, [uploadIds[0]])
    assert.deepEqual(started, [uploadIds[0], "unrelated"])
    assert.deepEqual(successes, ["unrelated"])
})

test("semantic upload batch failure cleanup retains unrelated queued work", async () => {
    const uploadIds = filesRequestScope.uploadBatch("batch-semantic", 2)
    const started = []
    const aborted = []
    const successes = []
    const cleanup = []
    let controller

    controller = createController((_url, params) => {
        started.push(params.id)
        return {
            abort: () => aborted.push(params.id),
            response: Promise.resolve(
                params.id === uploadIds[0]
                    ? '{"status":"Upload failed"}'
                    : '{"status":"Ok"}'
            ),
        }
    })

    const rejectBatch = createFileUploadBatchFailureHandler({
        cancelBatch: () => cancelScopedRequests(
            uploadIds,
            (id) => controller.cancelRequests(id)
        ),
        closeProgress: () => cleanup.push("close-progress"),
        stopLoading: () => cleanup.push("stop-loading"),
        showError: (message) => cleanup.push(["error", message]),
    })

    controller.addInQueue({
        ...request(uploadIds[0]),
        onSuccess: createFileUploadSuccessHandler({
            onAccepted: (result) => successes.push(result),
            onRejected: rejectBatch,
        }),
    })
    controller.addInQueue(request("unrelated", (result) => successes.push(result)))
    controller.addInQueue(request(uploadIds[1], (result) => successes.push(result)))

    await flush()
    await flush()
    await flush()

    assert.deepEqual(aborted, [])
    assert.deepEqual(started, [uploadIds[0], "unrelated"])
    assert.deepEqual(successes, ["{\"status\":\"Ok\"}"])
    assert.deepEqual(cleanup, [
        "close-progress",
        "stop-loading",
        ["error", "File upload failed (Upload failed)"],
    ])
})

test("upload batch failure cleanup retains unrelated queued work", async () => {
    const uploadIds = filesRequestScope.uploadBatch("batch-b", 2)
    const started = []
    const aborted = []
    const successes = []
    let controller

    controller = createController((_url, params) => {
        started.push(params.id)
        return {
            abort: () => aborted.push(params.id),
            response: params.id === uploadIds[0]
                ? Promise.reject(new Error("upload failed"))
                : Promise.resolve(params.id),
        }
    })

    controller.addInQueue({
        ...request(uploadIds[0]),
        onFail: () => cancelScopedRequests(
            uploadIds,
            (id) => controller.cancelRequests(id)
        ),
    })
    controller.addInQueue(request("unrelated", (result) => successes.push(result)))
    controller.addInQueue(request(uploadIds[1]))

    await flush()
    await flush()
    await flush()

    assert.deepEqual(aborted, [])
    assert.deepEqual(started, [uploadIds[0], "unrelated"])
    assert.deepEqual(successes, ["unrelated"])
})
