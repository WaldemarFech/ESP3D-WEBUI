type ExtensionMessageType =
    | "response"
    | "cmd"
    | "query"
    | "upload"
    | "download"
    | "toast"
    | "modal"
    | "sound"
    | "translate"
    | "icon"
    | "extensionsData"
    | "capabilities"
    | "dispatch"

interface ExtensionMessageData {
    target: "webui"
    type: ExtensionMessageType
    [key: string]: any
}

interface ExtensionFrameLike {
    contentWindow: unknown
    src?: string | null
    srcdoc?: string
    hasAttribute?: (name: string) => boolean
    getAttribute?: (name: string) => string | null
}

interface ExtensionDocumentLike {
    querySelectorAll: (selector: string) => Iterable<ExtensionFrameLike> | ArrayLike<ExtensionFrameLike>
}

interface ExtensionMessageEventLike {
    source: unknown
    origin?: string
    data: unknown
}

interface MessageEventTargetLike {
    addEventListener: (type: "message", listener: (event: ExtensionMessageEventLike) => void) => void
    removeEventListener: (type: "message", listener: (event: ExtensionMessageEventLike) => void) => void
}

const extensionMessageTypes: ReadonlySet<string> = new Set([
    "response",
    "cmd",
    "query",
    "upload",
    "download",
    "toast",
    "modal",
    "sound",
    "translate",
    "icon",
    "extensionsData",
    "capabilities",
    "dispatch",
])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const hasString = (data: Record<string, unknown>, key: string): boolean =>
    typeof data[key] === "string"

const hasOptionalString = (data: Record<string, unknown>, key: string): boolean =>
    data[key] === undefined || typeof data[key] === "string"

const hasOptionalBoolean = (data: Record<string, unknown>, key: string): boolean =>
    data[key] === undefined || typeof data[key] === "boolean"

const hasOptionalPlainObject = (data: Record<string, unknown>, key: string): boolean =>
    data[key] === undefined || isPlainObject(data[key])

const hasOptionalId = (data: Record<string, unknown>): boolean =>
    data.id === undefined || typeof data.id === "string" || typeof data.id === "number"

const isValidSoundSequence = (value: unknown): boolean =>
    Array.isArray(value) && value.every(note =>
        isPlainObject(note) &&
        typeof note.f === "number" &&
        Number.isFinite(note.f) &&
        typeof note.d === "number" &&
        Number.isFinite(note.d)
    )

const isValidContentForType = (
    type: ExtensionMessageType,
    data: Record<string, unknown>
): boolean => {
    switch (type) {
        case "response":
            return true
        case "cmd":
            return hasString(data, "content")
        case "query":
            return (
                hasString(data, "url") &&
                hasOptionalPlainObject(data, "args") &&
                (data.url !== "command" ||
                    (isPlainObject(data.args) && hasString(data.args, "cmd")))
            )
        case "upload":
            return (
                hasString(data, "url") &&
                hasString(data, "path") &&
                hasString(data, "filename") &&
                typeof data.size === "number" &&
                Number.isFinite(data.size) &&
                data.size >= 0 &&
                (typeof data.content === "string" ||
                    data.content instanceof ArrayBuffer ||
                    ArrayBuffer.isView(data.content) ||
                    (typeof Blob !== "undefined" && data.content instanceof Blob)) &&
                hasOptionalPlainObject(data, "args")
            )
        case "download":
            return hasString(data, "url") && hasOptionalPlainObject(data, "args")
        case "toast":
            return (
                isPlainObject(data.content) &&
                hasString(data.content, "text") &&
                hasString(data.content, "type")
            )
        case "modal":
            return (
                isPlainObject(data.content) &&
                hasString(data.content, "id") &&
                hasString(data.content, "style") &&
                hasString(data.content, "title")
            )
        case "sound":
            return (
                data.content === "beep" ||
                data.content === "error" ||
                (data.content === "seq" && isValidSoundSequence(data.seq))
            )
        case "translate":
            return (
                (data.all === undefined || typeof data.all === "boolean" || typeof data.all === "string") &&
                (data.all !== undefined || hasString(data, "content"))
            )
        case "icon":
            return hasString(data, "id")
        case "extensionsData":
            return hasString(data, "id") && data.content !== undefined
        case "capabilities":
            return hasString(data, "id") && hasOptionalString(data, "name")
        case "dispatch":
            return hasString(data, "targetid") && data.content !== undefined
    }
}

