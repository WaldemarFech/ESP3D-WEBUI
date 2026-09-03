/*
 Copyright (c) 2025 Mike Melancon. All rights reserved.

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

/**
 * Keymap migration helpers.
 *
 * Devices store their own preferences.json; devices saved by older
 * builds have no binding for the Z jog-distance shortcuts. The keyboard
 * dispatcher intentionally supports one key bound to several actions
 * (XY + Z distance share +/-), so a stored keymap that only binds the
 * XY actions is upgraded by inheriting the XY key onto the missing Z
 * action. Entries that already exist are never modified.
 */

interface KeymapEntry {
    id: string
    [key: string]: any
}

const distanceShortcutPairs: Array<[string, string]> = [
    ["btndistSel+", "btndistSelZ+"],
    ["btndistSel-", "btndistSelZ-"],
]

const hasKeyBinding = (entry: KeymapEntry | undefined): boolean => {
    if (!entry || !Array.isArray(entry.value)) return false
    return entry.value.some(
        (sub: any) => sub && sub.name == "key" && typeof sub.value == "string" && sub.value.length > 0
    )
}

const entryKey = (entry: KeymapEntry | undefined): string | undefined => {
    if (!entry || !Array.isArray(entry.value)) return undefined
    const sub = entry.value.find((s: any) => s && s.name == "key")
    return typeof sub?.value == "string" && sub.value.length > 0 ? sub.value : undefined
}

const cloneEntry = (entry: KeymapEntry, id: string): KeymapEntry => ({
    ...entry,
    id,
    value: (entry.value || []).map((sub: any) => ({ ...sub })),
})

/**
 * Returns a migrated keymap array. When the source is not an array it is
 * returned unchanged. Missing Z distance actions inherit the key of their
 * XY counterpart so +/- adjust XY and Z simultaneously.
 */
const ensureSharedDistanceKeys = (keymap: unknown): unknown => {
    if (!Array.isArray(keymap)) return keymap
    const entries = keymap as KeymapEntry[]
    let changed = false
    const result = [...entries]

    for (const [xyId, zId] of distanceShortcutPairs) {
        const xyEntry = result.find((entry) => entry && entry.id == xyId)
        const zEntry = result.find((entry) => entry && entry.id == zId)
        if (!xyEntry || zEntry) continue
        const key = entryKey(xyEntry)
        if (!key) continue
        const newEntry = cloneEntry(xyEntry, zId)
        newEntry.value = newEntry.value.filter((sub: any) => sub.name != "key")
        newEntry.value.push({ name: "key", value: key, initial: key })
        result.push(newEntry)
        changed = true
    }

    return changed ? result : keymap
}

export { ensureSharedDistanceKeys, hasKeyBinding }
