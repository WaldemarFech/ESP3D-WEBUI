import assert from "node:assert/strict"
import test from "node:test"
import { ensureSharedDistanceKeys } from "../src/Settings/keymapMigration.ts"

const keyEntry = (key) => ({ name: "key", value: key, initial: key })
const nameEntry = (name) => ({ name: "name", value: name, initial: name })
const entry = (id, key) => ({
    id,
    index: 0,
    value: key === undefined ? [nameEntry(id)] : [nameEntry(id), keyEntry(key)],
})

test("old keymap without Z distance actions inherits the XY +/- keys", () => {
    const oldKeymap = [entry("btndistSel+", "+"), entry("btndistSel-", "-")]

    const migrated = ensureSharedDistanceKeys(oldKeymap)

    const zPlus = migrated.find((e) => e.id == "btndistSelZ+")
    const zMinus = migrated.find((e) => e.id == "btndistSelZ-")
    assert.ok(zPlus, "btndistSelZ+ should be added")
    assert.ok(zMinus, "btndistSelZ- should be added")
    assert.equal(zPlus.value.find((s) => s.name == "key").value, "+")
    assert.equal(zMinus.value.find((s) => s.name == "key").value, "-")
})

test("existing Z distance bindings are never overwritten", () => {
    const keymap = [
        entry("btndistSel+", "+"),
        entry("btndistSel-", "-"),
        entry("btndistSelZ+", "5"),
        entry("btndistSelZ-", "."),
    ]

    const migrated = ensureSharedDistanceKeys(keymap)

    const keyOf = (id) =>
        migrated.find((e) => e.id == id).value.find((s) => s.name == "key").value
    assert.equal(keyOf("btndistSelZ+"), "5")
    assert.equal(keyOf("btndistSelZ-"), ".")
    assert.equal(migrated.length, 4)
})

test("keymap with shared bindings already present is returned unchanged", () => {
    const keymap = [
        entry("btndistSel+", "+"),
        entry("btndistSel-", "-"),
        entry("btndistSelZ+", "+"),
        entry("btndistSelZ-", "-"),
    ]

    assert.equal(ensureSharedDistanceKeys(keymap), keymap)
})

test("non-array and malformed inputs pass through untouched", () => {
    assert.equal(ensureSharedDistanceKeys(undefined), undefined)
    const passthrough = {}
    assert.equal(ensureSharedDistanceKeys(passthrough), passthrough)
    assert.deepEqual(ensureSharedDistanceKeys([]), [])
    assert.deepEqual(ensureSharedDistanceKeys([{ id: "btn+X", value: [] }]), [
        { id: "btn+X", value: [] },
    ])
})

test("unbound XY actions do not create Z bindings", () => {
    const keymap = [entry("btndistSel+", undefined), entry("btndistSel-", undefined)]

    const migrated = ensureSharedDistanceKeys(keymap)

    assert.equal(migrated.length, 2)
    assert.equal(migrated.find((e) => e.id == "btndistSelZ+"), undefined)
})
