import assert from "node:assert/strict"
import test from "node:test"
import { importTypeScript } from "./typescript-loader.mjs"

const { createModalStore } = await importTypeScript("../src/contexts/ModalStore.ts")

const createIds = (...ids) => {
    let index = 0
    return () => ids[index++] ?? `generated-${index}`
}

test("same-turn duplicate semantic modal opens keep one concrete instance", () => {
    const store = createModalStore(createIds("instance-a", "instance-b"))

    const firstInstanceId = store.add({ id: "progression", content: "first" })
    const duplicateInstanceId = store.add({ id: "progression", content: "duplicate" })

    assert.equal(firstInstanceId, "instance-a")
    assert.equal(duplicateInstanceId, undefined)
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].id, "progression")
    assert.equal(store.list()[0].instanceId, firstInstanceId)
    assert.equal(store.list()[0].content, "first")
})

test("a stale completion cannot remove a newer modal with the same semantic id", () => {
    const store = createModalStore(createIds("instance-old", "instance-new"))

    const oldInstanceId = store.add({ id: "progression", content: "old" })
    assert.ok(oldInstanceId)
    assert.equal(store.removeByInstanceId(oldInstanceId), true)

    const newInstanceId = store.add({ id: "progression", content: "new" })
    assert.ok(newInstanceId)
    assert.notEqual(newInstanceId, oldInstanceId)

    assert.equal(store.removeByInstanceId(oldInstanceId), false)
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].id, "progression")
    assert.equal(store.list()[0].instanceId, newInstanceId)
    assert.equal(store.list()[0].content, "new")

    assert.equal(store.removeByInstanceId(newInstanceId), true)
    assert.deepEqual(store.list(), [])
})
