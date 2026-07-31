/*
importHelper.ts - ESP3D WebUI helper file

 Copyright (c) 2021 Alexandre Aussourd. All rights reserved.
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

// Item setting field
interface ItemSettingField {
    id: string;
    name?: string;
    value: any;
    initial: any;
    type?: string;
    label?: string;
    help?: string;
    shortkey?: boolean;
    min?: number | string;
    minsecondary?: number;
    step?: number;
    append?: string;
    options?: any[];
    newItem?: boolean;
    regexpattern?: string;
}

// Formatted item
export interface FormattedItem {
    id: string;
    index: number;
    value: ItemSettingField[];
    editionMode?: boolean;
    newItem?: boolean;
}

// Raw item data
export interface RawItemData {
    id: string;
    [key: string]: any;
}

// Preferences section structure
export interface PreferencesSection {
    [key: string]: any[];
}

// Import result interface
export interface ImportPreferencesResult {
    preferences: PreferencesSection;
    hasErrors: boolean;
}

/**
 * Event-macro "action" field's URL constraints - only apply when the rule's
 * actiontype is "url" (or unset, for rules saved before actiontype existed).
 * When actiontype is "macro", the action field is unused/hidden and must
 * carry no constraints, or its permanently-empty value would fail validation
 * for a field the user can't even see. Exported so ItemsList.tsx's live
 * actiontype toggle can reapply the exact same rule (formatItem only runs
 * once, at creation/import time, so it can't react to a later in-place edit).
 */
export function eventmacroUrlConstraints(actiontype: string | undefined): { min?: string; regexpattern?: string } {
    if (actiontype === "macro") return {}
    return { min: "1", regexpattern: "^https?://" }
}

/**
 * Formats an item data object.
 *
 * @param {Object} itemData - The item data object to format.
 * @param {number} [index=-1] - The index of the item.
 * @param {string} [origineId="extrapanels"] - The origin ID of the item.
 * @returns {Object} The formatted item object.
 */
function formatItem(itemData: RawItemData, index: number = -1, origineId: string = "extrapanels"): FormattedItem {
    const itemFormated: FormattedItem = {
        id: itemData.id,
        index: index,
        value: []
    }
    Object.keys(itemData).forEach((key) => {
        if (key != "id") {
            const newItem: ItemSettingField = {
                id: `${itemData.id}-${key}`,
                name: key,
                value: itemData[key],
                initial: itemData[key]
            }
            if (index == -1) newItem.newItem = true
            switch (key) {
                case "cmds":
                    newItem.type = "text"
                    newItem.label = "S115"
                    newItem.help = "S97"
                    break
                case "key":
                    newItem.type = "text"
                    newItem.label = "key"
                    newItem.shortkey = true
                    break
                case "name":
                    newItem.type = "text"
                    newItem.label = "S129"
                    break
                case "icon":
                    newItem.type = "icon"
                    newItem.label = "S132"
                    break
                case "refreshtime":
                    newItem.type = "number"
                    newItem.min = 0
                    newItem.minsecondary = 100
                    newItem.step = 100
                    newItem.append = "S114"
                    newItem.label = "S113"
                    break
                case "type":
                    newItem.type = "select"
                    newItem.label = "S135"
                    if (origineId == "macros") {
                        newItem.options = [
                            {
                                label: "S137",
                                value: "FS",
                                depend: [
                                    {
                                        id: "flashfs",
                                        value: true,
                                    },

                                    {
                                        connection_id: "FlashFileSystem",
                                        value: "!='none'",
                                    },
                                    {
                                        connection_id: "FWTargetID",
                                        value: "!='30'",
                                    },
                                ],
                            },
                            {
                                label: "S138",
                                value: "SD",
                                depend: [
                                    {
                                        ids: [
                                            {
                                                id: "sd",
                                                value: true,
                                            },
                                            {
                                                id: "directsd",
                                                value: true,
                                            },
                                            {
                                                id: "ext",
                                                value: true,
                                            },
                                            {
                                                id: "directsdext",
                                                value: true,
                                            },
                                            {
                                                id: "tftsd",
                                                value: true,
                                            },
                                        ],
                                    },
                                    {
                                        connection_id: "SDConnection",
                                        value: "!='none'",
                                    },
                                ],
                            },
                            { label: "S139", value: "URI" },
                            { label: "S226", value: "URI_SILENT" },
                            { label: "S140", value: "CMD" },
                        ]
                    } else {
                        newItem.options = [
                            { label: "S160", value: "image" },
                            { label: "S161", value: "content" },
                            { label: "S121", value: "extension" },
                            { label: "S162", value: "camera" },
                        ]
                    }
                    break
                case "target":
                    newItem.type = "select"
                    newItem.label = "S136"
                    newItem.options = [
                        { label: "S158", value: "page" },
                        { label: "S157", value: "panel" },
                    ]
                    break
                case "source":
                    newItem.type = "text"
                    newItem.label = "S139"
                    newItem.min = "2"
                    break
                case "actiontype":
                    newItem.type = "select"
                    newItem.label = "S247"
                    newItem.help = "S252"
                    newItem.options = [
                        { label: "S248", value: "url" },
                        { label: "S249", value: "macro" },
                    ]
                    break
                case "action":
                    newItem.type = "text"
                    if (origineId == "eventmacros") {
                        newItem.label = "S226"
                        // Only a "url"-typed rule actually uses this field -
                        // when actiontype is "macro" it's hidden (see
                        // ItemsList.tsx) and must NOT carry min/regexpattern,
                        // or its permanently-empty value trips haserror and -
                        // since checkSaveStatus() in this file scans ALL
                        // settings for any "haserror":true - can silently hide
                        // the Save button for the whole page, not just this
                        // row. Exported so ItemsList.tsx's live actiontype
                        // toggle (which can't re-run formatItem) can reapply
                        // the same rule without duplicating these values.
                        Object.assign(newItem, eventmacroUrlConstraints(itemData.actiontype))
                    } else {
                        newItem.min = "1"
                        newItem.label = "S159"
                    }
                    break
                case "macroid":
                    newItem.type = "select"
                    newItem.label = "S250"
                    // Only required when actiontype is "macro" - see the
                    // "action" case above for why this is conditional.
                    if (itemData.actiontype === "macro") {
                        newItem.min = "1"
                    }
                    // Options are NOT set here: the list of saved macros can
                    // change after this item was formatted (macro added/
                    // renamed/removed elsewhere), so ItemsList.tsx builds
                    // them fresh from current settings on every render
                    // instead of freezing a snapshot at format time.
                    newItem.options = []
                    break
                case "event":
                    newItem.type = "select"
                    newItem.label = "S229"
                    newItem.help = "S236"
                    // `title` is a raw translation id, same convention as `label` -
                    // both get translated in ItemsList.tsx's options-reduce before
                    // reaching Select.tsx, where `title` becomes the browser's native
                    // per-option hover tooltip. Text must match eventMacros.ts's
                    // conditionHolds()/dispatch() edges exactly - this is what actually
                    // triggers the event, not a guess.
                    newItem.options = [
                        { label: "FL13", value: "spindle_on", title: "FL23" },
                        { label: "FL14", value: "spindle_off", title: "FL24" },
                        { label: "FL15", value: "cycle_start", title: "FL25" },
                        { label: "FL16", value: "cycle_stop", title: "FL26" },
                        { label: "FL17", value: "hold", title: "FL27" },
                        { label: "FL18", value: "door_open", title: "FL28" },
                        { label: "FL19", value: "door_closed", title: "FL29" },
                        { label: "FL20", value: "alarm", title: "FL30" },
                        { label: "FL21", value: "ws_connect", title: "FL31" },
                        { label: "FL22", value: "ws_disconnect", title: "FL32" },
                    ]
                    break
                case "delay":
                    newItem.type = "number"
                    newItem.min = 0
                    newItem.step = 100
                    newItem.append = "S114"
                    newItem.label = "S230"
                    newItem.help = "S234"
                    break
                case "cooldownms":
                    newItem.type = "number"
                    newItem.min = 500
                    newItem.step = 500
                    newItem.append = "S114"
                    newItem.label = "S231"
                    newItem.help = "S235"
                    break
                case "enabled":
                    newItem.type = "boolean"
                    newItem.label = "S232"
                    break
                default:
                    newItem.type = "text"
                    newItem.label = key
            }
            itemFormated.value.push(newItem)
        }
    })
    return itemFormated
}

