import assert from "node:assert/strict"
import test from "node:test"
import {
    requireWifiService,
    wifiServiceUnavailableMessage,
} from "../src/tabs/wifi/wifiService.ts"

test("WiFi service guard fails explicitly when the reactive service is unavailable", () => {
    assert.throws(
        () => requireWifiService(undefined),
        new RegExp(wifiServiceUnavailableMessage)
    )
})

test("WiFi service guard returns the available service", () => {
    const service = { send() {} }
    assert.equal(requireWifiService(service), service)
})
