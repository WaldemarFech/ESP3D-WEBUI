const escapeHtml = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const safeLinkHref = (rawUrl: string): string | null => {
    const url = rawUrl.trim()
    if (!/^https?:/i.test(url)) return null
    if ([...url].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127 || "<>\"'`\\".includes(character)
    })) return null
    return url
}

const renderInlineMarkdown = (source: string): string => {
    const tokens: string[] = []
    const reserveToken = (html: string): string => {
        tokens.push(html)
        return `\u0000TOKEN${tokens.length - 1}\u0000`
    }

    let text = source.replace(/`([^`]+)`/g, (_match, code: string) => {
        return reserveToken(`<code>${escapeHtml(code)}</code>`)
    })
    text = text.replace(/\[([^\]\n]+)\]\(([^\n]+)\)/g, (_match, label: string, rawUrl: string) => {
        // Strip only the markdown delimiter's final parenthesis. This keeps
        // balanced URL parentheses while still rejecting active protocols.
        const url = rawUrl.endsWith(")") ? rawUrl.slice(0, -1) : rawUrl
        const href = safeLinkHref(url)
        const safeLabel = escapeHtml(label)
        return reserveToken(href === null
            ? safeLabel
            : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`)
    })

    // Escape all remaining remote content before emitting renderer-owned tags.
    let html = escapeHtml(text)
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>")
    html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")
    html = html.replace(/(?<![\w])_([^_\n]+?)_(?![\w])/g, "<em>$1</em>")

    tokens.forEach((token, index) => {
        html = html.replace(`\u0000TOKEN${index}\u0000`, token)
    })
    return html
}

/**
 * Render the small markdown subset used by release previews. Remote HTML is
 * always escaped; only renderer-owned h4-h6, strong, em, a, ul/li, br, pre,
 * and code elements can be returned.
 */
export const markdownToSafeHtml = (markdown: string): string => {
    const codeBlocks: string[] = []
    const protectedMarkdown = markdown.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, (_match, code: string) => {
        codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)
        return `\u0000BLOCK${codeBlocks.length - 1}\u0000`
    })

    const lines = protectedMarkdown.split("\n")
    const output: string[] = []
    let listItems: string[] = []

    const flushList = (): void => {
        if (listItems.length === 0) return
        output.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`)
        listItems = []
    }

    for (const line of lines) {
        const blockPrefix = "\u0000BLOCK"
        const block = line.startsWith(blockPrefix) && line.endsWith("\u0000")
            ? Number(line.slice(blockPrefix.length, -1))
            : Number.NaN
        if (Number.isInteger(block)) {
            flushList()
            output.push(codeBlocks[block])
            continue
        }

        const list = /^\s*[*+-]\s+(.+)$/.exec(line)
        if (list) {
            listItems.push(renderInlineMarkdown(list[1]))
            continue
        }
        flushList()

        const heading = /^(#{1,3})\s+(.+)$/.exec(line)
        if (heading) {
            const level = 3 + heading[1].length
            output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
        } else if (line.length > 0) {
            output.push(renderInlineMarkdown(line))
        }
    }
    flushList()

    return output.join("<br>").replace(/<br>(?=<ul>|<h[4-6]>|<pre>)/g, "")
        .replace(/(<\/ul>|<\/h[4-6]>|<\/pre>)<br>/g, "$1")
}

export const getTruncatedReleaseBody = (body: string): string => {
    const lines = body.split("\n").filter((line) => line.trim() !== "")
    return markdownToSafeHtml(lines.slice(0, 10).join("\n"))
}