/**
 * Formats the items list.
 *
 * @param {Array} itemsList - The list of items to be formatted.
 * @param {string} origineId - The origin ID.
 * @returns {Array} - The formatted items list.
 */
function formatItemsList(itemsList: RawItemData[], origineId: string): FormattedItem[] {
    const formatedItems: FormattedItem[] = []
    itemsList.forEach((element, index) => {
        formatedItems.push(formatItem(element, index, origineId))
    })
    return formatedItems
}


/**
 * Formats the preferences section to add inital value when missing
 *
 * @param {Object} section - The preferences section to format.
 * @returns {Object} - The formatted settings.
 */
function formatPreferences(section: PreferencesSection): PreferencesSection {
    for (let key in section) {
        if (Array.isArray(section[key])) {
            for (let index = 0; index < section[key].length; index++) {
                if (section[key][index].type == "group") {
                    section[key][index].value.forEach((element: any, _index: number) => {
                        element.initial = element.value
                    })
                } else if (section[key][index].type == "list") {
                    section[key][index].nb = section[key][index].value.length
                    section[key][index].value = formatItemsList(
                        [...section[key][index].value],
                        section[key][index].id
                    )
                } else section[key][index].initial = section[key][index].value
            }
        }
    }
    return section
}

/**
 * Imports preferences into the current preferences data.
 * @param {Object} currentPreferencesData - The current preferences data section.
 * @param {Object} importedPreferences - The preferences to be imported section.
 * @returns {Array} An array containing a copy of preferences data section with imported data and a flag indicating if there were any errors during the import.
 */
function importPreferencesSection(
    currentPreferencesData: PreferencesSection,
    importedPreferences: Record<string, any>
): ImportPreferencesResult {
    let hasErrors = false;
    const currentPreferences: PreferencesSection = JSON.parse(JSON.stringify(currentPreferencesData));

    function updateElement(id: string, value: any): boolean {
        function traverse(obj: any): boolean {
            for (let key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    if (obj[key] && typeof obj[key] === 'object') {
                        if (obj[key].id === id) {
                            obj[key].value = value;
                            return true;
                        }
                        if (traverse(obj[key])) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        return traverse(currentPreferences);
    }

    if (importedPreferences) {
        for (let key in importedPreferences) {
            if (Object.prototype.hasOwnProperty.call(importedPreferences, key)) {
                if (!updateElement(key, importedPreferences[key])) {
                    hasErrors = true;
                    console.log("Error with ", key);
                }
            }
        }
    }

    return { preferences: currentPreferences, hasErrors };
}

export { importPreferencesSection, formatPreferences, formatItem }
