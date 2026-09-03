/*
 * Strict, dependency-free sanitizer for device/imported custom SVG logos.
 * It parses a deliberately small XML/SVG subset and serializes only inert
 * shape elements and attributes. No input markup is copied verbatim.
 */

interface LogoPresentation {
    height: string
    color: string
    bgcolor: string
}

interface ParsedAttribute {
    name: string
    value: string
}

interface ParsedStartTag {
    name: string
    attributes: ParsedAttribute[]
    selfClosing: boolean
    end: number
}

interface StackEntry {
    name: string
    emitted: boolean
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const MAX_SOURCE_LENGTH = 256 * 1024
const MAX_ELEMENTS = 4096
const MAX_DEPTH = 64
const MAX_ATTRIBUTES = 128
const MAX_ATTRIBUTE_LENGTH = 32 * 1024

const HARD_DEFAULT_PRESENTATION: LogoPresentation = {
    height: "50px",
    color: "currentColor",
    bgcolor: "white",
}

const NUMBER_SOURCE = "[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?"
const LENGTH_UNIT_SOURCE = "(?:px|em|rem|ex|ch|%|vh|vw|vmin|vmax|pt|pc|cm|mm|in)?"
const NUMBER_RE = new RegExp(`^${NUMBER_SOURCE}$`)
const LENGTH_RE = new RegExp(`^(${NUMBER_SOURCE})${LENGTH_UNIT_SOURCE}$`)
const NUMBER_LIST_RE = new RegExp(`^${NUMBER_SOURCE}(?:[\\s,]+${NUMBER_SOURCE})*$`)
const LENGTH_LIST_RE = new RegExp(
    `^${NUMBER_SOURCE}${LENGTH_UNIT_SOURCE}(?:[\\s,]+${NUMBER_SOURCE}${LENGTH_UNIT_SOURCE})*$`
)
const TRANSFORM_RE = new RegExp(
    `^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\\(\\s*${NUMBER_SOURCE}(?:[\\s,]+${NUMBER_SOURCE}){0,5}\\s*\\)\\s*)+$`
)
const PATH_DATA_RE = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\s-]+$/
const COLOR_FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9+.,%/\s-]+\s*\)$/i
const PRESERVE_ASPECT_RATIO_RE = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/
const XML_DECLARATION_RE = /^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"UTF-8"|'UTF-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/i

const COMMON_ATTRIBUTES = [
    "color",
    "fill",
    "fill-opacity",
    "fill-rule",
    "opacity",
    "paint-order",
    "shape-rendering",
    "stroke",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-opacity",
    "stroke-width",
    "transform",
    "vector-effect",
] as const

const attributesFor = (...specific: string[]): ReadonlySet<string> =>
    new Set([...COMMON_ATTRIBUTES, ...specific])

const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
    g: attributesFor(),
    path: attributesFor("d", "pathLength"),
    rect: attributesFor("height", "pathLength", "rx", "ry", "width", "x", "y"),
    circle: attributesFor("cx", "cy", "pathLength", "r"),
    ellipse: attributesFor("cx", "cy", "pathLength", "rx", "ry"),
    line: attributesFor("pathLength", "x1", "x2", "y1", "y2"),
    polyline: attributesFor("pathLength", "points"),
    polygon: attributesFor("pathLength", "points"),
    svg: attributesFor("height", "preserveAspectRatio", "viewBox", "width", "x", "y"),
}

const isXmlWhitespace = (character: string): boolean =>
    character === " " || character === "\t" || character === "\n" || character === "\r"

const isNameStart = (character: string): boolean => /[A-Za-z_]/.test(character)
const isNameCharacter = (character: string): boolean => /[A-Za-z0-9_.:-]/.test(character)

const skipWhitespace = (source: string, start: number): number => {
    let index = start
    while (index < source.length && isXmlWhitespace(source[index])) index++
    return index
}

