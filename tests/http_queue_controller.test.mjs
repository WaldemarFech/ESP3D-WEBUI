import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { HttpQueueController } = await importTypeScript("../src/contexts/HttpQueueController.ts")

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

const failure = (message, code, kind) => {
    const error = new Error(message)
    if (code !== undefined) error.code = code
    if (kind !== undefined) error.kind = kind
    return error
}

function createHarness(httpAdapter, { maxNoAnswerCount = 4 } = {}) {
    const connectionState = { connected: true }
    const stateUpdates = []
    const echoes = []
    const connectionLossCalls = []
    const controller = new HttpQueueController({
        httpAdapter,
        processData: (type, data) => echoes.push([type, data]),
        getConnectionState: () => connectionState,
        setConnectionState: (state) => stateUpdates.push(state),
        getWebSocketService: () => ({
            handleConnectionLoss: (...args) => connectionLossCalls.push(args),
        }),
        maxNoAnswerCount,
    })
    return { controller, connectionLossCalls, echoes, stateUpdates }
}

function request(id, overrides = {}) {
    return {
        id,
        url: `http://controller/${id}`,
        params: {},
        onSuccess: () => {},
        onFail: null,
        ...overrides,
    }
}

test("a synchronous adapter construction failure settles and advances the queue", async () => {
    const calls = []
    const { controller } = createHarness((url) => {
        calls.push(url)
        if (url.endsWith("/first")) throw failure("invalid URL")
        return { abort: () => {}, response: Promise.resolve("second-response") }
    })
    const failures = []
    const successes = []

    controller.addInQueue(request("first", { onFail: (error) => failures.push(error) }))
    controller.addInQueue(request("second", { onSuccess: (value) => successes.push(value) }))
    await flush()
    await flush()

    assert.deepEqual(calls, ["http://controller/first", "http://controller/second"])
    assert.equal(failures[0] instanceof Error, true)
    assert.equal(failures[0] instanceof String, false)
    assert.equal(String(failures[0]), "invalid URL")
    assert.equal(failures[0].message, "invalid URL")
    assert.equal(failures[0].code, undefined)
    assert.equal(failures[0].kind, "client")
    assert.deepEqual(successes, ["second-response"])
})

test("success callback exceptions do not become transport failures", async () => {
    const consoleErrors = []
    const originalConsoleError = console.error
    console.error = (...args) => consoleErrors.push(args)
    try {
        const { controller, connectionLossCalls } = createHarness(() => ({
            abort: () => {},
            response: Promise.resolve("ok"),
        }), { maxNoAnswerCount: 0 })
        let failCalls = 0
        let nextSuccess = 0

        controller.addInQueue(request("first", {
            onSuccess: () => { throw new Error("consumer success bug") },
            onFail: () => failCalls++,
        }))
        controller.addInQueue(request("second", { onSuccess: () => nextSuccess++ }))
        await flush()
        await flush()

        assert.equal(failCalls, 0)
        assert.equal(nextSuccess, 1)
        assert.deepEqual(connectionLossCalls, [])
        assert.match(String(consoleErrors[0]?.[1]), /consumer success bug/)
    } finally {
        console.error = originalConsoleError
    }
})

test("failure callbacks can enqueue and cancel the same id without aborting the completed transport", async () => {
    const aborts = []
    let call = 0
    const { controller } = createHarness(() => {
        call++
        return {
            abort: () => aborts.push("abort"),
            response: call === 1
                ? Promise.reject(failure("server error", 500))
                : Promise.resolve("retry"),
        }
    })
    const accepted = []
    const successes = []

    controller.addInQueue(request("retry", {
        params: { max: 1 },
        onFail: () => {
            accepted.push(controller.addInQueue(request("retry", {
                params: { max: 1 },
                onSuccess: (value) => successes.push(value),
            })))
            controller.cancelRequests("retry")
        },
    }))
    await flush()
    await flush()

    assert.deepEqual(accepted, [true])
    assert.deepEqual(successes, [])
    assert.deepEqual(aborts, [])
})

test("a failure callback can remove all, enqueue once, and never duplicate the next request", async () => {
    const calls = []
    const successes = []
    let controller
    controller = new HttpQueueController({
        httpAdapter: (url) => {
            calls.push(url)
            return {
                abort: () => {},
                response: url.endsWith("/first")
                    ? Promise.reject(failure("500 - Server Error", 500, "http"))
                    : Promise.resolve("next"),
            }
        },
        processData: () => {},
        getConnectionState: () => ({ connected: true }),
        setConnectionState: () => {},
        getWebSocketService: () => undefined,
    })

    controller.addInQueue(request("first", {
        onFail: () => {
            controller.removeAllRequests()
            controller.addInQueue(request("next", {
                onSuccess: (value) => successes.push(value),
            }))
        },
    }))
    await flush()
    await flush()

    assert.deepEqual(calls, ["http://controller/first", "http://controller/next"])
    assert.deepEqual(successes, ["next"])
})

