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

// Position a viewport-anchored ("portal") tooltip above the hovered/focused
// element, clamped so it always stays fully inside the window. Pair with the
// `.tooltip.tooltip-portal` CSS rule (src/style/components/_control.scss),
// which uses position: fixed to escape any ancestor's overflow:hidden -
// unlike the default Spectre `.tooltip::after`, which is position: absolute
// and gets clipped by the nearest clipping ancestor (e.g. a Settings panel).
//
// Onto any element with class="tooltip tooltip-portal" and a data-tooltip
// attribute, wire onMouseEnter={positionPortalTooltip}.
function positionPortalTooltip(e: any): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const margin = 8
    // Shrink to fit narrow windows too - on a wide window this is 110px
    // (the CSS tooltip max-width, 220px, halved); on a narrow window it
    // shrinks so minX/maxX never invert (which would let the right-side
    // bound win and push the box off the left edge)
    const halfTooltip = Math.min(110, window.innerWidth / 2 - margin)
    const minX = halfTooltip + margin
    const maxX = window.innerWidth - halfTooltip - margin
    const x = Math.min(Math.max(rect.left + rect.width / 2, minX), maxX)
    const y = rect.top - margin
    e.currentTarget.style.setProperty("--tooltip-x", `${x}px`)
    e.currentTarget.style.setProperty("--tooltip-y", `${y}px`)
}

export { positionPortalTooltip }
