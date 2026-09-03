import assert from "node:assert/strict"
import test from "node:test"
import {
    getHttpFailureMessage,
    HttpFailure,
    toHttpFailure,
} from "../src/types/http.types.ts"

test("HttpFailure is a normal Error with primitive message compatibility", () => {
    const failure = new HttpFailure("503 - Busy", { code: 503, kind: "http" })

    assert.equal(failure instanceof Error, true)
    assert.equal(failure instanceof String, false)
    assert.equal(failure.message, "503 - Busy")
    assert.equal(failure.code, 503)
    assert.equal(failure.kind, "http")
    assert.equal(String(failure), "503 - Busy")
    assert.equal(`${failure}`, "503 - Busy")
    assert.equal(failure == "503 - Busy", true)
})

test("normalizer preserves metadata and classifies answered statuses", () => {
    const source = Object.assign(new Error("401 - Unauthorized"), { code: 401 })
    const failure = toHttpFailure(source, "network")

    assert.equal(failure.message, "401 - Unauthorized")
    assert.equal(failure.code, 401)
    assert.equal(failure.kind, "http")
})

test("message extraction handles errors, object failures, strings, and null", () => {
    assert.equal(getHttpFailureMessage(new Error("broken")), "broken")
    assert.equal(getHttpFailureMessage({ message: "object failure" }), "object failure")
    assert.equal(getHttpFailureMessage("plain failure"), "plain failure")
    assert.equal(getHttpFailureMessage(null), "")
})
