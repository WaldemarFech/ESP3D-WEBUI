// src/targets/CNC/FluidNC/eventMacroGate.ts
//
// Pure fire-time decision for event-macro rules. Kept free of React/context
// imports so the real production logic can be exercised directly by the
// node:test suite (tests/eventMacroGate.test.mjs) instead of a re-implemented
// copy. eventMacros.ts feeds it the live tracked state and the current
// settings; this file only decides.

import { isTrustedEventUrl } from "../../../components/Helpers/http"
import type { MacroType } from "./macroExecution"

export interface GateRule {
    id: string
    event: string
    actiontype: "url" | "macro"
    action: string
    macroid: string
    urltrusted?: boolean
}

export interface GateMacro {
    action: string
    type: MacroType
}

export interface GateContext {
    // undefined = no connection state observed yet on this page load
    connected: boolean | undefined
    findMacro: (macroid: string) => GateMacro | undefined
}

export type GateDecision =
    | { fire: "url"; url: string }
    | { fire: "macro"; macro: GateMacro }
    // loud: a configuration error the user must notice (logged as error), as
    // opposed to an expected skip (not connected / not yet trusted)
    | { fire: false; reason: string; loud?: boolean }

// Macro types whose action is an HTTP request / page open rather than a
// controller command. A rule that triggers one of these is, in effect, a URL
// rule and must pass the same trust gate as actiontype "url".
const URL_MACRO_TYPES: ReadonlyArray<string> = ["URI", "URI_SILENT"]

export function isUrlMacroType(type: unknown): boolean {
    return typeof type === "string" && URL_MACRO_TYPES.includes(type)
}

// The URL a URL-type macro would actually request (legacy "[SILENT]" prefix
// stripped the same way Macros.tsx does before fetching).
export function macroTargetUrl(macro: GateMacro): string {
    const trimmed = String(macro.action || "").trim()
    return trimmed.startsWith("[SILENT]") ? trimmed.replace("[SILENT]", "").trim() : trimmed
}

// A pending settle/cooldown timer holds the rule snapshot from dispatch time.
// Before firing, re-resolve it against the CURRENT enabled rules: a rule that
// was deleted, disabled, or re-pointed to another event meanwhile must not
// fire; edits to its action/trust are picked up from the fresh copy.
export function resolveCurrentRule<R extends GateRule>(snapshot: GateRule, currentRules: R[]): R | undefined {
    const current = currentRules.find((r) => r.id === snapshot.id)
    if (!current || current.event !== snapshot.event) return undefined
    return current
}

export function evaluateFireGate(rule: GateRule, ctx: GateContext): GateDecision {
    // Only ws_disconnect is meant to act while the WebSocket is down (e.g. a
    // "cut power when the controller drops" rule). Everything else is derived
    // from live controller state and must not fire on stale state during an
    // outage or before the first connection was observed.
    if (rule.event !== "ws_disconnect" && ctx.connected !== true) {
        return { fire: false, reason: "not connected" }
    }

    if (rule.actiontype === "macro") {
        const macro = ctx.findMacro(rule.macroid)
        if (!macro) return { fire: false, reason: `referenced macro "${rule.macroid}" no longer exists`, loud: true }
        if (isUrlMacroType(macro.type)) {
            if (!isTrustedEventUrl(macroTargetUrl(macro))) {
                return { fire: false, reason: "referenced URL macro has no valid absolute HTTP(S) URL", loud: true }
            }
            if (rule.urltrusted !== true) {
                return { fire: false, reason: "rule references a URL macro but is not explicitly trusted" }
            }
        }
        return { fire: "macro", macro }
    }

    if (!isTrustedEventUrl(rule.action)) {
        return { fire: false, reason: "rejected URL action (needs a valid absolute HTTP(S) URL without credentials)", loud: true }
    }
    if (rule.urltrusted !== true) {
        return { fire: false, reason: "URL rule not explicitly trusted" }
    }
    return { fire: "url", url: rule.action }
}
