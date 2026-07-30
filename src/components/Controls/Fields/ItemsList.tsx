/*
 ItemsList.tsx - ESP3D WebUI component file

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

import { Fragment,  FunctionalComponent, TargetedMouseEvent, JSX } from "preact"
import { useState, useEffect } from "preact/hooks"
import { ButtonImg } from "../../Controls"
import { T } from "../../Translations"
import { iconsFeather } from "../../Images"
import { iconsTarget } from "../../../targets"
import {
    generateUID,
    generateDependIds,
    checkDependencies,
} from "../../Helpers"
import { Field } from "../../Controls"
import { formatItem } from "../../../tabs/interface/importHelper"
import { useUiContextFn, useSettingsContext } from "../../../contexts"
import {
    Plus,
    ArrowUp,
    ArrowDown,
    Trash2,
    Minimize2,
    Flag,
    Zap,
} from "preact-feather"
import defaultPanel from "./def_panel.json"
import defaultMacro from "./def_macro.json"
import defaultPolling from "./def_polling.json"
import defaultEventMacro from "./def_eventmacro.json"

// Example/placeholder action URLs, one per event macro trigger, for the
// eventmacros list's "insert example" quick-fill button (only fills an
// empty action field - never overwrites an existing value). Grounded in
// this codebase's already-validated Tasmota-style smart-plug URI_SILENT
// use case; "hold"/"ws_connect"/"ws_disconnect" have no obviously-real
// smart-plug use case, so they get an honest generic placeholder instead
// of a forced example.
const eventMacroExampleActions: Record<string, string> = {
    spindle_on: "http://192.168.30.4/cm?cmnd=Power%20ON",
    spindle_off: "http://192.168.30.4/cm?cmnd=Power%20OFF",
    cycle_start: "http://<light-plug-ip>/cm?cmnd=Power%20ON",
    cycle_stop: "http://<light-plug-ip>/cm?cmnd=Power%20OFF",
    hold: "http://<device-ip>/your-endpoint",
    door_open: "http://192.168.30.4/cm?cmnd=Power%20OFF",
    door_closed: "http://192.168.30.4/cm?cmnd=Power%20ON",
    alarm: "http://192.168.30.4/cm?cmnd=Power%20OFF",
    ws_connect: "http://<device-ip>/your-endpoint",
    ws_disconnect: "http://<device-ip>/your-endpoint",
}

interface FieldItem {
    id: string
    type?: string
    label?: string
    initial: any
    value: any
    options?: any[]
    name?: string
    haserror?: boolean
    hasmodified?: boolean
    [key: string]: any
}

interface ItemData {
    id: string
    value: FieldItem[]
    editionMode?: boolean
    newItem?: boolean
    [key: string]: any
}

type ValidationError = string | null | true  // true or null means valid, string is the error message
type ValidationFunction = (item: FieldItem) => ValidationError | Promise<ValidationError>

interface ItemControlProps {
    itemData: ItemData
    index: number
    completeList: ItemData[]
    idList: string
    depend?: any
    setValue: (value: ItemData[] | null, update?: boolean) => void
    validationfn: ValidationFunction
    fixed?: boolean
    nodelete?: boolean
    editable?: boolean
    sorted?: boolean
}

interface ItemsListProps {
    id: string
    label?: string
    validationfn: ValidationFunction
    validation?: any
    value: ItemData[]
    type?: string
    setValue: (value: ItemData[] | null, update?: boolean) => void
    inline?: boolean
    fixed?: boolean
    sorted?: boolean
    depend?: any
    nodelete?: boolean
    editable?: boolean
    [key: string]: any
}

/*
 * Local const
 *
 */
