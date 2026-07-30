/*
 Button.tsx - ESP3D WebUI component file

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved.

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
import { FunctionalComponent } from "preact"
import { createComponent, positionPortalTooltip } from "../Helpers"

/*
 * Local const
 *
 */

const modifiers = {
    donotdisable: "do-not-disable",
    group: "input-group-btn",
    link: "btn-link",
    primary: "btn-primary",
    error: "btn-error",
    success: "btn-success",
    lg: "btn-lg",
    sm: "btn-sm",
    xs: "btn-xs",
    block: "btn-block",
    action: "btn-action",
    circle: "s-circle",
    active: "active",
    disable: "disable",
    loading: "loading",
    // tooltip-portal (src/style/components/_control.scss) makes every one of
    // these viewport-anchored (position: fixed, JS-clamped to the window,
    // multi-line-capable) instead of Spectre's default position: absolute,
    // single-line, clipped-by-any-overflow:hidden-ancestor tooltip. btooltip
    // also picked up the plain "tooltip" base class it was missing before -
    // without it, Spectre's (and this rule's) `.tooltip.tooltip-bottom`
    // selector never matched, so a bottom-anchored tooltip never rendered at
    // all.
    tooltip: "tooltip tooltip-portal",
    btooltip: "tooltip tooltip-bottom tooltip-portal",
    ltooltip: "tooltip tooltip-left tooltip-portal",
    rtooltip: "tooltip tooltip-right tooltip-portal",
    mx2: "mx-2",
    m05: "m-05",
    m2: "m-2",
    m1: "m-1",
    mt1: "mt-1",
    min2rem: "min2rem",
    min1rem: "min1rem",
}
const RawButton = createComponent("button", "btn", modifiers)

interface ButtonProps {
    tooltip?: boolean
    btooltip?: boolean
    ltooltip?: boolean
    rtooltip?: boolean
    // matches positionPortalTooltip's own (e: any) signature - this codebase's
    // existing convention for DOM event handlers passed as props (see e.g.
    // ItemsList.tsx/JogCNC.tsx), and avoids the deprecated JSX.TargetedEvent
    // family of types.
    onMouseEnter?: (e: any) => void
    [key: string]: any
}

// Thin wrapper around the createComponent-generated button: auto-attaches
// positionPortalTooltip on hover whenever the caller used one of the four
// tooltip modifier props above, so every <Button tooltip .../> /
// <ButtonImg ltooltip .../> call site app-wide gets the viewport-anchored
// tooltip fix from one place, matching what Task 6 already did for
// Select.tsx/Boolean.tsx/Input.tsx by hand. Merges with (never drops) any
// onMouseEnter a caller already passes for an unrelated reason. Buttons
// with none of the four tooltip props are completely unaffected - no
// onMouseEnter is added, same as before.
const Button: FunctionalComponent<ButtonProps> = ({
    tooltip,
    btooltip,
    ltooltip,
    rtooltip,
    onMouseEnter,
    ...rest
}) => {
    const hasTooltip = !!(tooltip || btooltip || ltooltip || rtooltip)
    // createComponent's modifier lookup keys off whether a prop is PRESENT on
    // the object at all (Object.keys(...).includes(...)), not whether its
    // value is truthy - so these four must only be re-spread when actually
    // truthy. Forwarding e.g. tooltip={undefined} unconditionally would still
    // count as "present" and glue every one of the four tooltip classes onto
    // every button in the app, tooltip or not.
    const tooltipProps: Record<string, boolean> = {}
    if (tooltip) tooltipProps.tooltip = tooltip
    if (btooltip) tooltipProps.btooltip = btooltip
    if (ltooltip) tooltipProps.ltooltip = ltooltip
    if (rtooltip) tooltipProps.rtooltip = rtooltip
    return (
        <RawButton
            {...tooltipProps}
            {...rest}
            onMouseEnter={
                hasTooltip
                    ? (e: any) => {
                          positionPortalTooltip(e)
                          onMouseEnter?.(e)
                      }
                    : onMouseEnter
            }
        />
    )
}

export default Button
