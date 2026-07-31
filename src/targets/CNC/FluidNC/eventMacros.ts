// src/targets/CNC/FluidNC/eventMacros.ts
//
// Event-triggered macros engine: edge-detection across machine events
// (spindle/cycle/hold/door/alarm/ws-connect), firing an action when a rule's
// event transitions from not-holding to holding, with a settle-delay, a
// cooldown floor, an in-flight guard, and two-mechanism reconciliation
// (cooldown timer-based, in-flight event-based) so a genuinely dropped fire
// is never permanently lost. No React, no hooks - pure functions and
// module-level state, called directly from the call sites wired in Task 3
// (TargetContext.tsx / useWebSocketService.ts).
//
// A rule's action is either a silent background HTTP GET (via silentFetch,
// actiontype "url" - the original/default behavior), or triggering an
// already-saved Macro of any type - FS/SD/URI/URI_SILENT/CMD (actiontype
// "macro"). The macro-running capability itself can't live here directly -
// FS/SD/CMD need sendCommand, which needs React hooks - so it's pushed in
// once via registerMacroRunner() by an always-mounted component
// (ConnectionManager, see its own comment for why it - not
// TargetContextProvider - is the registration point), same push pattern as
// this file's own ingestStatus/ingestAlarmFastPath being called from
// TargetContext.tsx.

import { silentFetch } from "../../../components/Helpers"
import { useUiContextFn } from "../../../contexts"
import type { MacroType } from "./macroExecution"

export type EventName =
    | "spindle_on" | "spindle_off"
    | "cycle_start" | "cycle_stop"
    | "hold" | "door_open" | "door_closed"
    | "alarm" | "ws_connect" | "ws_disconnect"

const FETCH_TIMEOUT_MS = 5000
const MIN_COOLDOWN_MS = 500

type ActionType = "url" | "macro"

interface Rule {
    id: string
    event: EventName
    actiontype: ActionType
    action: string      // used when actiontype == "url"
    macroid: string      // used when actiontype == "macro"
    delay: number
    cooldownms: number
}

// ---- macro runner registration: pushed once from ConnectionManager (always
// mounted - see this file's header comment for why), same shape as the
// Macros panel's own sendCommand-backed processMacro. ----
let macroRunner: ((action: string, type: MacroType) => void) | undefined
export function registerMacroRunner(fn: (action: string, type: MacroType) => void): void {
    macroRunner = fn
}

// ---- live tracked values (updated on every tick, read live at fire-time) ----
let trackedState: string | undefined          // undefined until first tick: seed only, never fires
let trackedSpindleOn: boolean | undefined
let trackedConnected: boolean | undefined

// ---- per-rule bookkeeping, keyed by rule id ----
interface RuleRuntime {
    settleTimer: ReturnType<typeof setTimeout> | null
    lastFireStart: number              // 0 = never fired
    inFlight: boolean
    retryOnSettle: boolean             // in-flight-blocked retry: event-driven, resolved by onSettled
    cooldownReconcileScheduled: boolean // cooldown-blocked retry: timer-driven, coalesced to at most one
}
const runtime = new Map<string, RuleRuntime>()

function getRuntime(id: string): RuleRuntime {
    let r = runtime.get(id)
    if (!r) {
        r = { settleTimer: null, lastFireStart: 0, inFlight: false, retryOnSettle: false, cooldownReconcileScheduled: false }
        runtime.set(id, r)
    }
    return r
}

// ---- condition check: does the CURRENT tracked state satisfy this event? ----
function conditionHolds(event: EventName): boolean {
    switch (event) {
        case "spindle_on":    return trackedSpindleOn === true
        case "spindle_off":   return trackedSpindleOn === false
        case "cycle_start":   return trackedState === "Run"
        case "cycle_stop":    return trackedState === "Idle"
        case "hold":          return trackedState === "Hold"
        case "door_open":     return trackedState === "Door"
        case "door_closed":   return trackedState !== "Door" && trackedState !== undefined
        case "alarm":         return trackedState === "Alarm"
        case "ws_connect":    return trackedConnected === true
        case "ws_disconnect": return trackedConnected === false
        default: return false
    }
}

function readEnabledRules(): Rule[] {
    if (!useUiContextFn.getValue("enableeventmacros")) return []
    const raw = useUiContextFn.getValue("eventmacros")
    if (!Array.isArray(raw)) return []
    return raw
        .map((item: any) => {
            const flat: Record<string, any> = {}
            ;(item.value || []).forEach((f: any) => { flat[f.name] = f.initial })
            // "macro" only if explicitly set - legacy rules saved before this
            // field existed have no actiontype at all and must keep behaving
            // exactly as before (a plain URL rule).
            const actiontype: ActionType = flat.actiontype === "macro" ? "macro" : "url"
            return {
                id: item.id,
                event: flat.event as EventName,
                actiontype,
                action: String(flat.action || "").trim(),
                macroid: String(flat.macroid || "").trim(),
                enabled: !!flat.enabled,
                delay: Math.max(0, Number(flat.delay) || 0),
                cooldownms: Math.max(MIN_COOLDOWN_MS, Number(flat.cooldownms) || 0),
            }
        })
        .filter((r) => r.enabled && (r.actiontype === "macro" ? r.macroid.length > 0 : r.action.length > 0))
}