const ItemControl: FunctionalComponent<ItemControlProps> = ({
    itemData,
    index,
    completeList,
    idList,
    depend,
    setValue,
    validationfn,
    fixed,
    nodelete,
    editable,
    sorted,
}) => {
    const iconsList: Record<string, any> = { ...iconsTarget, ...iconsFeather }
    const { id, value, editionMode, ...rest } = itemData
    const indexIcon = value.findIndex((element) => element.id == `${id  }-icon`)
    const indexName = value.findIndex((element) => element.id == `${id  }-name`)
    const icon = value ? value[indexIcon != -1 ? indexIcon : 0].value : null
    const name = value ? value[indexName != -1 ? indexName : 0].value : null
    const controlIcon = iconsList[icon] ? iconsList[icon] : ""

    const onEdit = (state: boolean) => {
        completeList[index].editionMode = state
        setValue([...completeList])
    }
    const downItem = (e: TargetedMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.blur()
        useUiContextFn.haptic()
        const item = completeList[index]
        completeList.splice(index, 1)
        completeList.splice(index + 1, 0, item)
        setValue(completeList)
    }
    const upItem = (e: TargetedMouseEvent<HTMLButtonElement>) => {
        e.currentTarget.blur()
        useUiContextFn.haptic()
        const item = completeList[index]
        completeList.splice(index, 1)
        completeList.splice(index - 1, 0, item)
        setValue(completeList)
    }
    const removeItem = (e: TargetedMouseEvent<HTMLButtonElement>) => {
        useUiContextFn.haptic()
        e.currentTarget.blur()
        completeList.splice(index, 1)
        setValue(completeList)
    }
    useEffect(() => {
        //to update state when import- but why ?
        if (setValue) setValue(null, true)
    }, [completeList])

    let colorStyle: string | undefined
    if (
        JSON.stringify(value).includes('"hasmodified":true') ||
        JSON.stringify(itemData).includes('"newitem":true')
    )
        colorStyle =
            "box-shadow: 0 0 0 .2rem rgba(255, 183, 0, .4);margin-right:0.5rem!important"

    if (JSON.stringify(value).includes('"haserror":true'))
        colorStyle =
            "box-shadow: 0 0 0 .2rem rgba(255, 0, 0, .4);margin-right:0.5rem!important"

    const val = value.findIndex((e) => {
        return e.name == "key"
    })

    const labelBtn =
        val != -1
            ? T(name) +
              (value[val].value.length != 0
                  ? ` [${  value[val].value  }]`
                  : "")
            : T(name)

    return (
        <Fragment>
            {!editionMode && (
                <div class="fields-line">
                    {((index > 0 && completeList.length > 1) ||
                        (index == 0 && completeList.length > 1)) &&
                        sorted && (
                            <div class="item-list-move">
                                {index > 0 && completeList.length > 1 && (
                                    <ButtonImg
                                        m1
                                        tooltip
                                        data-tooltip={T("S38")}
                                        icon={<ArrowUp />}
                                        onClick={upItem}
                                    />
                                )}
                                {completeList.length != 1 &&
                                    index < completeList.length - 1 && (
                                        <ButtonImg
                                            m1
                                            tooltip
                                            data-tooltip={T("S39")}
                                            icon={<ArrowDown />}
                                            onClick={downItem}
                                        />
                                    )}
                            </div>
                        )}

                    <div class="item-list-name">
                        {(!fixed || editable) && (
                            <ButtonImg
                                m2
                                tooltip
                                data-tooltip={T("S94")}
                                style={colorStyle}
                                label={labelBtn}
                                icon={controlIcon}
                                width="100px"
                                onClick={(e: TargetedMouseEvent<HTMLButtonElement>) => {
                                    useUiContextFn.haptic()
                                    e.currentTarget.blur()
                                    onEdit(true)
                                }}
                            />
                        )}
                        {fixed && !editable && (
                            <label class="m-1">{T(name)}</label>
                        )}
                    </div>

                    {!(fixed || nodelete) && (
                        <ButtonImg
                            m2
                            tooltip
                            data-tooltip={T("S37")}
                            icon={<Trash2 />}
                            onClick={removeItem}
                        />
                    )}
                </div>
            )}
            {editionMode && (
                <div class="itemEditor">
                    <div>
                        <ButtonImg
                            sm
                            tooltip
                            data-tooltip={T("S95")}
                            icon={<Minimize2 />}
                            onClick={(e: TargetedMouseEvent<HTMLButtonElement>) => {
                                useUiContextFn.haptic()
                                e.currentTarget.blur()
                                onEdit(false)
                            }}
                            class="float-right"
                        />
                        <div>
                            {index > 0 && completeList.length > 1 && sorted && (
                                <ButtonImg
                                    m1
                                    tooltip
                                    data-tooltip={T("S38")}
                                    icon={<ArrowUp />}
                                    onClick={upItem}
                                />
                            )}
                            {completeList.length != 1 &&
                                sorted &&
                                index < completeList.length - 1 && (
                                    <ButtonImg
                                        m1
                                        tooltip
                                        data-tooltip={T("S39")}
                                        icon={<ArrowDown />}
                                        onClick={downItem}
                                    />
                                )}

                            {!nodelete && (
                                <ButtonImg
                                    m2
                                    tooltip
                                    data-tooltip={T("S37")}
                                    icon={<Trash2 />}
                                    onClick={removeItem}
                                />
                            )}
                        </div>
                    </div>
                    <div class="m-1">
                        {value &&
                            value.map((item) => {
                                const {
                                    id,
                                    type,
                                    label,
                                    initial,
                                    options,
                                    ...rest
                                } = item
                                const [validation, setvalidation] = useState(
                                    validationfn(item)
                                )
                                //Do translation if necessary
                                const Options = options
                                    ? [...options].reduce((acc: any[], curr: any) => {
                                          acc.push({
                                              label: T(curr.label),
                                              value: curr.value,
                                              depend: curr.depend,
                                              // native per-option hover tooltip (event
                                              // dropdown's "what triggers this" text)
                                              title: curr.title ? T(curr.title) : undefined,
                                          })
                                          return acc
                                      }, [])
                                    : null
                                if (idList == "keymap" && item.name == "name") {
                                    return
                                }
                                const fieldSetValue = (val: any, update?: boolean) => {
                                    if (!update) item.value = val
                                    setvalidation(validationfn(item))
                                    setValue(completeList, update)
                                }
                                // Quick-fill: insert a plausible example action URL for
                                // this row's currently-selected event, but never clobber
                                // a value the user already typed.
                                if (idList == "eventmacros" && item.name == "action") {
                                    const eventField = value.find(
                                        (f) => f.name == "event"
                                    )
                                    const example = eventField
                                        ? eventMacroExampleActions[eventField.value]
                                        : undefined
                                    if (example) {
                                        const hasValue =
                                            String(item.value || "").trim().length > 0
                                        rest.button = (
                                            <ButtonImg
                                                m1
                                                tooltip
                                                data-tooltip={T("S237")}
                                                disabled={hasValue}
                                                icon={<Zap />}
                                                onClick={(
                                                    e: TargetedMouseEvent<HTMLButtonElement>
                                                ) => {
                                                    useUiContextFn.haptic()
                                                    e.currentTarget.blur()
                                                    if (hasValue) return
                                                    fieldSetValue(example)
                                                }}
                                            />
                                        )
                                    }
                                }
                                return (
                                    <Field
                                        id={item.id}
                                        label={
                                            idList == "keymap"
                                                ? T(itemData.id)
                                                : T(label)
                                        }
                                        type={type}
                                        options={Options}
                                        inline={
                                            type == "boolean" || type == "icon"
                                                ? true
                                                : false
                                        }
                                        {...rest}
                                        setValue={fieldSetValue}
                                        validation={validation}
                                    />
                                )
                            })}
                    </div>
                </div>
            )}
        </Fragment>
    )
}

