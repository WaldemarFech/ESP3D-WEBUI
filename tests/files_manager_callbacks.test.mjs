import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { createSerialFailureHandler } = await importTypeScript("../src/hooks/filesManagerCallbacks.ts")
const { HttpFailure } = await importTypeScript("../src/types/http.types.ts")

test("serial transport failure performs catch cleanup, clears loading, and shows text", () => {
    const calls = []
    const onFail = createSerialFailureHandler({
        stopCatchResponse: () => calls.push("stop-catch"),
        stopLoading: () => calls.push("stop-loading"),
        showError: (message) => calls.push(["toast", message]),
    })

    onFail(new HttpFailure("transport offline", { kind: "network" }))

    assert.deepEqual(calls, [
        "stop-catch",
        "stop-loading",
        ["toast", "transport offline"],
    ])
})