test("failure callback exceptions do not trigger connection-loss handling twice", async () => {
    const consoleErrors = []
    const originalConsoleError = console.error
    console.error = (...args) => consoleErrors.push(args)
    try {
        const { controller, connectionLossCalls } = createHarness(() => ({
            abort: () => {},
            response: Promise.reject(failure("offline")),
        }), { maxNoAnswerCount: 1 })

        controller.addInQueue(request("first", {
            onFail: () => { throw new Error("consumer failure bug") },
        }))
        await flush()
        assert.deepEqual(connectionLossCalls, [])

        controller.addInQueue(request("second", { onFail: () => {} }))
        await flush()
        assert.deepEqual(connectionLossCalls, [["connectionlost"]])
        assert.match(String(consoleErrors[0]?.[1]), /consumer failure bug/)
    } finally {
        console.error = originalConsoleError
    }
})

test("a completion callback can re-enqueue the same id with max one", async () => {
    const responses = [Promise.resolve("first"), Promise.resolve("second")]
    const aborts = []
    const { controller } = createHarness(() => ({
        abort: () => aborts.push("abort"),
        response: responses.shift(),
    }))
    const results = []
    const accepted = []

    const makeRequest = () => request("poll", {
        params: { max: 1 },
        onSuccess: (value) => {
            results.push(value)
            if (value === "first") {
                accepted.push(controller.addInQueue(makeRequest()))
                controller.cancelRequests("poll")
            }
        },
    })

    assert.equal(controller.addInQueue(makeRequest()), true)
    await flush()
    await flush()

    assert.deepEqual(accepted, [true])
    assert.deepEqual(results, ["first"])
    assert.deepEqual(aborts, [])
})

test("targeted cancellation aborts only the matching active request", async () => {
    const first = deferred()
    const aborts = []
    const successes = []
    let call = 0
    const { controller } = createHarness((_url, params) => {
        call++
        if (call === 1) {
            return {
                abort: () => {
                    aborts.push(params.id)
                    first.reject(failure("Request aborted", 499))
                },
                response: first.promise,
            }
        }
        return { abort: () => aborts.push(params.id), response: Promise.resolve("second") }
    })

    controller.addInQueue(request("first", { params: { id: "first" } }))
    controller.addInQueue(request("second", {
        params: { id: "second" },
        onSuccess: (value) => successes.push(value),
    }))
    controller.cancelRequests("second")
    assert.deepEqual(aborts, [])

    controller.addInQueue(request("third", {
        params: { id: "third" },
        onSuccess: (value) => successes.push(value),
    }))
    controller.cancelRequests("first")
    await flush()
    await flush()

    assert.deepEqual(aborts, ["first"])
    assert.deepEqual(successes, ["second"])
})

test("global removal aborts the active request and drops all queued work", async () => {
    const active = deferred()
    let abortCount = 0
    let secondStarted = false
    const { controller } = createHarness((url) => {
        if (url.endsWith("/second")) secondStarted = true
        return {
            abort: () => {
                abortCount++
                active.reject(failure("Request aborted", 499))
            },
            response: active.promise,
        }
    })

    controller.addInQueue(request("first"))
    controller.addInQueue(request("second"))
    controller.removeAllRequests()
    await flush()

    assert.equal(abortCount, 1)
    assert.equal(secondStarted, false)
})

test("cancellation advances when abort throws and ignores a never-settling response", async () => {
    const never = new Promise(() => {})
    const successes = []
    const consoleErrors = []
    const originalConsoleError = console.error
    console.error = (...args) => consoleErrors.push(args)
    try {
        let call = 0
        const { controller } = createHarness(() => {
            call++
            if (call === 1) {
                return {
                    abort: () => { throw new Error("abort failed") },
                    response: never,
                }
            }
            return {
                abort: () => {},
                response: Promise.resolve("next"),
            }
        })

        controller.addInQueue(request("first"))
        controller.addInQueue(request("second", {
            onSuccess: (value) => successes.push(value),
        }))
        controller.cancelRequests("first")
        await flush()
        await flush()

        assert.deepEqual(successes, ["next"])
        assert.match(String(consoleErrors[0]?.[1]), /abort failed/)
    } finally {
        console.error = originalConsoleError
    }
})

