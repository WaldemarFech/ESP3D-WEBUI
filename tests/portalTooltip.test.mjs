import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { computePortalTooltipPosition, estimateTooltipHeight } = await importTypeScript("../src/components/Helpers/tooltip.ts")

const vp = { width: 1200, height: 800 }
const rect = (top, left = 500, height = 30, width = 40) => ({ top, bottom: top + height, left, width })

test("default: above the element when there is room", () => {
    const p = computePortalTooltipPosition(rect(400), vp, 60)
    assert.equal(p.placement, "above")
    assert.equal(p.y, 392)
    assert.ok(p.y - 60 >= 8, "top edge stays inside the window")
})

test("near the top edge: flips below so the top is never clipped", () => {
    const p = computePortalTooltipPosition(rect(10), vp, 60)
    assert.equal(p.placement, "below")
    assert.equal(p.y, 48)
    assert.ok(p.y >= 8 && p.y + 60 <= vp.height - 8)
})

test("no room on either side: top edge still stays inside the window", () => {
    const small = { width: 400, height: 120 }
    for (const top of [5, 40, 80]) {
        const p = computePortalTooltipPosition(rect(top, 100, 30), small, 100)
        const topEdge = p.placement === "above" ? p.y - 100 : p.y
        assert.ok(topEdge >= 8 - 1e-9, `top clipped at element top=${top}: ${JSON.stringify(p)}`)
    }
})

test("horizontal clamp is unchanged and never inverts on narrow windows", () => {
    assert.equal(computePortalTooltipPosition(rect(400, 0, 30, 10), vp, 40).x, 118)
    assert.equal(computePortalTooltipPosition(rect(400, 1190, 30, 10), vp, 40).x, 1082)
    const narrow = computePortalTooltipPosition(rect(400, 0, 30, 10), { width: 100, height: 800 }, 40)
    assert.ok(narrow.x >= 8 && narrow.x <= 92)
})

test("height estimate grows with text length and line breaks", () => {
    const one = estimateTooltipHeight("Short", 1200)
    assert.ok(estimateTooltipHeight("x".repeat(300), 1200) > one)
    assert.ok(estimateTooltipHeight("a\nb\nc", 1200) > one)
    assert.ok(estimateTooltipHeight("", 1200) > 0)
})
