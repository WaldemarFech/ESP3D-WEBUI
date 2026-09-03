import assert from "node:assert/strict"
import test from "node:test"
import {
    getTruncatedReleaseBody,
    markdownToSafeHtml,
} from "../src/components/Modal/releaseNotesMarkdown.ts"
import { safeGitHubDownloadUrl } from "../src/Services/GitHubDownloadUrl.ts"

test("escapes raw release HTML and event-handler payloads", () => {
    const html = markdownToSafeHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>')

    assert.equal(html.includes("<img"), false)
    assert.equal(html.includes("<script"), false)
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
})

test("rejects active and attribute-breaking link URLs", () => {
    for (const url of [
        "javascript:alert(1)",
        "data:text/html,<svg onload=alert(1)>",
        'https://safe.example/\" onclick=\"alert(1)',
        "//evil.example/path",
    ]) {
        const html = markdownToSafeHtml(`[open](${url})`)
        assert.equal(html.includes("href="), false)
        assert.equal(html.includes("onclick="), false)
    }
})

test("preserves supported markdown with safe links and escaped code", () => {
    const html = markdownToSafeHtml([
        "# Heading",
        "**bold** and *italic* and `x < y`",
        "- first",
        "- [docs](https://example.com/docs?q=1&ok=2)",
        "```ts",
        '<img src=x onerror="alert(1)">',
        "```",
    ].join("\n"))

    assert.match(html, /<h4>Heading<\/h4>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<em>italic<\/em>/)
    assert.match(html, /<code>x &lt; y<\/code>/)
    assert.match(html, /<ul><li>first<\/li><li><a href="https:\/\/example\.com\/docs\?q=1&amp;ok=2" target="_blank" rel="noopener noreferrer">docs<\/a><\/li><\/ul>/)
    assert.match(html, /<pre><code>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/code><\/pre>/)
})

test("GitHub release downloads require HTTPS on trusted hosts", () => {
    assert.match(safeGitHubDownloadUrl("https://github.com/org/repo/releases/download/v1/file.bin"), /^https:/)
    assert.match(safeGitHubDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/file"), /^https:/)
    for (const value of [
        "javascript:alert(1)",
        "data:text/html,<svg onload=alert(1)>",
        "http://github.com/org/repo/file",
        "https://github.com.evil.example/file",
        "https://evil.example@github.com/org/repo/file",
        "https://github.com:444/org/repo/file",
        "//github.com/org/repo/file",
    ]) {
        assert.equal(safeGitHubDownloadUrl(value), null)
    }
})

test("release preview remains limited to ten non-empty lines", () => {
    const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
    const html = getTruncatedReleaseBody(body)

    assert.match(html, /line 10/)
    assert.equal(html.includes("line 11"), false)
})