// Reads the CURRENT macros list fresh every call (not a copy taken when the
// rule was created/edited) - a rule always fires whatever the referenced
// macro is configured as right now. Same flattening as the Macros panel's
// own uisettings.getValue("macros") reduce (see Macros.tsx).
function findMacroById(macroid: string): { action: string; type: MacroType } | undefined {
    const macroList = useUiContextFn.getValue("macros")
    if (!Array.isArray(macroList)) return undefined
    const item = macroList.find((m: any) => m.id === macroid)
    if (!item) return undefined
    const flat: Record<string, any> = {}
    ;(item.value || []).forEach((f: any) => { flat[f.name] = f.initial })
    return { action: String(flat.action || ""), type: flat.type as MacroType }
}

function tryFire(rule: Rule): void {
    if (!conditionHolds(rule.event)) return           // reverted since the timer was armed - drop silently
    const rt = getRuntime(rule.id)

    if (rt.inFlight) {
        console.log(`[EventMacros] "${rule.id}": previous request still in flight, skipped`)
        rt.retryOnSettle = true                        // coalesced: already true is a no-op
        return
    }

    const now = Date.now()
    const remaining = rule.cooldownms - (now - rt.lastFireStart)
    if (remaining > 0) {
        console.log(`[EventMacros] "${rule.id}": cooldown active, skipped`)
        scheduleCooldownReconcile(rule, remaining)
        return
    }

    if (rule.actiontype === "macro") {
        fireMacro(rule, rt, now)
        return
    }

    rt.lastFireStart = now
    rt.inFlight = true
    silentFetch(rule.action, {
        timeoutMs: FETCH_TIMEOUT_MS,
        onSettled: () => {
            rt.inFlight = false
            if (rt.retryOnSettle) {
                rt.retryOnSettle = false
                tryFire(rule)                           // re-samples LIVE truth; may now hit the cooldown branch instead
            }
        },
    })
}

// Macro-type rules have no single async request to key an in-flight guard
// off of - executeMacroAction() dispatches one or more fire-and-forget
// sendCommand/silentFetch calls (CMD/SD can be several commands at once),
// with no unified "the whole macro settled" signal. Treated as synchronous,
// like a manual click of the macro's own button: the cooldown floor still
// applies (via lastFireStart below), but there's nothing to hold inFlight
// open for.
function fireMacro(rule: Rule, rt: RuleRuntime, now: number): void {
    const macro = findMacroById(rule.macroid)
    if (!macro) {
        // no silent fallbacks: a rule whose target macro was deleted must be
        // loud about it, not just quietly do nothing.
        console.error(`[EventMacros] "${rule.id}": referenced macro "${rule.macroid}" no longer exists, skipped`)
        return
    }
    if (!macroRunner) {
        console.error(`[EventMacros] "${rule.id}": macro runner not registered yet, skipped`)
        return
    }
    rt.lastFireStart = now
    macroRunner(macro.action, macro.type)
}

function scheduleCooldownReconcile(rule: Rule, waitMs: number): void {
    const rt = getRuntime(rule.id)
    if (rt.cooldownReconcileScheduled) return          // coalesce: at most one pending cooldown reconcile per rule
    rt.cooldownReconcileScheduled = true
    setTimeout(() => {
        rt.cooldownReconcileScheduled = false
        tryFire(rule)                                   // re-samples LIVE truth, not a replay of the dropped edge
    }, waitMs + 50)                                      // +50ms slack past the boundary
}

function armSettle(ruleId: string, delayMs: number, fire: () => void): void {
    const rt = getRuntime(ruleId)
    if (rt.settleTimer) clearTimeout(rt.settleTimer)    // cancel-and-reschedule, no timer accumulation
    rt.settleTimer = setTimeout(() => { rt.settleTimer = null; fire() }, delayMs)
}

function dispatch(event: EventName): void {
    readEnabledRules()
        .filter((r) => r.event === event)
        .forEach((rule) => armSettle(rule.id, rule.delay, () => tryFire(rule)))
}

// ---- public ingest functions, called from TargetContext.tsx / useWebSocketService.ts (Task 3) ----
export function ingestStatus(state: string | undefined, rpm: string | number | undefined): void {
    const prevState = trackedState
    const prevSpindleOn = trackedSpindleOn

    if (typeof state === "string" && state.length > 0) trackedState = state
    if (typeof rpm !== "undefined") {
        const n = typeof rpm === "string" ? parseFloat(rpm) : rpm
        if (!Number.isNaN(n)) trackedSpindleOn = n > 0
    }

    if (prevState !== undefined && prevState !== trackedState) {
        if (prevState === "Idle" && trackedState === "Run") dispatch("cycle_start")
        if (prevState === "Run" && trackedState === "Idle") dispatch("cycle_stop")
        if (trackedState === "Hold" && prevState !== "Hold") dispatch("hold")
        if (trackedState === "Door" && prevState !== "Door") dispatch("door_open")
        if (prevState === "Door" && trackedState !== "Door") dispatch("door_closed")
        if (trackedState === "Alarm" && prevState !== "Alarm") dispatch("alarm")
    }
    if (prevSpindleOn !== undefined && prevSpindleOn !== trackedSpindleOn) {
        dispatch(trackedSpindleOn ? "spindle_on" : "spindle_off")
    }
}

// Fast path: called from the isAlarm(data) branch, in addition to ingestStatus above.
export function ingestAlarmFastPath(): void {
    const prevState = trackedState
    trackedState = "Alarm"
    if (prevState !== undefined && prevState !== "Alarm") dispatch("alarm")
}

export function ingestConnectionState(connected: boolean): void {
    const prev = trackedConnected
    trackedConnected = connected
    if (prev === undefined) return    // first observation on this page load: seed only, never fires.
    if (prev !== connected) dispatch(connected ? "ws_connect" : "ws_disconnect")
}
