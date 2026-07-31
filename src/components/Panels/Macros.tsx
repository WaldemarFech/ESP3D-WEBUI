/*
Macros.js - ESP3D WebUI component file

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

import { TargetedMouseEvent } from "preact"
import type { FunctionalComponent, ComponentChildren } from "preact"
import { T } from "../Translations"
import { Cast } from "preact-feather"
import { useUiContext, useUiContextFn } from "../../contexts"
import { ButtonImg, FullScreenButton, CloseButton, ContainerHelper } from "../Controls"
import { useTargetCommands } from "../../hooks"
import { iconsFeather } from "../Images"
import {
    iconsTarget,
    useTargetContextFn,
} from "../../targets"
import type { TargetContextFn } from "../../targets/types"
import { executeMacroAction } from "../../targets/CNC/FluidNC/macroExecution"
import type { MacroType } from "../../targets/CNC/FluidNC/macroExecution"

/*
 * Local const
 *
 */
interface MacroValue {
    name: string
    initial: string
}

interface MacroItem {
    id: string
    value: MacroValue[]
}

interface MacroButton {
    id: string
    name: string
    action: string
    type: MacroType
    icon?: string
    color?: string
    [key: string]: any
}

const MacrosPanel: FunctionalComponent = () => {
    const { uisettings } = useUiContext()
    const { processData } = useTargetContextFn as TargetContextFn
    const { targetCommands, failToast } = useTargetCommands()
    const iconsList: Record<string, ComponentChildren> = { ...iconsTarget, ...iconsFeather }
    const id = "macrosPanel"
    const sendCommand = (command: string): void => {
        const callbacks = {
            onSuccess: (result: string) => {
                processData("response", result)
            },
            onFail: failToast,
        }
        targetCommands(command, undefined, undefined, callbacks)
    }

    const macroList: MacroItem[] = uisettings.getValue("macros")
    const macroButtons: MacroButton[] = macroList.reduce((acc: MacroButton[], curr: MacroItem) => {
        const item: MacroButton = curr.value.reduce((accumulator: any, current: MacroValue) => {
            accumulator[current.name] = current.initial
            return accumulator
        }, {} as MacroButton)
        item.id = curr.id
        acc.push(item)
        return acc
    }, [])
    // Actual FS/SD/URI/URI_SILENT/CMD switch lives in macroExecution.ts, shared
    // with the event-macros engine (see that file's header comment) - this is
    // just the panel's own sendCommand plugged in.
    const processMacro = (action: string, type: MacroType): void => {
        executeMacroAction(action, type, sendCommand)
    }

    return (
        <div class="panel panel-dashboard" id={id}>
            <ContainerHelper id={id} /> 
            <div class="navbar">
                <span class="navbar-section feather-icon-container">
                    <Cast />
                    <strong class="text-ellipsis">{T("macros")}</strong>
                </span>
                <span class="navbar-section">
                    <span class="full-height">
                        <FullScreenButton elementId={id}/>
                        <CloseButton
                            elementId={id}
                            hideOnFullScreen={true}
                        />
                    </span>
                </span>
            </div>
            <div class="panel-body panel-body-dashboard">
                <div class="macro-buttons-panel">
                    {macroButtons.map((element: MacroButton) => {
                        const displayIcon = element.icon && iconsList[element.icon]
                            ? iconsList[element.icon]
                            : ""
                        return (
                            <ButtonImg key={element.id}
                                id={element.id}
                                m1
                                showlow
                                label={element.name}
                                icon={displayIcon}
                                onClick={(e: TargetedMouseEvent<HTMLButtonElement>) => {
                                    useUiContextFn.haptic()
                                    e.currentTarget.blur()
                                    processMacro(element.action, element.type)
                                }}
                            />
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

const MacrosPanelElement = {
    id: "macrosPanel",
    content: <MacrosPanel />,
    name: "macros",
    icon: "Cast",
    show: "showmacrospanel",
    onstart: "openmacrosonstart",
    settingid: "macros",
}

export { MacrosPanel, MacrosPanelElement }
