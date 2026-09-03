import assert from "node:assert/strict"
import test from "node:test"
import {
    createFileUploadBatchFailureHandler,
    createFileUploadSuccessHandler,
    parseFileUploadResponse,
} from "../src/Services/uploadResponse.ts"
import { parseFirmwareUploadResponse } from "../src/pages/about/uploadResponse.ts"

test("accepts successful firmware upload responses", () => {
    assert.deepEqual(parseFirmwareUploadResponse('{"status":"3"}'), {
        ok: true,
        message: "Firmware update accepted",
    })
    assert.equal(parseFirmwareUploadResponse({ status: 3 }).ok, true)
})

test("rejects each non-success firmware status with a useful reason", () => {
    const expectedLabels = new Map([
        ["0", "no upload result"],
        ["1", "upload failed"],
        ["2", "upload cancelled"],
        ["4", "upload still in progress"],
    ])

    for (const [status, label] of expectedLabels) {
        const result = parseFirmwareUploadResponse({ status })
        assert.equal(result.ok, false)
        assert.match(result.message, new RegExp(label))
    }
})

test("rejects missing, unexpected, and malformed firmware responses", () => {
    assert.deepEqual(parseFirmwareUploadResponse(""), {
        ok: false,
        message: "Firmware update returned an empty or malformed response",
    })
    assert.match(parseFirmwareUploadResponse("not json").message, /malformed response/)
    assert.match(parseFirmwareUploadResponse({}).message, /missing/)
    assert.match(parseFirmwareUploadResponse({ status: "unexpected" }).message, /unexpected status unexpected/)
    assert.match(parseFirmwareUploadResponse([]).message, /malformed response/)
})

test("accepts file upload success case-insensitively from strings or objects", () => {
    assert.deepEqual(parseFileUploadResponse('{"status":"Ok"}'), {
        ok: true,
        message: "File upload accepted",
    })
    assert.equal(parseFileUploadResponse({ status: "ok" }).ok, true)
    assert.equal(parseFileUploadResponse({ status: " OK " }).ok, true)
})

test("rejects failed, missing, and malformed file upload responses", () => {
    assert.deepEqual(parseFileUploadResponse('{"status":"Upload failed"}'), {
        ok: false,
        message: "File upload failed (Upload failed)",
    })
    assert.match(parseFileUploadResponse({}).message, /missing status/)
    assert.match(parseFileUploadResponse(null).message, /malformed response/)
    assert.match(parseFileUploadResponse("not json").message, /malformed response/)
    assert.match(parseFileUploadResponse([{"status":"Ok"}]).message, /malformed response/)
    assert.equal(parseFileUploadResponse('{"status":"OKAY"}').ok, false)
    assert.equal(parseFileUploadResponse('{"status":"Not OK"}').ok, false)
    assert.equal(parseFileUploadResponse('"ok"').ok, false)
    assert.equal(parseFileUploadResponse("1").ok, false)
    assert.equal(parseFileUploadResponse("true").ok, false)
    assert.equal(parseFileUploadResponse({ status: {} }).ok, false)
    assert.equal(parseFileUploadResponse({ status: [] }).ok, false)
})

test("file upload success handler runs only the accepted path", () => {
    const calls = []
    const onSuccess = createFileUploadSuccessHandler({
        onAccepted: (result) => calls.push(["accepted", result]),
        onRejected: (message) => calls.push(["rejected", message]),
    })

    const response = '{"status":"Ok"}'
    onSuccess(response)

    assert.deepEqual(calls, [["accepted", response]])
})

test("file upload success handler diverts semantic 2xx failures", () => {
    const calls = []
    const onSuccess = createFileUploadSuccessHandler({
        onAccepted: (result) => calls.push(["accepted", result]),
        onRejected: (message) => calls.push(["rejected", message]),
    })

    onSuccess('{"status":"Upload failed"}')

    assert.deepEqual(calls, [["rejected", "File upload failed (Upload failed)"]])
})

test("batch failure cleanup is complete and idempotent", () => {
    const calls = []
    const rejectBatch = createFileUploadBatchFailureHandler({
        cancelBatch: () => calls.push("cancel-batch"),
        closeProgress: () => calls.push("close-progress"),
        stopLoading: () => calls.push("stop-loading"),
        showError: (message) => calls.push(["error", message]),
    })

    rejectBatch("semantic failure")
    rejectBatch("late duplicate failure")

    assert.deepEqual(calls, [
        "cancel-batch",
        "close-progress",
        "stop-loading",
        ["error", "semantic failure"],
    ])
})
