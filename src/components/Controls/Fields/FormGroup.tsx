/*
 FormGroup.tsx - ESP3D WebUI component file

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved
 Modified by Luc LEBOSSE 2021

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

import { FunctionalComponent, ComponentChildren } from "preact"

interface Validation {
    valid?: boolean
    modified?: boolean
    success?: boolean
    message?: ComponentChildren
}

interface FormGroupProps {
    className?: string
    inline?: boolean
    validation?: Validation | null
    children?: ComponentChildren
    label?: string
    id?: string
    forctrl?: string
    type?: string
}

const FormGroup: FunctionalComponent<FormGroupProps> = ({
    className,
    inline,
    validation = null,
    children,
    label,
    id,
    forctrl,
    type,
}) => {
    const getValidationClass = (validation: Validation | null): string => {
        if (validation !== null && validation.valid == true) {
            if (validation.modified) return `form-group has-modification`
            if (validation.success) return `form-group has-success`
        }
        if (validation != null && validation.valid == false)
            return `form-group has-error`
        return `${inline ? "form-group-inline " : ""} form-group`
    }
    return (
        <div
            class={`${className ? `${className  } ` : ""}${getValidationClass(
                validation
            )}`}
            id={id ? `group-${  id}` : ""}
        >
            <div
                class={
                    // Spectre's .columns is a flex grid ROW: it applies a
                    // -.4rem margin-left/right expecting .column-classed
                    // children to cancel it out with matching padding. For
                    // an inline boolean field, FormGroup's own <label>
                    // below is unconditionally d-none (Boolean.tsx renders
                    // its own self-contained label+switch instead), so
                    // there's no second column here to justify the grid-row
                    // treatment - applying it anyway leaves the negative
                    // margin uncancelled, bleeding the control a few px
                    // outside whatever container it sits in (invisible in
                    // the roomy Settings panel, but visibly breaks a
                    // tightly bordered fieldset like an event-macro row).
                    inline
                        ? type == "boolean"
                            ? "mt-2"
                            : "columns mt-2"
                        : "flex-cols"
                }
            >
                {!(type == "list" || type == "mask" || type == "xmask") &&
                    label && (
                        <label
                            class={
                                inline && type == "boolean"
                                    ? "d-none"
                                    : `form-label ${
                                          forctrl ? "text-primary" : "text-dark"
                                      } ${inline ? "column col-auto" : ""}`
                            }
                            htmlFor={forctrl ? forctrl : id}
                        >
                            {label}
                        </label>
                    )}

                {children}
                {validation && validation.message && (
                    <div
                        className={`form-input-hint ${
                            inline ? "text-left" : "text-center"
                        }`}
                    >
                        {validation.message}
                    </div>
                )}
            </div>
        </div>
    )
}

export default FormGroup
export type { Validation }