const parseExtensionMessage = (data: unknown): ExtensionMessageData | null => {
    if (!isPlainObject(data) || data.target !== "webui") return null
    if (typeof data.type !== "string" || !extensionMessageTypes.has(data.type)) return null
    if (!hasOptionalId(data) || !hasOptionalBoolean(data, "noDispatch")) return null

    const type = data.type as ExtensionMessageType
    return isValidContentForType(type, data)
        ? (data as ExtensionMessageData)
        : null
}

const getFrameSource = (frame: ExtensionFrameLike): string | null => {
    if (typeof frame.src === "string" && frame.src) return frame.src
    return frame.getAttribute?.("src") ?? null
}

const isSandboxedFrame = (frame: ExtensionFrameLike): boolean =>
    frame.hasAttribute?.("sandbox") === true

const getEnforceableFrameOrigin = (
    frame: ExtensionFrameLike,
    pageHref?: string
): string | null => {
    const source = getFrameSource(frame)

    try {
        const pageOrigin = pageHref ? new URL(pageHref).origin : null
        if (frame.srcdoc || !source || source.startsWith("about:")) {
            const canInheritPageOrigin =
                pageOrigin !== null &&
                pageOrigin !== "null" &&
                (pageOrigin.startsWith("http://") || pageOrigin.startsWith("https://"))
            return !isSandboxedFrame(frame) && canInheritPageOrigin ? pageOrigin : null
        }

        if (source.startsWith("blob:")) {
            const blobOrigin = new URL(source).origin
            return (
                blobOrigin.startsWith("http://") || blobOrigin.startsWith("https://")
            ) ? blobOrigin : null
        }

        const url = pageHref ? new URL(source, pageHref) : new URL(source)
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== "null"
            ? url.origin
            : null
    } catch {
        return null
    }
}

const isAuthorizedExtensionMessage = (
    event: ExtensionMessageEventLike,
    documentLike: ExtensionDocumentLike,
    pageHref?: string
): event is ExtensionMessageEventLike & { data: ExtensionMessageData } => {
    const data = parseExtensionMessage(event.data)
    if (!data || !event.source) return false

    let frames: ExtensionFrameLike[]
    try {
        frames = Array.from(documentLike.querySelectorAll("iframe.extensionContainer"))
    } catch {
        return false
    }
    const frame = frames.find(candidate => candidate.contentWindow === event.source)
    if (!frame) return false

    const expectedOrigin = getEnforceableFrameOrigin(frame, pageHref)
    return expectedOrigin !== null && event.origin === expectedOrigin
}

const createExtensionMessageListener = (
    documentLike: ExtensionDocumentLike,
    getHandler: () => (event: ExtensionMessageEventLike & { data: ExtensionMessageData }) => void,
    pageHref?: string
): ((event: ExtensionMessageEventLike) => void) =>
    (event) => {
        if (isAuthorizedExtensionMessage(event, documentLike, pageHref)) {
            getHandler()(event)
        }
    }

const registerExtensionMessageListener = (
    target: MessageEventTargetLike,
    listener: (event: ExtensionMessageEventLike) => void
): (() => void) => {
    target.addEventListener("message", listener)
    return () => target.removeEventListener("message", listener)
}

export {
    createExtensionMessageListener,
    getEnforceableFrameOrigin,
    isAuthorizedExtensionMessage,
    isPlainObject,
    parseExtensionMessage,
    registerExtensionMessageListener,
}

export type {
    ExtensionDocumentLike,
    ExtensionFrameLike,
    ExtensionMessageData,
    ExtensionMessageEventLike,
    ExtensionMessageType,
    MessageEventTargetLike,
}
