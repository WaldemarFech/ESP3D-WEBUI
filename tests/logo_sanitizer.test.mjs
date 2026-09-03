import assert from "node:assert/strict"
import test from "node:test"
import { sanitizeCustomLogo, sanitizeLogoPresentation } from "../src/components/Images/customLogo.ts"

const BENIGN_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" height="{height}"><path d="M10 10 L90 10 L50 90 Z" fill="{color}" stroke="{bgcolor}"/></svg>`

const PRESENT = { height: "60px", color: "#123456", bgcolor: "#abcdef" }

test("benign custom logo renders safely with placeholders", () => {
    const out = sanitizeCustomLogo(BENIGN_LOGO, PRESENT)
    assert.ok(typeof out === "string")
    assert.ok(out.includes("xmlns="))
    assert.ok(out.includes('fill="#123456"'))
    assert.ok(out.includes('stroke="#abcdef"'))
    assert.ok(out.includes('height="60px"'))
    assert.equal(out.includes("<script"), false)
    assert.equal(out.includes("javascript:"), false)
})

test("script injection via onload rejected / dropped", () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>`
    const out = sanitizeCustomLogo(bad, PRESENT)
    assert.ok(out === null || !out.includes("onload"))
})

test("foreignObject / use / animate stripped", () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)/></body></foreignObject><path d="M0 0"/></svg>`
    const out = sanitizeCustomLogo(bad, PRESENT)
    assert.ok(out === null || (!out.includes("foreignObject") && !out.includes("img")))
})

test("href/xlink:href / url resources stripped", () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>`
    const out = sanitizeCustomLogo(bad, PRESENT)
    assert.ok(out === null || !(out.includes("javascript:") || out.includes("href=")))
})

test("bad namespace rebind and prefixed root rejected", () => {
    const bad = `<svg xmlns="http://www.w3.org/1999/xhtml"><img onerror=alert(1)/></svg>`
    assert.equal(sanitizeCustomLogo(bad, PRESENT), null)
})

test("style attribute and css-url rejected", () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg" style="fill:url(javascript:alert(1))"><path d="M0 0"/></svg>`
    const out = sanitizeCustomLogo(bad, PRESENT)
    assert.ok(out === null || !(out.includes("style=") || out.includes("url(")))
})

test("placeholder injection in color prop rejected at validation", () => {
    const badColor = { ...PRESENT, color: "#fff\" onload=\"alert(1)" }
    const ref = sanitizeLogoPresentation(badColor)
    assert.equal(ref.color, "currentColor")
})

test("placeholder substitution does not create new tags / on*", () => {
    const maliciousLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0" fill="{color}"/></svg>`
    const out = sanitizeCustomLogo(maliciousLogo, { ...PRESENT, color: "red\" onload=\"alert(1)" })
    // validation should reject bad color, falling back; output must not contain the injection
    assert.ok(out === null || (out && !out.includes("onload") && !out.includes("<script")))
})

test("malformed XML / missing root / extra text outside root rejected", () => {
    assert.equal(sanitizeCustomLogo("not xml", PRESENT), null)
    assert.equal(sanitizeCustomLogo("<svg></svg>hello", PRESENT), null)
})

test("presentation fallback validates bad height / color / bgcolor", () => {
    const bad = sanitizeLogoPresentation({ height: "bad!", color: "bad!", bgcolor: "bad!" })
    assert.equal(bad.height, "50px")
    assert.equal(bad.color, "currentColor")
    assert.equal(bad.bgcolor, "white")
})
