/*
 HttpQueueController.ts - ESP3D WebUI HTTP queue lifecycle

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved.
 Modified by Luc LEBOSSE 2021

 This code is free software; you can redistribute it and/or
 modify it under the terms of the GNU Lesser General Public
 License as published by the Free Software Foundation; either
 version 2.1 of the License, or (at your option) any later version.
*/

import { toHttpFailure } from "../types/http.types"
import type { HttpFailure, HttpFailureKind } from "../types/http.types"

interface HttpRequest {
    id: string
    url: string
    params: any
    onSuccess: (response: any) => void
    onFail?: ((error: HttpFailure) => void) | null
    onProgress?: (percent: number) => void
}

interface HttpTransport {
    abort: () => void
    response: Promise<any>
}

type HttpAdapter = (
    url: string,
    params: any,
    onProgress: (percent: number) => void
) => HttpTransport

interface WebSocketConnectionLossService {
    handleConnectionLoss: (reason?: string) => void
}

interface HttpQueueControllerDependencies {
    httpAdapter: HttpAdapter
    processData: (type: string, data: string) => void
    getConnectionState: () => { connected: boolean }
    setConnectionState: (state: { connected: boolean; page: string }) => void
    getWebSocketService: () => WebSocketConnectionLossService | undefined
    maxNoAnswerCount?: number
}

interface ActiveHttpRequest {
    request: HttpRequest
    transport: HttpTransport | null
    cancelled: boolean
    abortAttempted: boolean
    settled: boolean
    resolveCancellation: () => void
    cancellation: Promise<void>
}

const defaultMaxNoAnswerCount = 4

class HttpQueueController {
    private requestQueue: HttpRequest[] = []
    private isBusy = false
    private currentRequest: ActiveHttpRequest | null = null
    private noAnswerCount = 0
    private connectionLossSignalled = false
    private readonly maxNoAnswerCount: number

    constructor(private readonly dependencies: HttpQueueControllerDependencies) {
        this.maxNoAnswerCount = dependencies.maxNoAnswerCount ?? defaultMaxNoAnswerCount
    }

    addInQueue(newRequest: HttpRequest): boolean {
        if (newRequest.params.max != undefined) {
            const sameIdCount = this.requestQueue.reduce(
                (total, request) => total + (request.id == newRequest.id ? 1 : 0),
                0
            )
            if (sameIdCount >= newRequest.params.max) return false
        }

        this.requestQueue = [...this.requestQueue, newRequest]
        this.processRequests()
        return true
    }

    addInTopQueue(newRequest: HttpRequest): void {
        this.requestQueue = [newRequest, ...this.requestQueue]
        this.processRequests()
    }

    cancelRequests(requestIds: string | string[]): void {
        const ids = new Set(Array.isArray(requestIds) ? requestIds : [requestIds])
        this.requestQueue = this.requestQueue.filter((request) => !ids.has(request.id))

        const active = this.currentRequest
        if (active && ids.has(active.request.id)) this.cancelActiveRequest(active)
    }

    removeAllRequests(): void {
        this.requestQueue = []
        const active = this.currentRequest
        if (active) this.cancelActiveRequest(active)
        else this.isBusy = false
    }

    processRequests(): void {
        if (!this.isBusy && this.requestQueue.length > 0) void this.executeHttpCall()
    }

    private removeRequest(request: HttpRequest): boolean {
        const queued = this.requestQueue.includes(request)
        if (queued) this.requestQueue = this.requestQueue.filter((entry) => entry !== request)
        return queued
    }

