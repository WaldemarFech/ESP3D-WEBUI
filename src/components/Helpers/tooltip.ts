/*
 tooltip.ts - ESP3D WebUI helpers file

 Copyright (c) 2021 Luc LEBOSSE. All rights reserved.

 This code is free software; you can redistribute it and/or
 modify it under the terms of the GNU Lesser General Public
 License as published by the Free Software Foundation; either
 version 2.1 of the License, or (at your option) any later version.
 This code is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 Lesser General Public License for more details.
 You should have received a copy of the GNU Lesser General Public
 License along with This code; if not, write to the Free Software
 Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/

// Position a viewport-anchored ("portal") tooltip next to the hovered/focused
// element, kept fully inside the window. Pair with the
// `.tooltip.tooltip-portal` CSS rule (src/style/components/_control.scss),
// which uses position: fixed to escape any ancestor's overflow:hidden -
// unlike the default Spectre `.tooltip::after`, which is position: absolute
// and gets clipped by the nearest clipping ancestor (e.g. a Settings panel).
//
// Onto any element with class="tooltip tooltip-portal" and a data-tooltip
// attribute, wire onMouseEnter={positionPortalTooltip}.

const TOOLTIP_MARGIN = 8
const TOOLTIP_MAX_WIDTH = 220 // CSS max-width of the tooltip box
const TOOLTIP_CHAR_WIDTH = 6.5 // approx. px per char at the tooltip font size
const TOOLTIP_LINE_HEIGHT = 18
const TOOLTIP_PADDING_Y = 10

interface PortalTooltipPosition {
    x: number
    y: number
    placement: "above" | "below"
}

// The ::after box can't be measured from script, so its height is estimated
// from the text length and the CSS max-width (generous on purpose: a slightly
// early flip below is harmless, a clipped top line is not).
function estimateTooltipHeight(text: string, viewportWidth: number): number {
    const boxWidth = Math.max(40, Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - 2 * TOOLTIP_MARGIN))
    const charsPerLine = Math.max(1, Math.floor(boxWidth / TOOLTIP_CHAR_WIDTH))
    const lines = String(text || "")
        .split("\n")
        .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
    return lines * TOOLTIP_LINE_HEIGHT + TOOLTIP_PADDING_Y
}

// Pure placement: centered on the element horizontally (clamped to the
// window), above it by default, flipped below when the space above is too
// small, and clamped vertically as a last resort when neither side fits.
function computePortalTooltipPosition(
    rect: { left: number; top: number; bottom: number; width: number },
    viewport: { width: number; height: number },
    tooltipHeight: number
): PortalTooltipPosition {
    const margin = TOOLTIP_MARGIN
    // Shrink to fit narrow windows too - on a wide window this is 110px
    // (the CSS tooltip max-width, 220px, halved); on a narrow window it
    // shrinks so minX/maxX never invert (which would let the right-side
    // bound win and push the box off the left edge)
    const halfTooltip = Math.min(TOOLTIP_MAX_WIDTH / 2, viewport.width / 2 - margin)
    const minX = halfTooltip + margin
    const maxX = viewport.width - halfTooltip - margin
    const x = Math.min(Math.max(rect.left + rect.width / 2, minX), maxX)

    const spaceAbove = rect.top - 2 * margin
    const spaceBelow = viewport.height - rect.bottom - 2 * margin
    if (tooltipHeight <= spaceAbove || spaceAbove >= spaceBelow) {
        // above: y is the box's bottom edge (CSS translates it up by 100%)
        const y = Math.max(rect.top - margin, Math.min(tooltipHeight + margin, viewport.height - margin))
        return { x, y, placement: "above" }
    }
    // below: y is the box's top edge
    const y = Math.max(margin, Math.min(rect.bottom + margin, viewport.height - tooltipHeight - margin))
    return { x, y, placement: "below" }
}

function positionPortalTooltip(e: any): void {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const text = el.getAttribute ? el.getAttribute("data-tooltip") || "" : ""
    const pos = computePortalTooltipPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        estimateTooltipHeight(text, window.innerWidth)
    )
    el.style.setProperty("--tooltip-x", `${pos.x}px`)
    el.style.setProperty("--tooltip-y", `${pos.y}px`)
    el.style.setProperty("--tooltip-ty", pos.placement === "above" ? "-100%" : "0%")
    el.style.setProperty("--tooltip-hover-shift", pos.placement === "above" ? "-0.2rem" : "0.2rem")
}

export { positionPortalTooltip, computePortalTooltipPosition, estimateTooltipHeight }