test("a cancelled request cannot apply a simultaneous failure side effect", async () => {
    let rejectResponse
    const response = new Promise((_resolve, reject) => { rejectResponse = reject })
    const failures = []
    const { controller, connectionLossCalls, stateUpdates } = createHarness(() => ({
        abort: () => rejectResponse(failure("401 - Unauthorized", 401, "http")),
        response,
    }), { maxNoAnswerCount: 0 })

    controller.addInQueue(request("cancelled", {
        onFail: (error) => failures.push(error),
    }))
    controller.cancelRequests("cancelled")
    await flush()
    await flush()

    assert.deepEqual(failures, [])
    assert.deepEqual(stateUpdates, [])
    assert.deepEqual(connectionLossCalls, [])
})

test("removeAll settles a never-settling cancellation and accepts later work", async () => {
    const never = new Promise(() => {})
    const successes = []
    let call = 0
    const { controller } = createHarness(() => {
        call++
        return {
            abort: () => {},
            response: call === 1 ? never : Promise.resolve("later"),
        }
    })

    controller.addInQueue(request("first"))
    controller.addInQueue(request("dropped"))
    controller.removeAllRequests()
    await flush()
    controller.addInQueue(request("later", {
        onSuccess: (value) => successes.push(value),
    }))
    await flush()
    await flush()

    assert.deepEqual(successes, ["later"])
    assert.equal(call, 2)
})

test("echo reentrant cancellation prevents transport creation and concurrent work", async () => {
    const calls = []
    const successes = []
    let controller
    let echoHandled = false
    controller = new HttpQueueController({
        httpAdapter: (url) => {
            calls.push(url)
            return { abort: () => {}, response: Promise.resolve(url) }
        },
        processData: () => {
            if (echoHandled) return
            echoHandled = true
            controller.removeAllRequests()
            controller.addInQueue(request("accepted-after-cancel", {
                onSuccess: (value) => successes.push(value),
            }))
        },
        getConnectionState: () => ({ connected: true }),
        setConnectionState: () => {},
        getWebSocketService: () => undefined,
    })

    controller.addInQueue(request("echo-cancelled", { params: { echo: "G0 X1" } }))
    await flush()
    await flush()

    assert.deepEqual(calls, ["http://controller/accepted-after-cancel"])
    assert.deepEqual(successes, ["http://controller/accepted-after-cancel"])
})

test("progress callbacks are isolated and ignored after cancellation", async () => {
    const active = deferred()
    const consoleErrors = []
    const progressCalls = []
    let reportProgress
    const originalConsoleError = console.error
    console.error = (...args) => consoleErrors.push(args)
    try {
        const { controller } = createHarness((_url, _params, onProgress) => {
            reportProgress = onProgress
            return { abort: () => {}, response: active.promise }
        })

        controller.addInQueue(request("progress", {
            onProgress: (percent) => {
                progressCalls.push(percent)
                throw new Error("progress callback failed")
            },
        }))
        reportProgress(10)
        controller.cancelRequests("progress")
        reportProgress(20)
        await flush()

        assert.deepEqual(progressCalls, [10])
        assert.match(String(consoleErrors[0]?.[1]), /progress callback failed/)
    } finally {
        console.error = originalConsoleError
    }
})

test("HTTP failures are normal Errors with primitive string, code, and kind compatibility", async () => {
    const { controller, stateUpdates } = createHarness(() => ({
        abort: () => {},
        response: Promise.reject(failure("401 - Unauthorized", 401)),
    }))
    let received

    controller.addInQueue(request("auth", { onFail: (error) => { received = error } }))
    await flush()

    assert.equal(received instanceof Error, true)
    assert.equal(received instanceof String, false)
    assert.equal(String(received), "401 - Unauthorized")
    assert.equal(received.code, 401)
    assert.equal(received.kind, "http")
    assert.equal(received.message, "401 - Unauthorized")
    assert.equal(received == "401 - Unauthorized", true)
    assert.deepEqual(stateUpdates, [{ connected: true, page: "notauthenticated" }])
})

test("client setup errors and answered HTTP errors do not accumulate a loss streak", async () => {
    const outcomes = [
        () => { throw failure("invalid URL") },
        () => ({ abort: () => {}, response: Promise.reject(failure("offline")) }),
        () => ({ abort: () => {}, response: Promise.reject(failure("500 - Server Error", 500, "http")) }),
        () => ({ abort: () => {}, response: Promise.reject(failure("offline again")) }),
    ]
    const { controller, connectionLossCalls } = createHarness(() => outcomes.shift()(), {
        maxNoAnswerCount: 1,
    })

    for (const id of ["setup", "offline-one", "answered-error", "offline-two"]) {
        controller.addInQueue(request(id, { onFail: () => {} }))
        await flush()
    }

    assert.deepEqual(connectionLossCalls, [])
})