const isValidXmlCharacter = (codePoint: number): boolean =>
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)

const hasOnlyValidXmlCharacters = (source: string): boolean => {
    for (let index = 0; index < source.length; index++) {
        const codePoint = source.codePointAt(index)
        if (codePoint === undefined || !isValidXmlCharacter(codePoint)) return false
        if (codePoint > 0xffff) index++
    }
    return true
}

const decodeXmlEntities = (source: string): string | null => {
    let result = ""
    let index = 0

    while (index < source.length) {
        const ampersand = source.indexOf("&", index)
        if (ampersand === -1) return result + source.slice(index)

        result += source.slice(index, ampersand)
        const semicolon = source.indexOf(";", ampersand + 1)
        if (semicolon === -1 || semicolon - ampersand > 16) return null

        const entity = source.slice(ampersand + 1, semicolon)
        let decoded: string | null = null
        if (entity === "amp") decoded = "&"
        else if (entity === "lt") decoded = "<"
        else if (entity === "gt") decoded = ">"
        else if (entity === "quot") decoded = '"'
        else if (entity === "apos") decoded = "'"
        else if (/^#[0-9]+$/.test(entity)) {
            const codePoint = Number(entity.slice(1))
            if (Number.isSafeInteger(codePoint) && isValidXmlCharacter(codePoint)) {
                decoded = String.fromCodePoint(codePoint)
            }
        } else if (/^#x[0-9A-Fa-f]+$/.test(entity)) {
            const codePoint = Number.parseInt(entity.slice(2), 16)
            if (Number.isSafeInteger(codePoint) && isValidXmlCharacter(codePoint)) {
                decoded = String.fromCodePoint(codePoint)
            }
        }

        if (decoded === null) return null
        result += decoded
        index = semicolon + 1
    }

    return result
}

const escapeAttribute = (value: string): string =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")

