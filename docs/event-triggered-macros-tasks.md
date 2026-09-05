# Event-Triggered Silent Macros — Implementation Tasks

Full design rationale, caveats, and the complete file-by-file change list live in
[`event-triggered-macros-plan.md`](./event-triggered-macros-plan.md) (the Konklave-produced spec,
independently reviewed and rated "ready to implement"). This file exists only to reformat that spec
into discrete, sequentially-executable tasks for `subagent-driven-development`-style execution —
every fact below is copied verbatim from that spec, nothing new is introduced here.

## Global Constraints (apply to every task)

- Branch: `feat/event-triggered-macros`, based on `feat/silent-url-macro` (already has `URI_SILENT` +
  the reviewed `silentFetch`/`window.open` fixes). Work happens directly in
  `C:\Users\walde\Desktop\repos\public\ESP3D-WEBUI` on that branch — do not create a worktree, do not
  switch branches.
- No FluidNC firmware changes, ever. This is a WebUI-only feature.
- After every task: `npm run type-check` and `npm run build` must both pass clean before committing.
  `npm run lint` should also pass; if it doesn't and the failure is pre-existing/unrelated to this
  task's diff, note it in the report rather than fixing unrelated lint debt.
- Follow this repo's existing conventions exactly (see `CLAUDE.md` at the repo root for the
  three-layer target system, the translation merge-precedence gotcha, and numeric fields being
  string-typed in `preferences.json`) — do not introduce a new pattern where an existing one already
  covers the need.
- Small, focused commits — one commit per task (or a couple if a task naturally splits), clear
  messages. Do not commit unrelated changes.
- This is new, unreleased code (not yet merged upstream) — no backward-compatibility shims, no
  feature flags beyond the one specified (`enableeventmacros`), no dead code for "future" event types
  not in the specified list of 10.

---

## Task 1: Extract `silentFetch` into shared Helpers

**Goal:** move the existing `silentFetch` out of `Macros.tsx` into `src/components/Helpers/`, so both
the existing manual macros feature and the new engine (Task 2+) can call the same function. This must
be a **behavior-preserving relocation** for existing callers — zero functional change to the manual
`URI_SILENT` / `[SILENT]`-prefix macro paths.

**Current state** (verify against the actual file before editing — this is a summary, not a diff):
`silentFetch` currently lives as a private, unexported `const` inside `src/components/Panels/Macros.tsx`,
doing `fetch(uri, {method:"GET", mode:"cors", cache:"default"})` with `.then`/`.catch` that only
`console.log` success/failure, no timeout support.

**1a. Edit `src/components/Helpers/http.ts`** (existing file, already has `espHttpURL`/`getCookie`/
`isLimitedEnvironment` — add alongside them):

```ts
export interface SilentFetchOptions {
    timeoutMs?: number
    onSettled?: () => void   // called once the request resolves/rejects/times out, for in-flight tracking
}

// Fire a GET request in the background without opening/navigating a tab.
// Used by manual URI_SILENT / [SILENT] macros and by the event-macros engine.
// Ignores the response body; logs success/failure only. Behavior with no
// `options` argument is byte-identical to the pre-extraction implementation.
function silentFetch(uri: string, options?: SilentFetchOptions): void {
    const controller = options?.timeoutMs ? new AbortController() : undefined
    const timeoutHandle = controller
        ? setTimeout(() => controller.abort(), options!.timeoutMs)
        : undefined
    const myInit: RequestInit = {
        method: "GET",
        mode: "cors",
        cache: "default",
        ...(controller ? { signal: controller.signal } : {}),
    }
    fetch(uri, myInit)
        .then((response) => {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            console.log(response.ok ? "Request succeeded" : "Request failed")
        })
        .catch((error) => {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            console.log(`Request failed: ${error.message}`)
        })
        .finally(() => {
            options?.onSettled?.()
        })
}
```

Add `silentFetch` and the `SilentFetchOptions` type to this file's existing final export statement.

When called with no `options` (exactly how `Macros.tsx` will call it), `timeoutMs` is `undefined`, no
`AbortController` is created, and `myInit` is identical to the pre-extraction object — zero behavior
change for existing manual macros.