test("threshold notification retries until a WebSocket service accepts it", async () => {
    let serviceAvailable = false
    let throwOnce = true
    const calls = []
    const controller = new HttpQueueController({
        httpAdapter: () => ({
            abort: () => {},
            response: Promise.reject(failure("offline")),
        }),
        processData: () => {},
        getConnectionState: () => ({ connected: false }),
        setConnectionState: () => {},
        getWebSocketService: () => serviceAvailable
            ? {
                handleConnectionLoss: (reason) => {
                    if (throwOnce) {
                        throwOnce = false
                        throw new Error("not ready")
                    }
                    calls.push(reason)
                },
            }
            : undefined,
        maxNoAnswerCount: 0,
    })
    const originalConsoleError = console.error
    console.error = () => {}
    try {
        controller.addInQueue(request("absent", { onFail: () => {} }))
        await flush()
        serviceAvailable = true
        controller.addInQueue(request("throws", { onFail: () => {} }))
        await flush()
        controller.addInQueue(request("accepted", { onFail: () => {} }))
        await flush()
        controller.addInQueue(request("already-signalled", { onFail: () => {} }))
        await flush()
    } finally {
        console.error = originalConsoleError
    }

    assert.deepEqual(calls, ["connectionlost"])
})

test("any HTTP response breaks an existing no-answer streak", async () => {
    const outcomes = [
        () => Promise.reject(failure("offline")),
        () => Promise.resolve("answered"),
        () => Promise.reject(failure("offline again")),
    ]
    const { controller, connectionLossCalls } = createHarness(() => ({
        abort: () => {},
        response: outcomes.shift()(),
    }), { maxNoAnswerCount: 1 })

    for (const id of ["offline-one", "answered", "offline-two"]) {
        controller.addInQueue(request(id, { onFail: () => {} }))
        await flush()
    }

    assert.deepEqual(connectionLossCalls, [])
})

test("a settled response resets the streak even when same-turn cancellation suppresses its callback", async () => {
    let call = 0
    let controller
    const connectionLossCalls = []
    controller = new HttpQueueController({
        httpAdapter: () => {
            call++
            if (call === 1 || call === 3) {
                return { abort: () => {}, response: Promise.reject(failure("offline")) }
            }
            const response = Promise.resolve("answered")
            response.then(() => controller.cancelRequests("answered"))
            return { abort: () => {}, response }
        },
        processData: () => {},
        getConnectionState: () => ({ connected: true }),
        setConnectionState: () => {},
        getWebSocketService: () => ({
            handleConnectionLoss: (...args) => connectionLossCalls.push(args),
        }),
        maxNoAnswerCount: 1,
    })

    for (const id of ["offline-one", "answered", "offline-two"]) {
        controller.addInQueue(request(id, { onFail: () => {} }))
        await flush()
    }

    assert.deepEqual(connectionLossCalls, [])
})

test("detected connection loss preserves WebSocket automatic reconnect and signals once per streak", async () => {
    const { controller, connectionLossCalls } = createHarness(() => ({
        abort: () => {},
        response: Promise.reject(failure("offline")),
    }), { maxNoAnswerCount: 0 })

    controller.addInQueue(request("offline-one", { onFail: () => {} }))
    await flush()
    controller.addInQueue(request("offline-two", { onFail: () => {} }))
    await flush()

    assert.deepEqual(connectionLossCalls, [["connectionlost"]])
})

test("a synchronous WebSocket loss notification failure cannot wedge the HTTP queue", async () => {
    const successes = []
    let call = 0
    const controller = new HttpQueueController({
        httpAdapter: () => {
            call++
            return {
                abort: () => {},
                response: call === 1
                    ? Promise.reject(failure("offline"))
                    : Promise.resolve("recovered"),
            }
        },
        processData: () => {},
        getConnectionState: () => ({ connected: true }),
        setConnectionState: () => {},
        getWebSocketService: () => ({
            handleConnectionLoss: () => { throw new Error("notification failed") },
        }),
        maxNoAnswerCount: 0,
    })
    const originalConsoleError = console.error
    console.error = () => {}
    try {
        controller.addInQueue(request("offline", { onFail: () => {} }))
        controller.addInQueue(request("recovered", {
            onSuccess: (value) => successes.push(value),
        }))
        await flush()
        await flush()
    } finally {
        console.error = originalConsoleError
    }

    assert.deepEqual(successes, ["recovered"])
})