const safePaint = (value: unknown): string | null => {
    if (typeof value !== "string") return null
    const normalized = value.trim()
    if (normalized.length === 0 || normalized.length > 128) return null
    if (/^#[0-9A-Fa-f]{3,4}(?:[0-9A-Fa-f]{2}){0,2}$/.test(normalized)) return normalized
    if (/^[A-Za-z]+$/.test(normalized)) return normalized
    if (COLOR_FUNCTION_RE.test(normalized)) return normalized
    return null
}

const safeLength = (value: unknown, allowNegative = false): string | null => {
    if (typeof value !== "string") return null
    const normalized = value.trim()
    if (normalized.length === 0 || normalized.length > 64) return null
    const match = LENGTH_RE.exec(normalized)
    if (!match) return null
    const numericValue = Number(match[1])
    if (!Number.isFinite(numericValue) || (!allowNegative && numericValue < 0)) return null
    return normalized
}

const safeFallback = (
    value: unknown,
    fallback: unknown,
    hardFallback: string,
    validator: (candidate: unknown) => string | null
): string => {
    const v = validator(value)
    if (v !== null) return v
    const f = validator(fallback)
    if (f !== null) return f
    const h = validator(hardFallback)
    if (h !== null) return h
    return hardFallback
}

const sanitizeLogoPresentation = (
    values: Partial<LogoPresentation>,
    fallback: LogoPresentation = HARD_DEFAULT_PRESENTATION
): LogoPresentation => {
    const vHeight = typeof values.height === "string" ? values.height.trim() : undefined
    const vColor = typeof values.color === "string" ? values.color.trim() : undefined
    const vBg = typeof values.bgcolor === "string" ? values.bgcolor.trim() : undefined
    const fHeight = (typeof fallback.height === "string" ? fallback.height.trim() : undefined) || HARD_DEFAULT_PRESENTATION.height
    const fColor = (typeof fallback.color === "string" ? fallback.color.trim() : undefined) || HARD_DEFAULT_PRESENTATION.color
    const fBg = (typeof fallback.bgcolor === "string" ? fallback.bgcolor.trim() : undefined) || HARD_DEFAULT_PRESENTATION.bgcolor
    return {
        height: safeLength(vHeight) !== null ? vHeight! : safeLength(fHeight) !== null ? fHeight : HARD_DEFAULT_PRESENTATION.height,
        color: safePaint(vColor) !== null ? vColor! : safePaint(fColor) !== null ? fColor : HARD_DEFAULT_PRESENTATION.color,
        bgcolor: safePaint(vBg) !== null ? vBg! : safePaint(fBg) !== null ? fBg : HARD_DEFAULT_PRESENTATION.bgcolor,
    }
}

const parseStartTag = (source: string, start: number): ParsedStartTag | null => {
    let index = start + 1
    if (!isNameStart(source[index] ?? "")) return null

    const nameStart = index
    index++
    while (index < source.length && isNameCharacter(source[index])) index++
    const name = source.slice(nameStart, index)
    const attributes: ParsedAttribute[] = []
    const seenAttributes = new Set<string>()

    while (index < source.length) {
        const beforeWhitespace = index
        index = skipWhitespace(source, index)
        const hadWhitespace = index > beforeWhitespace

        if (source[index] === ">") {
            return { name, attributes, selfClosing: false, end: index + 1 }
        }
        if (source[index] === "/" && source[index + 1] === ">") {
            return { name, attributes, selfClosing: true, end: index + 2 }
        }
        if (!hadWhitespace || attributes.length >= MAX_ATTRIBUTES) return null
        if (!isNameStart(source[index] ?? "")) return null

        const attributeStart = index
        index++
        while (index < source.length && isNameCharacter(source[index])) index++
        const attributeName = source.slice(attributeStart, index)
        const normalizedName = attributeName.toLowerCase()
        if (seenAttributes.has(normalizedName)) return null
        seenAttributes.add(normalizedName)

        index = skipWhitespace(source, index)
        if (source[index] !== "=") return null
        index = skipWhitespace(source, index + 1)
        const quote = source[index]
        if (quote !== '"' && quote !== "'") return null
        index++

        const valueStart = index
        while (index < source.length && source[index] !== quote) {
            if (source[index] === "<") return null
            index++
        }
        if (index >= source.length || index - valueStart > MAX_ATTRIBUTE_LENGTH) return null

        const decodedValue = decodeXmlEntities(source.slice(valueStart, index))
        if (decodedValue === null) return null
        attributes.push({ name: attributeName, value: decodedValue })
        index++
    }

    return null
}

const parseClosingTag = (
    source: string,
    start: number
): { name: string; end: number } | null => {
    let index = start + 2
    if (!isNameStart(source[index] ?? "")) return null

    const nameStart = index
    index++
    while (index < source.length && isNameCharacter(source[index])) index++
    const name = source.slice(nameStart, index)
    index = skipWhitespace(source, index)
    if (source[index] !== ">") return null
    return { name, end: index + 1 }
}

const numericValue = (value: string, minimum = -Infinity): boolean => {
    if (!NUMBER_RE.test(value)) return false
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= minimum
}

const numberList = (value: string): number[] | null => {
    const normalized = value.trim()
    if (!NUMBER_LIST_RE.test(normalized)) return null
    const matches = normalized.match(new RegExp(NUMBER_SOURCE, "g"))
    if (!matches) return null
    const values = matches.map(Number)
    return values.every(Number.isFinite) ? values : null
}

const safeOpacity = (value: string): boolean => {
    const normalized = value.trim()
    if (normalized.endsWith("%")) {
        const percentage = normalized.slice(0, -1)
        return numericValue(percentage, 0) && Number(percentage) <= 100
    }
    return numericValue(normalized, 0) && Number(normalized) <= 1
}

const safeAttributeValue = (name: string, value: string): boolean => {
    if (value.length > MAX_ATTRIBUTE_LENGTH) return false

    switch (name) {
        case "color":
        case "fill":
        case "stroke":
            return safePaint(value) !== null
        case "fill-opacity":
        case "opacity":
        case "stroke-opacity":
            return safeOpacity(value)
        case "fill-rule":
            return value === "nonzero" || value === "evenodd"
        case "paint-order":
            return /^(?:normal|(?:fill|stroke|markers)(?:\s+(?:fill|stroke|markers)){0,2})$/.test(value)
        case "shape-rendering":
            return /^(?:auto|optimizeSpeed|crispEdges|geometricPrecision)$/.test(value)
        case "stroke-dasharray":
            return value === "none" || LENGTH_LIST_RE.test(value.trim())
        case "stroke-dashoffset":
            return safeLength(value, true) !== null
        case "stroke-linecap":
            return /^(?:butt|round|square)$/.test(value)
        case "stroke-linejoin":
            return /^(?:arcs|bevel|miter|miter-clip|round)$/.test(value)
        case "stroke-miterlimit":
            return numericValue(value.trim(), 1)
        case "stroke-width":
            return safeLength(value) !== null
        case "transform":
            return value.length <= 4096 && TRANSFORM_RE.test(value.trim())
        case "vector-effect":
            return /^(?:none|non-scaling-stroke|non-scaling-size|non-rotation|fixed-position)$/.test(value)
        case "d":
            return value.length <= MAX_ATTRIBUTE_LENGTH && PATH_DATA_RE.test(value) && /[Mm]/.test(value)
        case "pathLength":
            return numericValue(value.trim(), 0)
        case "points": {
            const points = numberList(value)
            return points !== null && points.length >= 4 && points.length % 2 === 0
        }
        case "viewBox": {
            const viewBox = numberList(value)
            return viewBox !== null && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0
        }
        case "preserveAspectRatio":
            return PRESERVE_ASPECT_RATIO_RE.test(value.trim())
        case "width":
        case "height":
        case "r":
        case "rx":
        case "ry":
            return safeLength(value) !== null
        case "x":
        case "y":
        case "cx":
        case "cy":
        case "x1":
        case "x2":
        case "y1":
        case "y2":
            return safeLength(value, true) !== null
        default:
            return false
    }
}

type SanitizedAttribute =
    | { action: "keep"; name: string; value: string }
    | { action: "drop" }
    | { action: "reject" }

const sanitizeAttribute = (
    elementName: string,
    isRoot: boolean,
    attribute: ParsedAttribute,
    presentation: LogoPresentation
): SanitizedAttribute => {
    const lowerName = attribute.name.toLowerCase()

    if (
        lowerName.startsWith("on") ||
        lowerName === "style" ||
        lowerName === "href" ||
        lowerName === "xlink:href"
    ) {
        return { action: "drop" }
    }

    if (lowerName === "xmlns" || lowerName.startsWith("xmlns:")) {
        if (isRoot && attribute.name === "xmlns" && attribute.value === SVG_NAMESPACE) {
            return { action: "drop" }
        }
        return { action: "reject" }
    }

    if (attribute.name.includes(":")) return { action: "reject" }
    if (!ELEMENT_ATTRIBUTES[elementName]?.has(attribute.name)) return { action: "drop" }

    const value = attribute.value
        .replaceAll("{height}", presentation.height)
        .replaceAll("{color}", presentation.color)
        .replaceAll("{bgcolor}", presentation.bgcolor)

    if (!safeAttributeValue(attribute.name, value)) return { action: "drop" }
    return { action: "keep", name: attribute.name, value: value.trim() }
}

const serializeStartTag = (
    tag: ParsedStartTag,
    isRoot: boolean,
    presentation: LogoPresentation
): string | null => {
    const attributes: ParsedAttribute[] = isRoot
        ? [{ name: "xmlns", value: SVG_NAMESPACE }]
        : []

    for (const attribute of tag.attributes) {
        const sanitized = sanitizeAttribute(tag.name, isRoot, attribute, presentation)
        if (sanitized.action === "reject") return null
        if (sanitized.action === "keep") {
            attributes.push({ name: sanitized.name, value: sanitized.value })
        }
    }

    const serializedAttributes = attributes
        .map(({ name, value }) => ` ${name}="${escapeAttribute(value)}"`)
        .join("")
    return `<${tag.name}${serializedAttributes}${tag.selfClosing ? "/" : ""}>`
}

const sanitizeCustomLogo = (
    sourceValue: unknown,
    values: LogoPresentation
): string | null => {
    if (typeof sourceValue !== "string" || sourceValue.length > MAX_SOURCE_LENGTH) return null
    if (!hasOnlyValidXmlCharacters(sourceValue)) return null

    const presentation = sanitizeLogoPresentation(values)
    let source = sourceValue.replace(/^\uFEFF/, "").trim()
    if (source.length === 0) return null

    if (source.startsWith("<?xml")) {
        const declarationEnd = source.indexOf("?>")
        if (declarationEnd === -1) return null
        const declaration = source.slice(0, declarationEnd + 2)
        if (!XML_DECLARATION_RE.test(declaration)) return null
        source = source.slice(declarationEnd + 2).trimStart()
    }

    const output: string[] = []
    const stack: StackEntry[] = []
    let index = 0
    let elementCount = 0
    let sawRoot = false
    let rootClosed = false

    while (index < source.length) {
        if (source[index] !== "<") {
            const nextTag = source.indexOf("<", index)
            const end = nextTag === -1 ? source.length : nextTag
            const text = source.slice(index, end)
            if (text.includes("]]>") || decodeXmlEntities(text) === null) return null
            if (stack.length === 0 && text.trim().length > 0) return null
            index = end
            continue
        }

        if (source.startsWith("<!--", index)) {
            const commentEnd = source.indexOf("-->", index + 4)
            if (commentEnd === -1) return null
            const comment = source.slice(index + 4, commentEnd)
            if (comment.includes("--") || comment.endsWith("-")) return null
            index = commentEnd + 3
            continue
        }

        if (source.startsWith("<?", index) || source.startsWith("<!", index)) return null

        if (source.startsWith("</", index)) {
            const closingTag = parseClosingTag(source, index)
            if (!closingTag || stack.length === 0) return null
            const entry = stack.pop()
            if (!entry || entry.name !== closingTag.name) return null
            if (entry.emitted) output.push(`</${entry.name}>`)
            if (stack.length === 0) rootClosed = true
            index = closingTag.end
            continue
        }

        const tag = parseStartTag(source, index)
        if (!tag || tag.name.includes(":")) return null
        elementCount++
        if (elementCount > MAX_ELEMENTS || stack.length >= MAX_DEPTH) return null

        const isRoot = stack.length === 0
        if (isRoot) {
            if (sawRoot || rootClosed || tag.name !== "svg") return null
            sawRoot = true
        }

        const parentEmitted = isRoot || stack[stack.length - 1].emitted
        const emitted =
            parentEmitted &&
            ((isRoot && tag.name === "svg") || (!isRoot && tag.name !== "svg" && tag.name in ELEMENT_ATTRIBUTES))

        if (emitted) {
            const serialized = serializeStartTag(tag, isRoot, presentation)
            if (serialized === null) return null
            output.push(serialized)
        }

        if (tag.selfClosing) {
            if (isRoot) rootClosed = true
        } else {
            stack.push({ name: tag.name, emitted })
        }
        index = tag.end
    }

    if (!sawRoot || !rootClosed || stack.length !== 0) return null
    const sanitized = output.join("")
    return sanitized.length <= MAX_SOURCE_LENGTH ? sanitized : null
}

export { sanitizeCustomLogo, sanitizeLogoPresentation }
export type { LogoPresentation }