**1b. Edit `src/components/Helpers/index.ts`:** add `silentFetch` to the existing
`import { espHttpURL, getCookie, isLimitedEnvironment } from "./http"` line and to the barrel
`export { ... }` list; add `export type { SilentFetchOptions } from "./http"` alongside the other
re-exported types.

**1c. Edit `src/components/Panels/Macros.tsx`:**
- Delete the local `const silentFetch = (uri: string): void => { ... }` block.
- Add a new import: `import { silentFetch } from "../../components/Helpers"` (verify first whether this
  file already imports anything from `../../components/Helpers` — if so, add to that existing import
  instead of a new line).
- Leave both call sites untouched: the legacy `[SILENT]`-prefixed `URI` macro path and the `URI_SILENT`
  path both already call `silentFetch(...)` with a single string argument — that call shape doesn't
  change.

**Verification:**
- `npm run type-check`, `npm run build` clean.
- Read the diff yourself and confirm: the extracted function's logic is unchanged except for the
  additive `options` parameter; no existing call site's behavior changes.
- Do not attempt on-device testing for this task — it happens once, at the end, after Task 5 (see
  the plan's §10.2 test 1, which is the regression check for this exact extraction).

---

## Task 2: Build the `eventMacros.ts` engine module

**Goal:** a new, standalone TypeScript module implementing edge-detection across 10 machine events,
with a settle-delay, a cooldown floor, an in-flight guard, and two-mechanism reconciliation (cooldown
timer-based, in-flight event-based) so a genuinely dropped fire is never permanently lost. No React,
no hooks — pure functions and module-level state, called directly from three call sites wired in
Task 3.

**New file `src/targets/CNC/FluidNC/eventMacros.ts`.** This is the exact reference implementation from
the reviewed spec — implement it as written (the independent review re-verified this design is
internally consistent; do not redesign it):

```ts
// src/targets/CNC/FluidNC/eventMacros.ts

export type EventName =
    | "spindle_on" | "spindle_off"
    | "cycle_start" | "cycle_stop"
    | "hold" | "door_open" | "door_closed"
    | "alarm" | "ws_connect" | "ws_disconnect"

const FETCH_TIMEOUT_MS = 5000
const MIN_COOLDOWN_MS = 500

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

function readEnabledRules(): Array<{id:string; event:EventName; action:string; delay:number; cooldownms:number}> {
    if (!useUiContextFn.getValue("enableeventmacros")) return []
    const raw = useUiContextFn.getValue("eventmacros")
    if (!Array.isArray(raw)) return []
    return raw
        .map((item: any) => {
            const flat: Record<string, any> = {}
            ;(item.value || []).forEach((f: any) => { flat[f.name] = f.initial })
            return {
                id: item.id,
                event: flat.event as EventName,
                action: String(flat.action || "").trim(),
                enabled: !!flat.enabled,
                delay: Math.max(0, Number(flat.delay) || 0),
                cooldownms: Math.max(MIN_COOLDOWN_MS, Number(flat.cooldownms) || 0),
            }
        })
        .filter((r) => r.enabled && r.action.length > 0)
}

function tryFire(rule: {id:string; event:EventName; action:string; cooldownms:number}): void {
    if (!conditionHolds(rule.event)) return           // reverted since the timer was armed — drop silently
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

function scheduleCooldownReconcile(rule: {id:string; event:EventName; action:string; cooldownms:number}, waitMs: number): void {
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
```

Two imports this file needs that aren't shown above (add them): `silentFetch` from
`"../../components/Helpers"` (built in Task 1) and `useUiContextFn` from `"../../contexts"` (confirm
the exact relative path against how sibling files in `src/targets/CNC/FluidNC/` already import it,
e.g. `filters.ts`).

**Note on scope:** this task creates the module in isolation. It is not imported/called from anywhere
yet — that's Task 3. `npm run build` must still succeed with an unused-but-exported module (verify
there's no "unused export" lint rule that would fail here; if there is, that's expected and resolves
itself once Task 3 adds the imports — do not suppress it, just note it in your report if it fires).

**Verification:**
- `npm run type-check`, `npm run build` clean.
- Re-read `conditionHolds`, `tryFire`, `scheduleCooldownReconcile`, and the `onSettled` callback in
  `tryFire` together and confirm by inspection: a cooldown-blocked retry and an in-flight-blocked retry
  can never both be scheduled for the same rule in a way that double-fires (this is the property the
  design review specifically checked — confirm your transcription preserved it, don't just confirm it
  compiles).

