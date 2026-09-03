export type HttpFailureKind = "http" | "network" | "cancelled" | "client"

export interface HttpFailureDetails {
    code?: number
    kind?: HttpFailureKind
    message?: string
}

/**
 * Normal HTTP failure value shared by the adapter, queue, and request callers.
 *
 * It is an Error (rather than a boxed String), while toString() intentionally
 * returns only the message so legacy String(error), template interpolation,
 * and loose comparisons with a message string keep their existing behavior.
 */
export class HttpFailure extends Error {
    readonly code?: number
    readonly kind: HttpFailureKind

    constructor(message: string, options: { code?: number; kind: HttpFailureKind }) {
        super(message)
        this.name = "HttpFailure"
        this.code = options.code
        this.kind = options.kind
        Object.setPrototypeOf(this, new.target.prototype)
    }

    override toString(): string {
        return this.message
    }
}

export const getHttpFailureMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message
    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message?: unknown }).message === "string"
    ) {
        return (error as { message: string }).message
    }
    return String(error ?? "")
}

export const toHttpFailure = (
    error: unknown,
    fallbackKind: HttpFailureKind = "client"
): HttpFailure => {
    if (error instanceof HttpFailure) return error

    const candidate = error as HttpFailureDetails | null | undefined
    const code = typeof candidate?.code === "number" ? candidate.code : undefined
    const kind = candidate?.kind ?? (
        code === 499
            ? "cancelled"
            : fallbackKind === "network" && code !== undefined
                ? "http"
                : fallbackKind
    )
    return new HttpFailure(getHttpFailureMessage(error), { code, kind })
}