    private createActiveRequest(request: HttpRequest): ActiveHttpRequest {
        let resolveCancellation = () => {}
        const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve })
        return {
            request,
            transport: null,
            cancelled: false,
            abortAttempted: false,
            settled: false,
            resolveCancellation,
            cancellation,
        }
    }

    private cancelActiveRequest(active: ActiveHttpRequest): void {
        if (active.settled) return
        if (!active.cancelled) {
            active.cancelled = true
            active.resolveCancellation()
        }
        if (!active.transport || active.abortAttempted) return
        active.abortAttempted = true
        try {
            active.transport.abort()
        } catch (error) {
            console.error("Failed to abort HTTP request:", error)
        }
    }

    private finishRequest(active: ActiveHttpRequest): void {
        active.settled = true
        if (this.currentRequest !== active) return
        this.currentRequest = null
        this.isBusy = false
        this.processRequests()
    }

    private handleTransportFailure(error: unknown): HttpFailure {
        const failure = toHttpFailure(error, "network")
        if (failure.kind === "http") {
            // Any answered HTTP request proves the peer replied, including error
            // statuses such as 401 and 500, so it breaks a no-answer streak.
            this.resetNoAnswerStreak()
            if (failure.code == 401) {
                this.invokeCallback(() => this.dependencies.setConnectionState({
                    connected: this.dependencies.getConnectionState().connected,
                    page: "notauthenticated",
                }))
            }
        } else if (failure.kind === "network") {
            this.noAnswerCount++
            console.log("Connection lost ?", this.noAnswerCount)
            if (this.noAnswerCount > this.maxNoAnswerCount && !this.connectionLossSignalled) {
                try {
                    const service = this.dependencies.getWebSocketService()
                    if (service) {
                        service.handleConnectionLoss("connectionlost")
                        this.connectionLossSignalled = true
                    }
                } catch (connectionLossError) {
                    // Keep delivery unlatched so a later failure in the same streak
                    // can retry once the singleton/service becomes usable.
                    console.error("Failed to notify WebSocket connection loss:", connectionLossError)
                }
            }
        }
        return failure
    }

    private resetNoAnswerStreak(): void {
        this.noAnswerCount = 0
        this.connectionLossSignalled = false
    }

    private invokeCallback(callback: () => void): void {
        try {
            callback()
        } catch (error) {
            // Consumer exceptions are programming errors, not transport failures.
            // Surface them without incrementing connection-loss counters or invoking
            // the opposite request callback.
            console.error("HTTP queue callback failed:", error)
        }
    }

    private async executeHttpCall(): Promise<void> {
        const request = this.requestQueue[0]
        if (!request) {
            this.isBusy = false
            return
        }

        this.isBusy = true
        const active = this.createActiveRequest(request)
        this.currentRequest = active
        const { url, params, onSuccess, onFail, onProgress } = request

        try {
            if (params.echo) {
                this.invokeCallback(() => this.dependencies.processData("echo", params.echo))
            }
            if (active.cancelled) return

            let transport: HttpTransport
            try {
                transport = this.dependencies.httpAdapter(
                    url,
                    params,
                    (percent: number) => {
                        if (this.currentRequest !== active || active.cancelled || active.settled || !onProgress) return
                        this.invokeCallback(() => onProgress(percent))
                    }
                )
            } catch (error) {
                const failure = toHttpFailure(error, "client")
                const completed = this.removeRequest(request)
                active.settled = true
                if (completed && onFail) {
                    this.invokeCallback(() => onFail(failure))
                }
                return
            }

            active.transport = transport
            if (active.cancelled) {
                this.cancelActiveRequest(active)
                return
            }

            const outcome = await Promise.race([
                Promise.resolve(transport.response).then(
                    (response) => ({ type: "response" as const, response }),
                    (error) => ({ type: "failure" as const, error })
                ),
                active.cancellation.then(() => ({ type: "cancelled" as const })),
            ])
            if (outcome.type === "cancelled") return

            // Record an answered transport before suppressing a callback cancelled
            // in the same turn. A real response still breaks the no-answer streak.
            if (outcome.type === "response") {
                this.resetNoAnswerStreak()
                const completed = this.removeRequest(request)
                active.settled = true
                if (!active.cancelled && completed) {
                    this.invokeCallback(() => onSuccess(outcome.response))
                }
                return
            }
            if (active.cancelled) return

            const failure = this.handleTransportFailure(outcome.error)
            const completed = this.removeRequest(request)
            active.settled = true
            if (completed && failure.kind !== "cancelled" && onFail) {
                this.invokeCallback(() => onFail(failure))
            }
        } finally {
            // The controller, rather than abort(), owns cancellation settlement.
            // It therefore advances even if abort throws or the transport promise
            // never rejects, and late transport results are ignored by the race.
            this.removeRequest(request)
            this.finishRequest(active)
        }
    }
}

export { HttpQueueController }
export type {
    HttpAdapter,
    HttpFailure,
    HttpFailureKind,
    HttpQueueControllerDependencies,
    HttpRequest,
    HttpTransport,
    WebSocketConnectionLossService,
}