---

## Task 3: Wire the engine into existing files

**Goal:** connect the Task 2 module to the app's three real data sources. Every insertion point below
is one or two lines inside an existing function — no new components, no provider-tree changes, no new
hooks.

**3a. Edit `src/targets/CNC/FluidNC/TargetContext.tsx`:**

Add import near the top:
```ts
import { ingestStatus, ingestAlarmFastPath } from "./eventMacros"
```

Find `dispatchInternally`'s `isStatus(data)` branch. Immediately after the existing
`if (response.sd) { setStreamStatus(response.sd) }` block (and before whatever comment/code follows
it), add:
```ts
                // Event-triggered silent macros: feed this tick's derived state/spindle
                // values to the edge-detection engine (see ./eventMacros.ts).
                ingestStatus(response.status?.state, response.rpm?.value)
```

Find the same function's `isAlarm(data)` branch. Immediately after the existing
`eventsList.emit("alarm", data)` line, add:
```ts
                ingestAlarmFastPath()
```

No other change to this file.

**3b. Edit `src/hooks/useWebSocketService.ts`:**

Add import:
```ts
import { ingestConnectionState } from "../targets/CNC/FluidNC/eventMacros"
```

Find the existing singleton-guarded block (`if (!webSocketServiceInstance) { ... }`) and its
`setConnectionStateListener` call. Extend the callback body — do not replace the existing
`connection.setConnectionState(state)` call, add alongside it:
```ts
            webSocketServiceInstance.setConnectionStateListener((state) => {
                connection.setConnectionState(state);
                ingestConnectionState(state.connected);
            });
```

Confirm by reading the surrounding code that this stays inside the singleton guard (registers once,
not once per component that calls the hook) — if the guard structure looks different from this
description when you actually open the file, stop and report `NEEDS_CONTEXT` rather than guessing.

**Verification:**
- `npm run type-check`, `npm run build` clean.
- No on-device test yet (needs Task 4's settings UI to actually enable/configure a rule) — defer to
  the end.

---

## Task 4: Settings schema and UI wiring

**Goal:** a new, opt-in "Event Macros" settings section — its own fieldset, not folded into the
existing "Macros" section — using this codebase's existing generic list-editor machinery. Default
disabled (`enableeventmacros: false`); existing installs must see zero behavior change until a user
opts in.

**4a. New file `src/components/Controls/Fields/def_eventmacro.json`:**
```json
{
    "id": "id",
    "name": "Event macro",
    "event": "spindle_on",
    "action": "",
    "delay": "300",
    "cooldownms": "3000",
    "enabled": true
}
```
(`delay`/`cooldownms` are strings — matches this codebase's numeric-field storage convention, e.g.
`def_polling.json`'s `"refreshtime": "0"`.)

**4b. Edit `src/targets/CNC/FluidNC/preferences.json`:** add a new top-level section, sibling of the
existing `"polling"` section, same tier, same shape:
```json
"eventmacros": [
    {
        "id": "enableeventmacros",
        "type": "boolean",
        "label": "S227",
        "help": "S233",
        "value": false
    },
    {
        "id": "eventmacros",
        "type": "list",
        "sorted": false,
        "label": "S228",
        "value": [],
        "depend": [{ "id": "enableeventmacros", "value": true }]
    }
]
```
(The `"label": "S228"` on the list item mirrors `pollingcmds`'s own `"label": "S115"` — added per the
independent review's note; harmless either way since it only renders when the list is `fixed:true`,
but keep it for consistency.)

**4c. Edit `src/components/Controls/Fields/ItemsList.tsx`:**

Add import: `import defaultEventMacro from "./def_eventmacro.json"`

Find the `addItem()` template-selection ternary (currently something like
`id == "macros" ? defaultMacro : id == "pollingcmds" ? defaultPolling : defaultPanel`) and extend it:
```ts
id == "macros"
    ? defaultMacro
    : id == "pollingcmds"
      ? defaultPolling
      : id == "eventmacros"
        ? defaultEventMacro
        : defaultPanel
```

Find the Add-button's `label` ternary and its `data-tooltip` ternary (two separate places, same
pattern) and extend **both** the same way, inserting an `id == "eventmacros" ? T("S228") :` branch
before the final `defaultPanel`-tier fallback. **Both ternaries must be updated** — an unhandled list
id here silently clones `defaultPanel`'s image/content/extension/camera fields onto a new row, which
then produces a corrupted, effectively broken settings row the first time a user tries to edit it. If
you update one ternary and not the other, this task is not done.

**4d. Edit `src/tabs/interface/importHelper.ts`, `formatItem()`:**

Add four new `case`s inside the existing `switch (key)` (after the existing `case "action":` block,
before `default:`):
```ts
case "event":
    newItem.type = "select"
    newItem.label = "S229"
    newItem.options = [
        { label: "FL13", value: "spindle_on" },
        { label: "FL14", value: "spindle_off" },
        { label: "FL15", value: "cycle_start" },
        { label: "FL16", value: "cycle_stop" },
        { label: "FL17", value: "hold" },
        { label: "FL18", value: "door_open" },
        { label: "FL19", value: "door_closed" },
        { label: "FL20", value: "alarm" },
        { label: "FL21", value: "ws_connect" },
        { label: "FL22", value: "ws_disconnect" },
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
```

And extend the existing `case "action":` block so the URL-shape validation (`regexpattern`) and label
only apply when this field belongs to the `eventmacros` list — read the existing `case "type":`
block's `origineId`-based branching first (it already does exactly this kind of per-list branching for
the macros-vs-extracontents case) and follow the same technique here rather than inventing a new one.
The `action` field for `eventmacros` should get a `regexpattern` requiring `http://` or `https://` (the
plan's spec left the exact regex to the implementer — a straightforward
`^https?://` anchored pattern is sufficient; do not over-engineer full URL validation) and a distinct
label (a translated string clarifying this is the target URL fired on trigger — reuse an existing
label id if one already fits, otherwise this needs its own `S`-numbered key, coordinate with Task 5).