const ItemsList: FunctionalComponent<ItemsListProps> = ({
    id,
    label,
    validationfn,
    validation,
    value,
    type,
    setValue,
    inline,
    fixed,
    sorted,
    depend,
    nodelete,
    editable,
}) => {
    const { interfaceSettings, connectionSettings } = useSettingsContext()
    const dependIds = generateDependIds(
        depend,
        interfaceSettings.current.settings
    )
    console.log(id)
    const addItem = (e: TargetedMouseEvent<HTMLButtonElement>) => {
        useUiContextFn.haptic()
        e.currentTarget.blur()
        const newItem: any = JSON.parse(
            JSON.stringify(
                id == "macros"
                    ? defaultMacro
                    : id == "pollingcmds"
                      ? defaultPolling
                      : id == "eventmacros"
                        ? defaultEventMacro
                        : defaultPanel
            )
        )
        newItem.id = generateUID()
        newItem.name += ` ${  newItem.id}`
        const formatedNewItem = formatItem(newItem, -1, id)
        formatedNewItem.editionMode = true
        formatedNewItem.newItem = true
        value.unshift(formatedNewItem)
        setValue(value)
    }

    useEffect(() => {
        //to update state when import- but why ?
        if (setValue) setValue(null, true)
    }, [value])

    useEffect(() => {
        let visible = checkDependencies(depend, interfaceSettings.current.settings, connectionSettings.current)
        if (document.getElementById(id))
            document.getElementById(id)!.style.display = visible
                ? "block"
                : "none"
        if (document.getElementById(`group-${  id}`))
            document.getElementById(`group-${  id}`)!.style.display = visible
                ? "block"
                : "none"
    }, [...dependIds])

    return (
        <fieldset
            id={id}
            class="fieldset-top-separator fieldset-bottom-separator field-group"
        >
            <legend>
                {!fixed && (
                    <ButtonImg
                        m2
                        label={
                            id == "macros"
                                ? T("S128")
                                : id == "pollingcmds"
                                  ? T("S207")
                                  : id == "eventmacros"
                                    ? T("S228")
                                    : T("S156")
                        }
                        tooltip
                        data-tooltip={
                            id == "macros"
                                ? T("S128")
                                : id == "pollingcmds"
                                  ? T("S207")
                                  : id == "eventmacros"
                                    ? T("S228")
                                    : T("S156")
                        }
                        icon={<Plus />}
                        onClick={addItem}
                    />
                )}
                {fixed && <label class="m-2">{T(label)}</label>}
            </legend>
            <div class="m-1" />
            <div class="items-group-content">
                {value &&
                    value.map((element, index, completeList) => {
                        return (
                            <ItemControl
                                itemData={element}
                                index={index}
                                completeList={completeList}
                                idList={id}
                                validationfn={validationfn}
                                setValue={setValue}
                                fixed={fixed}
                                sorted={sorted}
                                nodelete={nodelete}
                                editable={editable}
                            />
                        )
                    })}
            </div>
        </fieldset>
    )
}

export default ItemsList