**Verification:**
- `npm run type-check`, `npm run build` clean.
- Manual UI check (local dev server, `npm run dev`, no board needed for this part): open Settings →
  Interface, confirm a new "Event Macros" section appears with its own header, confirm the master
  toggle is off by default and the list is hidden until enabled, confirm adding a row shows the
  Trigger-event dropdown (even if it still shows raw `FL13` etc. labels until Task 5 adds
  translations — that's expected and fine at this point), confirm the row does *not* silently take on
  `defaultPanel`'s fields (this is the specific failure mode the plan calls out — if you see
  image/content/extension/camera-style fields instead of event/action/delay/cooldownms/enabled, the
  4c ternary edit was incomplete).

---

## Task 5: Translations

**Goal:** add every new translation key introduced by Tasks 4 (and the `action` field label from 4d,
if you needed a new one). English keys are the source of truth; German must be a complete, accurate
mirror — this repo's other 15 shipped language packs are intentionally left untouched (they already
fall back to English for gaps, e.g. the existing `FL1`-`FL12` keys).

**Before starting:** re-run the max-key check, in case unrelated work landed on this branch's base
since this task list was written:
```bash
grep -oE '"S[0-9]+"' src/targets/translations/en.json | sort -t S -k2 -n | tail -1
grep -oE '"FL[0-9]+"' src/targets/CNC/FluidNC/translations/en.json | sort -t L -k2 -n | tail -1
```
If the max differs from `S226` / `FL12`, renumber the new keys below accordingly (keep them
sequential) and use the new numbers consistently across 5a/5b/5c and wherever Task 4 referenced them
(`case "event"`'s `label`/`help` ids, `S227`-`S235`, `FL13`-`FL22`) — if you renumber, go back and fix
Task 4's already-written references to match, don't leave a mismatch.

**5a. `src/targets/translations/en.json`** (add after the current max `S*` key):
```json
"eventmacros": "Event Macros",
"S227": "Enable event macros",
"S228": "Add event macro",
"S229": "Trigger event",
"S230": "Confirm delay",
"S231": "Cooldown",
"S232": "Enabled",
"S233": "Fires a silent background HTTP GET when the selected machine event occurs. This is a network-dependent convenience feature, not a safety interlock — it requires this browser tab to stay open and connected, and does nothing during a WebSocket outage. If you keep the WebUI open on more than one device, avoid TOGGLE-style target URLs; prefer explicit ON/OFF endpoints.",
"S234": "Wait this long after the event, then re-check it still holds, before firing. Also usable as an intentional delay — e.g. keep a vacuum running briefly after the spindle stops.",
"S235": "Minimum time between two firings of this rule (500 ms floor, enforced)."
```

**5b. `src/targets/CNC/FluidNC/translations/en.json`** (add after the current max `FL*` key):
```json
"FL13": "Spindle turns on",
"FL14": "Spindle turns off",
"FL15": "Cycle start (Idle to Run)",
"FL16": "Cycle stop (Run to Idle)",
"FL17": "Feed hold entered",
"FL18": "Safety door opened",
"FL19": "Safety door closed",
"FL20": "Alarm triggered",
"FL21": "WebUI connected",
"FL22": "WebUI disconnected"
```

**5c. `languages/lang-de.json`** (mirror both sets):
```json
"eventmacros": "Ereignis-Makros",
"S227": "Ereignis-Makros aktivieren",
"S228": "Ereignis-Makro hinzufügen",
"S229": "Auslöseereignis",
"S230": "Bestätigungsverzögerung",
"S231": "Sperrzeit",
"S232": "Aktiviert",
"S233": "Löst im Hintergrund einen stillen HTTP-GET aus, wenn das gewählte Maschinenereignis eintritt. Dies ist eine netzwerkabhängige Komfortfunktion, kein Sicherheitsschalter – der Browser-Tab muss geöffnet und verbunden bleiben, bei einem WebSocket-Ausfall passiert nichts. Wenn die WebUI auf mehreren Geräten gleichzeitig geöffnet ist, vermeiden Sie TOGGLE-Endpunkte und bevorzugen Sie explizite EIN/AUS-Endpunkte.",
"S234": "Nach dem Ereignis so lange warten, den Zustand erneut prüfen und erst dann auslösen. Auch als bewusste Verzögerung nutzbar – z. B. den Staubsauger nach dem Spindelstopp noch kurz weiterlaufen lassen.",
"S235": "Mindestzeit zwischen zwei Auslösungen dieser Regel (Untergrenze 500 ms, erzwungen).",
"FL13": "Spindel startet",
"FL14": "Spindel stoppt",
"FL15": "Zyklusstart (Idle zu Run)",
"FL16": "Zyklusende (Run zu Idle)",
"FL17": "Vorschub-Halt aktiviert",
"FL18": "Schutztür geöffnet",
"FL19": "Schutztür geschlossen",
"FL20": "Alarm ausgelöst",
"FL21": "WebUI verbunden",
"FL22": "WebUI getrennt"
```

Also add German text for whatever new `action`-field label key Task 4d introduced, if it wasn't
already one of the keys above — check Task 4's actual diff for this.

**Verification:**
- `npm run type-check`, `npm run build` clean.
- Check whether `package.json` has a translation-lockstep checker (`grep -i checkpack package.json`)
  — if `config/checkpack.js` exists, run it against `languages/lang-de.json`:
  `node ./config/checkpack.js reference=src/targets/translations/en.json target=languages/lang-de.json`
  and separately against the FluidNC-tier file if the script supports a second reference file; fix any
  reported mismatch before considering this task done.
- Manual UI check (local dev server): switch language to German in Settings, confirm the new section
  header, field labels, dropdown options, and help text all render translated text — not raw `S*`/`FL*`
  keys and not the literal string `eventmacros`.

---

## After Task 5: on-device validation (not a subagent task — coordinate directly)

Once all 5 tasks are reviewed and merged into this branch: `npm run build`, upload `dist/index.html.gz`
to the test board's flash filesystem (the established workflow — see this repo's `CLAUDE.md`), hard
refresh, and work through the full test list in
[`event-triggered-macros-plan.md`](./event-triggered-macros-plan.md) §10.2 (13 numbered scenarios,
covering regression, the settings UI, the master switch, off-delay timing, hold/alarm noise rejection,
cooldown + in-flight guard + reconciliation, cycle-start/stop semantics and the door-resume
interaction, the alarm fast path, WebSocket connect/disconnect, an unreachable target, multiple rules
per event, and the documented multi-tab caveat). This is manual, on-device, human/controller-driven
work — not something to dispatch to an implementer subagent.
