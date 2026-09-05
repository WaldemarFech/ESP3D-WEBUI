# Event-Triggered Silent Macros for ESP3D-WEBUI (FluidNC)

This plan adds a new, opt-in feature: automatically firing a silent background HTTP GET (reusing the existing `silentFetch` mechanism) when a FluidNC machine event/state-transition occurs, with no user click needed. Motivating use case: auto-switching a WiFi smart plug that powers a shop-vac/dust-extractor based on spindle state, cycle state, door state, or alarm state. All facts below (file paths, line numbers, wire formats, provider structure) were verified directly against the checked-out source of both repos — `ESP3D-WEBUI` on `feat/silent-url-macro` and `FluidNC` at the current working-tree commit — not assumed from memory or from prior drafts of this plan.

---

## 0. Grounding (verified facts this plan depends on)

**Provider nesting** (`src/components/App/index.tsx`):
```
DatasContextProvider > TargetContextProvider > RouterContextProvider > UiContextProvider >
  HttpQueueContextProvider > SettingsContextProvider > ToastsContextProvider > ModalsContextProvider >
    [ConnectionManager, ContainerHelper, ElementsCache, ContentContainer]
```
`TargetContextProvider` is an **ancestor** of `UiContextProvider`. This matters because the event-detection engine needs to hook into `TargetContext.tsx` (which renders *outside* `UiContextProvider`) but also needs to read live settings (which live *inside* `UiContextProvider`). Calling the `useUiContext()` React hook directly from `TargetContextProvider`'s component body would crash (hook called outside its provider's subtree) or silently read stale/default context. The safe mechanism is the **`useUiContextFn.getValue` escape hatch**: a plain object populated imperatively by `UiContext.tsx:295` (`useUiContextFn.getValue = getValue`), readable from anywhere in the app once `UiContextProvider` has rendered at least once, entirely independent of React's component tree. This is not a new pattern invented for this feature — `src/targets/CNC/FluidNC/filters.ts:210` already does exactly this (`useSettingsContextFn.getValue("Axisletters")`) from the same kind of non-hook, hot-path context (the WebSocket message parser). This plan's engine uses the same escape hatch for the identical reason.

**WebSocket connection-state singleton** (`src/hooks/useWebSocketService.ts`): `webSocketServiceInstance` is a **module-level singleton**, created and wired up exactly once inside `if (!webSocketServiceInstance) { ... }` (lines 26-89), even though three separate components (`Navbar`, the `about` page, the `features` tab) call the `useWebSocketService()` hook. `webSocketServiceInstance.setConnectionStateListener((state) => { connection.setConnectionState(state) })` (lines 64-66) is registered **once**, deterministically, regardless of how many components mount the hook. This makes it a safe, single-registration hook point for `ws_connect`/`ws_disconnect` detection — no new dedicated component is needed, a two-line addition to the existing callback suffices.

**Status-stream parse hook** (`src/targets/CNC/FluidNC/TargetContext.tsx`, `dispatchInternally`):
- The `isStatus(data)` branch (line 124 onward) reads `response.status.state` and `response.rpm.value` out after `getStatus(data)`. The insertion point this plan uses is immediately after the existing `if (response.sd) { setStreamStatus(response.sd) }` block (lines 210-212) and before the `//more to set+` comment (line 213).
- A second, faster path exists and is also hooked by this plan: `isAlarm(data)` (lines 217-224) fires immediately off a raw `ALARM:<code>` real-time message — `eventsList.emit("alarm", data)` at line 223 — independently of, and typically *before*, the next periodic `<...>` status line. Hooking only the periodic-status path would leave the alarm trigger slower than the firmware's fastest available signal for no reason; this plan hooks **both** call sites (§5).

**Wire format** (`FluidNC/src/Report.cpp`, `state_name()` and `report_realtime_status()`):
- `State::Cycle` → wire string `"Run"` (**not** `"Cycle"`). The verified wire vocabulary used throughout this plan is: `Idle, Run, Hold:0/1, Jog, Home, Alarm, Check, Door:0..3, Sleep, Starting`.
- `State::Critical`, `State::ConfigAlarm`, and `State::Alarm` **all** map to the wire string `"Alarm"` — an `alarm` rule triggered off the `state` field catches all three C++ states, which is strictly more robust than relying solely on the `ALARM:n` real-time line (which may not fire for `ConfigAlarm`/`Critical`, both of which are communicated primarily via `[MSG:...]` text per the firmware source).
- `msg << "|FS:" << rate << "," << sys.spindle_speed();` (line 533) is **unconditional** — every single status report carries spindle RPM. Confirmed on the WebUI side too: `src/targets/CNC/FluidNC/filters.ts`'s `getStatus()` initializes `res.f = {}`/`res.rpm = {}` as always-truthy objects and populates `res.rpm.value` from the `fs_patern` match, so `TargetContext.tsx`'s existing `if (response.f) { ... }` gate (line 197) is unconditionally true on every tick. Spindle-edge detection can rely on `response.rpm.value` being present on every status tick.
- `status_pattern = /<(?<state>[^:|]+):*(?<code>[^\|:]*)\|/i` already strips the `:code` suffix — `response.status.state` is always one of the bare words above; sub-codes (`Door:0..3`, `Hold:0/1`) never need to be parsed by this feature's detection layer.
- Safety-door: `SafetyDoor` state only transitions back to `Run`/`Idle` once FluidNC's own retract/restore sequence completes (`Door:2` retracting → `Door:3` restoring → exits `Door`), not the instant the physical door pin releases (that raw GPIO bit is separately surfaced as `Pn:D`, independent of the state machine). This plan deliberately triggers `door_closed` off the **state-machine** transition, not the raw pin — see §3 for the safety reasoning.

**Settings/list machinery**:
- `src/tabs/interface/index.tsx`'s `InterfaceTab` renders every key of `interfaceSettings.current.settings` generically (`Object.keys(...).map(sectionId => ...)`, line ~470), with the section header via `T(sectionId)` using the section's literal, unprefixed key as the translation id (e.g. `en.json["polling"] === "Polling"`). A brand-new top-level `preferences.json` section needs **no new page/component code** — it appears automatically.
- `src/components/Controls/Fields/ItemsList.tsx`'s `addItem()` (lines 372-391) and its Add-button label/tooltip (lines 419-433) both hardcode a ternary keyed on the list's `id`: `id == "macros" ? defaultMacro : id == "pollingcmds" ? defaultPolling : defaultPanel`. **Any new list id not added to both ternaries silently clones the wrong template** (`defaultPanel`: image/content/extension/camera fields), corrupting the row's data shape on first edit. Both branches must be extended (§7.3).
- `src/tabs/interface/importHelper.ts`'s `formatItem()` (lines 74-213) is a `switch(key)` on the raw field name, shared by every list type; it already branches per-list via `origineId` for the `"type"` case (macros vs extracontents) — real precedent for the same technique this plan uses for the `"action"` field.
- `src/tabs/interface/index.tsx`'s validation (`generateValidationGlobal`, lines ~174-181) already reads `fieldData.regexpattern` off any text field and applies it generically — no new validation code needed for URL-shape checking.
- Numeric-field convention: `def_polling.json`'s `"refreshtime": "0"` and the shipped `src/targets/CNC/FluidNC/preferences.json`'s `"refreshtime": "1500"` are both **strings**. New numeric-field templates in this codebase must follow this convention.
- `src/targets/CNC/FluidNC/preferences.json` already has a `"polling"` top-level section (lines 52-79: `enablepolling` boolean + `pollingcmds` list, `depend`-gated) — this is the direct template this plan's `eventmacros` section follows, at the same FluidNC tier.
- `exportHelper.ts::exportPreferencesSection()` is fully generic over any `type:"list"` section — no changes needed there for save/round-trip.

**Translations** (counts re-verified directly against the current files, not assumed):
```
src/targets/translations/en.json:              222 "S*" keys, max S226
src/targets/CNC/translations/en.json:          104 "CN*" keys, max CN200, real gap CN114-CN199 unused
src/targets/CNC/FluidNC/translations/en.json:  max FL12
languages/lang-de.json:  222 "S*" keys (matches base exactly) | 103 "CN*" keys, translated | 0 "FL*" keys
```
So: 103 `CN*` keys are genuinely translated into German today (there is no "CN is English-only" convention to lean on), and zero `FL*` keys exist in `lang-de.json` or any other shipped language pack — `FL1`-`FL12` are English-only today simply because that namespace is small/recent, not because of any documented policy (this looks like a translation backlog, matching the also-unexplained `CN114`-`CN199` gap). This plan's own choice, stated plainly rather than by appeal to a fabricated precedent: **new `S*` and `FL*` keys both get German translations**, extending the actual (imperfect but real) convention of keeping `lang-de.json` in lockstep with the English source files. `T()`'s confirmed fallback-to-English (`src/components/Translations/index.ts`, `baseLangRessource` fallback) means nothing breaks even if a translation is later found to be missing.

---

## 1. Scope decisions

| Question | Decision | Why |
|---|---|---|
| Which events ship? | **All 10** candidates from the brief: `spindle_on`, `spindle_off`, `cycle_start`, `cycle_stop`, `hold`, `door_open`, `door_closed`, `alarm`, `ws_connect`, `ws_disconnect`. | All 10 are grounded in data already available with zero new firmware/parsing work. The WebSocket-connection pair is a two-line addition to an already-singleton callback, not a new subsystem, and `ws_disconnect` is arguably one of the more safety-relevant events on the list (auto-cutting a spindle-adjacent device's power when the WebUI loses contact with the machine). |
| One URL per event, or many? | **One event + one URL per rule row; many rows may share the same `event` value.** | Matches the existing flat-list shape of `macros`/`pollingcmds`. Satisfies "cut power to both [devices] on door open" with zero new schema — just two rows, `event: door_open`, different `action`. |
| Per-event enable/disable? | **Two-level**: one master `enableeventmacros` boolean gating the whole feature, plus a per-row `enabled` boolean. No separate "disable all rows of event type X" concept. | Matches the existing `enablepolling`/`pollingcmds` master+list pattern already in this codebase, plus per-row granularity that this feature's "kill switch you don't have to delete rows to use" need actually requires (macros/keymap don't need this because they're click-triggered, not always-on background automation). |
| Unreachable target device? | **Silent, console-only** — no toast, no persisted error log — reusing `silentFetch`'s exact existing failure logging. | Matches the pre-existing `URI_SILENT` behavior byte-for-byte, and avoids a toast firing every time a door opens during unattended operation, which would itself be operationally worse than silence. Documented as a real limitation (§3), not hidden. |
| Where persisted? | New **top-level `eventmacros` section**, own fieldset, in **`src/targets/CNC/FluidNC/preferences.json`** (FluidNC tier), *not* merged into the existing `macros` section and *not* placed in the generic CNC-tier or base-tier file. | The engine is unavoidably FluidNC-specific — the event vocabulary (`Run`/`Door`/`Alarm` wire strings) is meaningless for any hypothetical non-FluidNC target, so schema and engine must live in the same tier, and that tier is FluidNC. Separately, this always-on, unattended, network-firing background-automation control deserves its own fieldset/header rather than being crammed into the existing manual-click-macros section — mirroring the already-existing `"polling"` section's own-fieldset pattern gives clean visual separation for what the brief itself frames as a materially higher-stakes feature. |
| Differ per machine profile? | **No** — FluidNC-specific by construction (only tier it lives in), and moot in practice today since `src/targets/CNC/` currently contains exactly one subtarget (`FluidNC`). | If a second CNC subtarget is ever added, it simply doesn't get this section (FluidNC-tier `preferences.json` values are additive to that one target only, per `mergeJSON`'s per-tier-file semantics) rather than inheriting a UI that silently does nothing. |
| MQTT / non-HTTP? | Out of scope, per hard constraint. Every action is exactly `silentFetch`-shaped. | Stated constraint; not revisited. |
| Debounce/cooldown | Concrete, numbered, two-layer design plus a reconciliation mechanism — see §4. | Required by the brief. |
| Translations | New `S227`-`S235` (base) + `FL13`-`FL22` (FluidNC-tier, event names) + one literal `"eventmacros"` section-title key, all mirrored into `languages/lang-de.json`. | See §0 — extends the actual (if imperfect) convention. |

---

## 2. Event catalog (final, wire-grounded)

| `event` value | Fires on (confirmed transition) | Detected from |
|---|---|---|
| `spindle_on` | spindle RPM `0 → >0` | `response.rpm.value` (status ticks, always present) |
| `spindle_off` | spindle RPM `>0 → 0` | same |
| `cycle_start` | state **exactly** `"Idle" → "Run"` | `response.status.state` |
| `cycle_stop` | state **exactly** `"Run" → "Idle"` | same |
| `hold` | state → `"Hold"` from any other state | same |
| `door_open` | state → `"Door"` from any other state | same |
| `door_closed` | state leaves `"Door"` for any other state (state-machine level, not raw pin — see caveat below) | same |
| `alarm` | state → `"Alarm"` from any other state (covers `Alarm`/`ConfigAlarm`/`Critical`, all three map to this wire string) | `response.status.state` **and** the fast `isAlarm(data)`/`ALARM:n` path, both feeding the same tracker (§5) |
| `ws_connect` | connection state `false → true` | `ConnectionState.connected`, via `setConnectionStateListener` |
| `ws_disconnect` | connection state `true → false` | same |

**`cycle_start`/`cycle_stop` are strict Idle↔Run pairs, not "entered/left Run from anywhere."** A resume from `Hold` or `Door` back into `Run` does **not** re-fire `cycle_start`; a job that ends via `Alarm` instead of returning to `Idle` does not fire `cycle_stop` (it fires `alarm` instead, which is more specific). This matches the brief's literal wording and avoids a vacuum-on/off pulse firing every time an operator opens the door mid-job to clear a chip and resumes.

**Interaction this creates, called out explicitly because it is easy to miss and directly affects the brief's own motivating scenario:** because `cycle_start`/`cycle_stop` are strict Idle↔Run pairs, binding a vacuum solely to `spindle_on`/`spindle_off` or `cycle_start`/`cycle_stop` means the vacuum will **not** automatically resume after a door-open-and-close pause — the spindle typically stays "logically on" state-wise through a `Hold`/`Door` cycle in a way that doesn't re-trigger those two edges, and even where it does dip, the settle-delay (§4) is tuned to filter exactly that kind of multi-second flapping, not amplify it. **If "vacuum resumes when the door closes" is wanted, it needs its own explicit `door_closed` rule** pointing at the same target URL — this must be called out in the settings UI's help text for the `event` field (see `S234` in §8) as well as here.

**`door_closed` uses the state-machine transition (leaving `SafetyDoor` state), not the raw `Pn:D` GPIO bit.** This is a deliberate, safety-conservative choice: `SafetyDoor` only exits once FluidNC's own retract/restore sequence has run and the operator has triggered resume — tying "vacuum back on" to the machine's own resume decision, not to the instant the door physically clicks shut (which could happen well before the operator actually intends to resume, e.g. glancing in and re-closing it). Costs at most one status-report interval (50-200ms) of latency versus the raw-pin alternative; immaterial given this whole feature is advisory/best-effort already (§3).

**`alarm` is hooked from two call sites** (§5) — the fast `ALARM:n` real-time message and the periodic status line's `state=="Alarm"` — both feeding the same edge tracker, so an alarm-shaped action fires as fast as the firmware's fastest available signal allows, and is not dependent on a subsequent periodic tick happening to land after the alarm.

---

## 3. Non-goals and caveats (stated up front, surfaced in-product via `S233` help text — not just here)

1. **This is not a safety interlock.** It is client-side JavaScript riding on the same best-effort WebSocket status stream the dashboard UI uses. If the browser tab is closed, the OS/browser suspends/throttles it, the WebSocket is down, or the local network can't reach the target device, **nothing fires** — including `alarm` and `door_open`. It must never be presented or relied on as a substitute for FluidNC's own E-stop/safety-door wiring.
2. **Missed transitions during a WebSocket outage are unrecoverable by design.** Edge detection only compares the next real sample against whatever was last confirmed before a drop; a full `Run→Idle→Run` cycle that happens entirely while disconnected is invisible on reconnect (only a net "no change" is observed). This is an inherent limit of client-side edge-detection over a lossy stream, not a bug, and is explicitly out of scope to fix (would require server-side buffering/replay, which is a firmware change and therefore out of scope per the hard constraints).
3. **Multi-tab / multi-client duplicate firing is a real, unaddressed limitation.** FluidNC's WebSocket server supports and is commonly used with multiple simultaneous clients (shop PC + phone + tablet all pointed at the same board is a normal setup for exactly the vacuum/dust-extraction use case in the brief) — confirmed via `FluidNC/src/WebUI/WSChannel.cpp`'s per-session, multi-client design. This feature's engine is deliberately **per-tab, module-scope state** (§4/§5) with **no cross-tab or server-side coordination** — that's out of scope (would need either a server-side FluidNC change, which is prohibited, or a much larger client-side coordination layer, disproportionate to this feature's size). Consequence: if the WebUI is open on two devices watching the same machine, a qualifying edge produces **two independent `silentFetch` GETs**, one from each tab's independent cooldown/in-flight tracker, neither aware of the other. For an idempotent ON/OFF endpoint this is merely wasteful (both requests do the same thing). **For a non-idempotent `Power TOGGLE` endpoint, this can desync the plug's real state from the machine's state with no way for either tab to notice.** This is the single strongest reason to prefer idempotent ON/OFF-style URLs over TOGGLE for any automated (non-manually-clicked) trigger — stated explicitly in the `action` field's help text and in this caveats section, not buried in a footnote. Recommendation surfaced to the user: don't rely on TOGGLE-style automated triggers if you routinely have the WebUI open on more than one device.
4. **Laser dynamic-power mode risk for `spindle_on`/`spindle_off`.** With M4 dynamic-power laser mode, `sys.spindle_speed()` tracks power continuously and can legitimately dip toward/through 0 at direction changes or corners during an otherwise-continuous cut. The settle-delay (§4) mitigates but does not eliminate false on/off pairs in this mode. Recommendation surfaced in help text: bind mains-power actions to `cycle_start`/`cycle_stop` rather than `spindle_on`/`spindle_off` when running dynamic-power laser jobs.
5. **TOGGLE-style endpoints are not self-correcting even single-tab.** The in-flight guard (§4) closes the overlapping-request race for a single tab, but a genuinely *missed* edge (tab backgrounded and throttled by the browser, WebSocket dropped at the wrong instant) can still desync a TOGGLE device from reality with no way for the engine to detect or correct it — unlike an ON/OFF pair, which self-heals on the very next genuine edge regardless of what was missed in between. UI guidance only (help text), not enforced (the URL is arbitrary and the engine can't know the target device's semantics).
6. **Relay/contactor wear.** The brief calls out that rapid mains-power toggling "could be actively harmful" — this isn't only about spamming the target device's HTTP server, it's also physical wear on whatever is switching the load (an electromechanical relay inside a cheap smart plug degrades faster under repeated cycling than a solid-state/triac output does). The cooldown floor (§4) exists partly for this reason, not purely anti-spam.
7. **No cross-session/cross-viewer awareness beyond what's stated in point 3.** Settings changes require Save + full page reload to take effect (`SaveSettings()` in `tabs/interface/index.tsx` does `setTimeout(() => window.location.reload(), 1000)` after a successful POST). The Settings-tab editor's in-progress edits and the live engine's active rule set are separate deep-cloned objects (`interfaceSettings.current` vs. the value read via `useUiContextFn.getValue`) — there is no live-edit race: opening the settings editor with unsaved changes has zero effect on the running engine until Save completes and the page reloads.

---

## 4. Debounce, edge-detection, and race-condition design

This is the section the brief singled out as needing "exact debounce logic with numbers." It combines three complementary mechanisms: a per-rule settle delay that re-validates its condition at fire time (protecting even unpaired events like `hold`/`alarm` that have no natural opposite to cancel against), a hard cooldown floor with a reconciliation retry so a genuinely dropped fire is never permanently lost, and an in-flight guard with a bounded fetch timeout so a hung request can't wedge a rule or spam retries.

### 4.1 Two independent per-rule tunables

- **`delay`** (ms, default `300`, min `0`, no enforced max, string-typed in storage matching the codebase's numeric-field convention): on a qualifying raw edge, arm a single `setTimeout(delay)` for that rule. When it elapses, **re-check the rule's event condition against the live, currently-tracked state** (not a snapshot taken when the timer was armed) — if the condition no longer holds, drop silently (no request, no console log; this is expected/frequent flicker-filtering, not an error). If it still holds, proceed to the cooldown/in-flight gate below. **This single mechanism serves two purposes with one number**: it filters single-tick wire noise (a torn read, a momentary override blip) *and* it implements the brief's "turn the vacuum off a bit after the spindle stops" requirement directly — set the `spindle_off` rule's `delay` to `3000`-`5000` and that *is* the off-delay, no separate feature needed.
  - **This re-check-at-fire-time applies uniformly to all 10 events**, including `hold` and `alarm`, which have no natural "opposite" event to cancel against. An opposite-event-cancellation-only design (no live re-check) would leave exactly the two most safety-relevant unpaired triggers unprotected against a single corrupted status line — the live re-check closes that gap for every event, not just paired ones.
  - **Timer hygiene**: a new qualifying raw edge for a rule **cancels and replaces** that rule's own pending `delay` timer (`clearTimeout` + reschedule), rather than accumulating parallel timers under sustained flapping.
  - Recommended per-event starting values (documented in help text `S234`, tunable by the user, template default is a flat `300`):

    | Event | Recommended `delay` | Why |
    |---|---|---|
    | `spindle_on` | 300 ms | Fast/responsive; spans 2-6 status reports at 5-20Hz, filtering single-tick noise. |
    | `spindle_off` | 2000-5000 ms | Implements "turn off a bit after" directly. |
    | `cycle_start`/`cycle_stop` | 300-500 ms | Same flicker-filtering logic. |
    | `hold` | 500 ms | A tapped-and-released feed hold shouldn't toggle anything. |
    | `door_open`/`door_closed` | 200-500 ms | Mechanical door-switch bounce. |
    | `alarm` | 0-300 ms | Minimize latency for the safety-adjacent action; cooldown already protects against alarm-flap request storms. |
    | `ws_connect`/`ws_disconnect` | 1000-2000 ms | Connection flapping (bad WiFi, VFD electrical noise near the WebSocket link) has a materially different, multi-second time signature than the 5-20Hz status stream the other events are tuned against — a longer delay here absorbs `WebSocketService.ts`'s own reconnect-attempt cycling (its retry cadence is on the order of seconds, not milliseconds) rather than firing on every intermediate attempt. |

- **`cooldownms`** (ms, default `3000`, **UI-enforced min `500`**, string-typed): a hard floor on actual outbound `silentFetch()` starts for this specific rule, independent of and layered on top of the `delay` outcome. Defensively re-clamped inside the engine itself (`Math.max(cfg.cooldownms, 500)`) in case `preferences.json` is hand-edited or an old file is uploaded that predates UI validation — a floor, not a silent default substitution, so behavior stays predictable.

### 4.2 In-flight guard + fetch timeout (universal, non-configurable)

A hung `fetch()` (dead route, black-holed connection — `fetch()` has no default timeout) could otherwise hold a rule "in flight" indefinitely; without a guard, a second qualifying edge after cooldown expires would fire an overlapping second GET to the same (possibly non-idempotent) endpoint — exactly the race the brief's own motivating Tasmota-TOGGLE example is vulnerable to.

- Each rule tracks `inFlight: boolean`. A fire attempt while the previous request for that same rule hasn't resolved is skipped outright and logged (`console.log("[EventMacros] <name>: previous request still in flight, skipped")`). Rather than being retried on a fixed timer, a blocked-by-in-flight attempt sets a one-shot retry flag that the in-flight request's own completion callback consults when it settles — see §4.3 for why this matters and how it avoids poll-storming while a request is hung.
- `silentFetch` (shared helper, §6) gains an optional `timeoutMs` via `AbortController`; the event-macros engine always passes **5000 ms**. Without a timeout, a hung request would wedge that rule's in-flight flag forever. 5s is generous-but-bounded for LAN-local IoT devices; not user-configurable in v1 (one exported constant in the engine module for future tuning).
- **This guard is single-tab only** — see §3 point 3 for the multi-tab limitation it does not and cannot close.

### 4.3 Cooldown reconciliation and in-flight retry (closes the "stranded device" gap)

Pure "drop, never retry" cooldown/in-flight handling has a real gap: a genuine, intentional reverse-edge fire (e.g. a real `spindle_off`) that happens to land inside another firing's cooldown window, or while a previous request is still in flight, gets dropped — and since this is purely edge-triggered, there may be no later edge to correct it (the job simply ends). Concretely: motor stops for good, the `spindle_off` action is due to fire, lands inside cooldown, gets dropped-and-logged — the vacuum stays on indefinitely with the operator having walked away trusting the automation.

**Resolution: two distinct retry mechanisms, one per blocking cause, that never poll each other.** It is important that these stay separate — a single generic "reschedule a timer using the cooldown clock" retry, applied uniformly to both the cooldown-blocked case *and* the in-flight-blocked case, breaks down under the plan's own default numbers (`cooldownms` defaults to `3000`ms, the fetch timeout is `5000`ms): a hung request still has ~2 more seconds to run after cooldown nominally "expires," so a cooldown-clock-based retry would fire every ~50ms for those 2 seconds, each attempt finding `inFlight` still true and rescheduling again — dozens of wasted wake-ups. The fix is to give each blocking cause its own resolution signal instead of polling:

- **Cooldown-blocked** (not in flight, but still inside the cooldown window): schedule **one** timer for the remaining cooldown duration, at most one pending per rule (a second cooldown-blocked attempt while one is already scheduled is a no-op — coalesced). When it elapses, re-sample the rule's live condition (the same `conditionHolds` check the `delay` timer uses) and call `tryFire` again — which may itself now hit the in-flight case instead, in which case the in-flight mechanism below takes over cleanly.
- **In-flight-blocked** (a previous request for this rule hasn't settled yet): no timer at all. Set a `retryOnSettle` flag (idempotent — setting it while already `true` is a no-op). The in-flight request's own `onSettled` callback checks this flag when it fires; if set, it clears the flag and calls `tryFire` again immediately, re-sampling live state at that moment. This is event-driven, not polled — it produces at most one retry attempt exactly when the blocking condition actually clears, regardless of how long the request took (bounded by the 5000ms timeout either way).
- In both cases, the retry does **not** replay the specific historical edge that got dropped (that would risk firing a stale "vacuum on" action seconds after the spindle already stopped again — actively wrong). It re-samples ground truth at retry time and acts on whatever is true then.
- Net effect: a rule can never be permanently stranded by a single unlucky cooldown or in-flight collision, because the engine always gets one more look at ground truth right as the blocking condition clears, and that look reflects reality at that moment rather than a stale snapshot — and it does so without any busy-polling.

### 4.4 Where the engine lives and how it's driven

The engine core is a **plain TypeScript module, no React/hooks import**, `src/targets/CNC/FluidNC/eventMacros.ts`, driven by direct function calls from three deterministic, non-render call sites:

1. `TargetContext.tsx::dispatchInternally`, inside the existing `isStatus(data)` branch — once per parsed status line, 5-20Hz.
2. `TargetContext.tsx::dispatchInternally`, inside the existing `isAlarm(data)` branch — immediately on a raw `ALARM:n` message, faster than waiting for the next periodic tick.
3. `useWebSocketService.ts`'s existing `setConnectionStateListener` callback (inside the singleton-guarded `if (!webSocketServiceInstance)` block) — once per genuine connection transition.

None of these three call sites requires a React hook or a new Provider-tree component. Live settings reads inside the engine use `useUiContextFn.getValue(...)` — the same non-hook escape hatch `filters.ts` already uses from the identical hot path. This deliberately avoids adding any new bridge component or wiring a hook into a location where React would reject it (per §0's provider-order finding) — the change stays small and additive, consistent with this repo's stated preference for small, upstream-mergeable diffs.

### 4.5 Module structure

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

// ---- public ingest functions, called from TargetContext.tsx / useWebSocketService.ts ----
export function ingestStatus(state: string | undefined, rpm: string | number | undefined): void {
    const prevState = trackedState
    const prevSpindleOn = trackedSpindleOn

    if (typeof state === "string" && state.length > 0) trackedState = state
    if (typeof rpm !== "undefined") {
        const n = typeof rpm === "string" ? parseFloat(rpm) : rpm
        if (!Number.isNaN(n)) trackedSpindleOn = n > 0
    }

    // State-derived and spindle-derived edges are seeded independently: a state
    // transition can fire as soon as trackedState has been observed once, even if
    // (hypothetically) spindle data had not yet arrived, and vice versa. In practice
    // FS: is unconditional on every tick (§0) so both are always seeded together,
    // but the two guards are kept separate so that remains true by construction,
    // not by coincidence.
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
                                        // Symmetric with trackedState/trackedSpindleOn — the initial
                                        // connect that happens as part of a fresh page load is not
                                        // itself a "genuine transition" to react to; only a *subsequent*
                                        // connect/disconnect, after the seed, fires ws_connect/ws_disconnect.
    if (prev !== connected) dispatch(connected ? "ws_connect" : "ws_disconnect")
}
```

Design notes on this reference implementation:
- The master-switch gate (`enableeventmacros`) lives inside `readEnabledRules()`, checked on every `dispatch()` call — tracking (`trackedState`/`trackedSpindleOn`/`trackedConnected`) always stays live regardless of the master switch, so re-enabling the feature mid-session doesn't require a page reload to "catch up," and no spurious fire happens purely from flipping the switch.
- `conditionHolds` is what `tryFire` re-checks at settle-timer-elapse and at both reconciliation points — this is the mechanism that protects `hold`/`alarm` (no "opposite event" needed).
- `armSettle`'s cancel-then-reschedule avoids unbounded timer accumulation under sustained flapping, without losing the live re-check at fire time.
- `scheduleCooldownReconcile` and the `retryOnSettle`/`onSettled` pairing are two separate, purpose-built mechanisms (§4.3) rather than one generic timer-based retry — this specifically avoids the poll-storm failure mode a single cooldown-clock-based retry would produce whenever a request is still in flight past the nominal cooldown boundary.
- First-tick seeding (`prevState === undefined` / `prevSpindleOn === undefined` guards, independently applied) prevents a spurious `cycle_start`/`spindle_on`/etc. from firing purely because the machine already happened to be running when the page loaded.
- `ingestConnectionState` uses the same seed-only treatment as the other two trackers, for consistency and simplicity: the connection established as part of a fresh page load is the seed observation and does not itself fire `ws_connect`. Only a subsequent, genuine reconnect (e.g. after the board is power-cycled or WiFi drops) fires it. See §10.2 test 10 for how this is validated.

---

## 5. Wiring into existing files (exact edits)

### 5.1 `src/targets/CNC/FluidNC/TargetContext.tsx`

Add import near the top:
```ts
import { ingestStatus, ingestAlarmFastPath } from "./eventMacros"
```

Inside `dispatchInternally`, in the `isStatus(data)` branch, immediately after the existing `if (response.sd) { setStreamStatus(response.sd) }` block (currently lines 210-212) and before the `//more to set+` comment (line 213):
```ts
                // Event-triggered silent macros: feed this tick's derived state/spindle
                // values to the edge-detection engine (see ./eventMacros.ts).
                ingestStatus(response.status?.state, response.rpm?.value)
```

Inside the existing `isAlarm(data)` branch (lines 217-224), immediately after `eventsList.emit("alarm", data)`:
```ts
                eventsList.emit("alarm", data)
                ingestAlarmFastPath()
```

No other change to this file. Both insertion points are inside the already-existing `if (type === "stream")` block; no new hooks, no new component, no change to the provider tree.

### 5.2 `src/hooks/useWebSocketService.ts`

Add import:
```ts
import { ingestConnectionState } from "../targets/CNC/FluidNC/eventMacros"
```

Inside the existing singleton-guarded block, extend the existing listener (lines 64-66):
```ts
            webSocketServiceInstance.setConnectionStateListener((state) => {
                connection.setConnectionState(state);
                ingestConnectionState(state.connected);
            });
```

This is inside `if (!webSocketServiceInstance) { ... }`, so — confirmed in §0 — it registers exactly once regardless of how many components (`Navbar`, `about`, `features`) call `useWebSocketService()`. No new component, no provider-tree change; this callback runs inside a `useEffect` in whichever component happens to mount the hook first, all of which are safely inside `UiContextProvider`'s subtree per the confirmed provider order in §0.

**Cross-target note:** `src/targets/CNC/FluidNC/eventMacros.ts` is imported directly by a target-agnostic hook file (`src/hooks/useWebSocketService.ts`). This is an intentional, narrow exception to strict tier separation: `ingestConnectionState` is a pure no-op if `enableeventmacros`/`eventmacros` settings don't exist for the active target (`readEnabledRules()` returns `[]` when `useUiContextFn.getValue("enableeventmacros")` is falsy/undefined), so this import is safe even for a hypothetical non-FluidNC target and does not need to be routed through the target-abstraction layer (`src/targets/index.js`) the way UI-facing symbols are.

---

## 6. Shared `silentFetch` extraction (behavior-preserving, with the in-flight/timeout support §4.2 needs)

`silentFetch` currently lives as a private, unexported `const` inside `src/components/Panels/Macros.tsx` (lines 97-114, verbatim: `fetch(uri, {method:"GET", mode:"cors", cache:"default"})`, `.then`/`.catch` only `console.log`, no timeout). It must be extracted so the new engine can call the *same* function without duplicating it, while adding the optional timeout/in-flight-resolution hook §4.2 needs — without changing default behavior for the existing manual macros call sites.

### 6.1 Edit `src/components/Helpers/http.ts` (existing file — has `espHttpURL`/`getCookie`/`isLimitedEnvironment` already; add alongside them)

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
Add `silentFetch` and the `SilentFetchOptions` type to this file's final `export { espHttpURL, getCookie, isLimitedEnvironment }` statement.

When called with no `options` — exactly how `Macros.tsx` will call it — `timeoutMs` is `undefined`, no `AbortController` is created, and `myInit` is identical to the pre-extraction object. **Zero behavior change for existing manual macros.**

### 6.2 Edit `src/components/Helpers/index.ts`

Add `silentFetch` to the `import { espHttpURL, getCookie, isLimitedEnvironment } from "./http"` line and to the barrel `export { ... }` list; add `export type { SilentFetchOptions } from "./http"` alongside the other re-exported types at the bottom.

### 6.3 Edit `src/components/Panels/Macros.tsx`

- Delete the local `const silentFetch = (uri: string): void => { ... }` block (lines 97-114).
- Add `silentFetch` to this file's existing Helpers import — `Macros.tsx` does **not** currently import anything from `../../components/Helpers` (confirmed by direct read of its import block, lines 19-32), so this is a new import line: `import { silentFetch } from "../../components/Helpers"`.
- Leave both call sites untouched: `silentFetch(action.trim().replace("[SILENT]", "").trim())` (the legacy `[SILENT]`-prefixed `URI` macro path) and `silentFetch(action.trim())` (`URI_SILENT`).

This is a pure relocation — identical function body for the zero-argument call shape, identical call sites, identical logging. The existing manual macros feature (including the prior `URI_SILENT` PR) is unaffected by construction, not merely by intent.

---

## 7. Settings schema

### 7.1 New file `src/components/Controls/Fields/def_eventmacro.json`

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
(`delay`/`cooldownms` stored as strings, matching the verified convention in `def_polling.json`'s `"refreshtime": "0"`.)

### 7.2 Edit `src/targets/CNC/FluidNC/preferences.json`

Add a new top-level section (own fieldset, sibling of the existing `"polling"` section at the same tier, structured identically):

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
        "value": [],
        "depend": [{ "id": "enableeventmacros", "value": true }]
    }
]
```
- Default `value: false` — opt-in, not opt-out. This is a new feature that fires outbound HTTP requests with no click; it must never silently start being active for an existing install just because the section now exists.
- `sorted: false` — row order has no functional meaning (rules are independent), matching `pollingcmds`'s own `sorted: false`; omits the up/down reorder buttons `ItemsList.tsx` conditions on the `sorted` prop.
- No `fixed`/`nodelete` — rows are freely addable/removable, like `macros`, unlike the fixed `keymap` list.

### 7.3 Edit `src/components/Controls/Fields/ItemsList.tsx`

Add import:
```ts
import defaultEventMacro from "./def_eventmacro.json"
```

Extend the `addItem()` template ternary (currently lines 377-381):
```ts
id == "macros"
    ? defaultMacro
    : id == "pollingcmds"
      ? defaultPolling
      : id == "eventmacros"
        ? defaultEventMacro
        : defaultPanel
```

Extend **both** the Add-button `label` and `data-tooltip` ternaries (lines 419-433) with the same `id == "eventmacros" ? T("S228") :` branch inserted before the final `defaultPanel`-tier fallback. **This edit to both ternaries is not optional** — an unhandled list id silently clones `defaultPanel`'s image/content/extension/camera fields, corrupting the row on first edit.

### 7.4 Edit `src/tabs/interface/importHelper.ts`, `formatItem()`

Add four new `case`s inside the existing `switch (key)` (after the existing `case "action":` block, before `default:`), and extend the existing `case "action"` with an `origineId` branch (mirroring the already-real precedent set by `case "type"`'s `origineId == "macros"` branch):

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

And change the existing `case "action":` (line 200-204) to:
```ts
case "action":
    newItem.type = "text"
    newItem.label = origineId == "eventmacros" ? "S226" : "S159"
    newItem.min = "1"
    if (origineId == "eventmacros") {
        newItem.regexpattern = "^https?://"
    }
    break
```
This reuses the existing `S226` string ("URL address (silent)") as the new `action` field's label when `origineId == "eventmacros"`. Note precisely what `S226` labels **today**, so the rationale is grounded correctly: it is currently the label of the `URI_SILENT` *option* inside the macros' `type` select dropdown (`case "type"`, `origineId == "macros"` branch: `{ label: "S226", value: "URI_SILENT" }`), not the `action` field's label — the `action` field's label is unconditionally `S159` ("Action") today, for every macro type, with no `origineId` branching. This plan introduces the first `origineId` branch on `action`'s label, and simply repurposes `S226`'s existing text onto this new location because the wording ("URL address (silent)") fits identically well for this field's meaning here — no new translation key is minted for it. The `regexpattern` (only added for `origineId == "eventmacros"`, not for macros' `action`, whose values aren't always URLs) is picked up automatically by the existing generic validation in `src/tabs/interface/index.tsx::generateValidationGlobal` (line ~174-181) — a malformed URL gets the standard red-halo + "Incorrect value" treatment for free.

`name` needs no new case (the existing `case "name"` — label `S129` — already applies unmodified).

No other file in the generic settings-render pipeline (`src/tabs/interface/index.tsx`, `exportHelper.ts`) needs to change — both are fully generic over section/field shape.

---

## 8. Translations

### 8.1 `src/targets/translations/en.json` (add after the confirmed max, `S226`)

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

### 8.2 `src/targets/CNC/FluidNC/translations/en.json` (add after the confirmed max, `FL12`)

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

### 8.3 `languages/lang-de.json` (mirror both sets — 7 `S` keys + 10 `FL` keys + 1 literal section title)

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

The other 15 shipped `languages/lang-*.json` files are **not** touched — `T()`'s confirmed fallback to `baseLangRessource` (English) means a missing key renders in English, exactly as the existing `FL1`-`FL12` and the `CN114`-`CN199` gap already do today. This is scope-limited to German (per the brief), not an oversight.

**Before implementing**, re-run the max-key check (`grep -oE '"S[0-9]+"' src/targets/translations/en.json | sort -t S -k2 -n | tail -1`, similarly for `CN`/`FL`) — this plan's numbering (`S227`+, `FL13`+) is correct as of this writing but could drift if unrelated work lands on `main` first.

---

## 9. Complete file-by-file change list

| File | Change |
|---|---|
| `src/components/Helpers/http.ts` | Add exported `silentFetch(uri, options?)` with optional `timeoutMs`/`onSettled` (§6.1). |
| `src/components/Helpers/index.ts` | Export `silentFetch` and `SilentFetchOptions` from the barrel (§6.2). |
| `src/components/Panels/Macros.tsx` | Remove local `silentFetch`; add import from `../../components/Helpers`. No behavior change (§6.3). |
| `src/targets/CNC/FluidNC/eventMacros.ts` | **New.** Edge-detection + settle-delay + cooldown + in-flight guard + reconciliation engine (§4.5). |
| `src/targets/CNC/FluidNC/TargetContext.tsx` | Import `ingestStatus`/`ingestAlarmFastPath`; one line in the `isStatus(data)` branch, one line in the `isAlarm(data)` branch (§5.1). |
| `src/hooks/useWebSocketService.ts` | Import `ingestConnectionState`; one line inside the existing singleton `setConnectionStateListener` callback (§5.2). |
| `src/components/Controls/Fields/def_eventmacro.json` | **New.** Default row template, string-typed numeric defaults (§7.1). |
| `src/components/Controls/Fields/ItemsList.tsx` | Import new template; extend both hardcoded `id == "macros" ? ... : ...` ternaries (§7.3). |
| `src/tabs/interface/importHelper.ts` | Add `event`/`delay`/`cooldownms`/`enabled` cases; branch `action`'s label/regex by `origineId` (§7.4). |
| `src/targets/CNC/FluidNC/preferences.json` | Add new top-level `eventmacros` section: `enableeventmacros` boolean (default `false`) + `eventmacros` list (default `[]`) (§7.2). |
| `src/targets/translations/en.json` | Add `eventmacros` + `S227`-`S235` (§8.1). |
| `src/targets/CNC/FluidNC/translations/en.json` | Add `FL13`-`FL22` (§8.2). |
| `languages/lang-de.json` | Add the same 18 keys, German (§8.3). |

No FluidNC firmware files touched. No change to `Macros.tsx`'s `processMacro` switch, macro data shape, `def_macro.json`, `def_polling.json`, `def_panel.json`, `panels.ts`, `src/tabs/interface/index.tsx`, `exportHelper.ts`, or any other target's `preferences.json`.

---

## 10. Test / validation plan

### 10.1 Static gates (fast, no board — must be clean before anything else)

```bash
npm run type-check
npm run lint
npm run build
```
If a translation-lockstep checker script exists in `package.json` (verify via `cat package.json | grep -i checkpack` at implementation time), run it against `languages/lang-de.json` too.

### 10.2 On-device manual validation

Mirrors this project's established workflow: `npm run build` → upload the resulting build to the board's flash filesystem (via the WebUI's own Files panel, or the FluidNC HTTP upload endpoint directly) → hard-refresh (cache-bypass) the browser tab pointed at the board. Requires a FluidNC board reachable over WiFi and one or two Tasmota-style (or any plain HTTP GET-toggleable) smart plugs on the same network — reuse the already-validated `http://<plug-ip>/cm?cmnd=Power%20ON`/`OFF`-style endpoints from the existing `URI_SILENT` use case; where a test specifically needs a slow/hanging endpoint, substitute a local test server (e.g. Python `http.server` with an artificial `time.sleep`).

1. **Regression — existing macros unaffected.** Flash, hard-refresh. Click through existing `FS`/`SD`/`URI`/`URI_SILENT`/`CMD` macros, including a `URI_SILENT` macro against a real plug — confirms the relocated `silentFetch` behaves byte-for-byte identically post-extraction.
2. **Settings UI.** Open Settings → Interface. Confirm a new, separately-headed **"Event Macros"** section appears (own fieldset, not folded into "Macros"), master toggle off by default, list hidden until enabled (`depend`). Add a row; confirm the Trigger-event dropdown shows all 10 translated options in the order listed in §2; confirm the URL field rejects a non-`http(s)://` value (red halo) and accepts a valid one; confirm Cooldown refuses values below 500. Save; confirm the page reloads and the row persists (round-tripped through `preferences.json` correctly).
3. **Master switch off.** Leave `enableeventmacros` off; physically trigger every event; confirm zero requests fire (watch the Network tab). Then enable it and confirm the *next genuine* transition fires correctly, with no spurious fire purely from flipping the switch.
4. **`spindle_on`/`spindle_off` with off-delay.** Configure `spindle_on → Power ON`, `delay=300`; `spindle_off → Power OFF`, `delay=4000`. `M3 S1000` then `M5` via the terminal; confirm the plug turns on ~300ms after `M3` and off ~4s after `M5`. Then `M5` immediately followed by `M3 S1000` well inside the 4s window; confirm the plug does **not** turn off (settle-delay re-check catches the reversion).
5. **`hold`/`alarm` noise protection.** Configure `hold`/`alarm` rules with short `delay` (e.g. 300ms). Tap feed-hold and immediately resume, faster than the settle delay; confirm the `hold` action does **not** fire. Force then immediately clear a soft-limit alarm (`$X`) inside the settle window; confirm the `alarm` action does **not** fire in that case, but **does** fire when the alarm genuinely persists past the settle window. This specifically validates the fire-time re-check that protects these two unpaired events.
6. **Cooldown, in-flight guard, and no poll-storming.** Point a rule's URL at a deliberately slow (multi-second artificial delay) test endpoint, with `cooldownms` shorter than that delay; trigger the event twice in quick succession. Confirm via the test server's request log that only **one** request lands while the first is in flight, and the console shows exactly **one** "previous request still in flight, skipped" message for the second attempt — not a repeating stream of skip/reconcile messages while the first request remains outstanding. Once the slow request finally resolves, confirm the engine's `onSettled`-triggered retry fires (or correctly drops, if the condition has since reverted) immediately upon settlement, not on a later timer tick.
7. **Cooldown reconciliation.** Configure a rule with `cooldownms=5000` and a fast-responding target endpoint. Fire it once (starts cooldown). Before cooldown expires, cause a second genuine qualifying edge that would otherwise be dropped. Confirm: (a) the second attempt is logged as cooldown-skipped, not silently lost; (b) at (or just after) the 5s mark, the engine re-samples live state and fires exactly once more if the condition still holds at that moment, or fires nothing further if the machine has since reverted. This is the direct test for the "stranded device" fix in §4.3.
8. **`cycle_start`/`cycle_stop` strict semantics + the door-resume interaction.** Run a short job from Idle; confirm one `cycle_start` and one `cycle_stop` (Idle→Run→Idle only). Interrupt with feed-hold or the safety-door input mid-job and resume; confirm `cycle_stop` does **not** fire on entering `Hold`/`Door`, and confirm `cycle_start` does **not** re-fire on resume (only the strict Idle→Run transition counts). Separately, configure a `door_closed` rule pointed at the vacuum's ON endpoint; confirm this — not `spindle_on`/`cycle_start` — is what brings the vacuum back after a door-clear-and-resume, validating the interaction called out in §2.
9. **`alarm` fast path.** Force an alarm via a real limit trip (or an equivalent test condition); confirm the configured action fires promptly (verify via Network-tab timestamp that it doesn't wait for the next 5-20Hz periodic tick if the `ALARM:n` message arrives first). Clear with `$X`; confirm no spurious fire on the alarm-clear transition (not one of the 10 defined edges).
10. **`ws_connect`/`ws_disconnect`.** Reload the page; confirm the initial connect that happens as part of the fresh page load does **not** fire `ws_connect` (it is the seed observation, matching the seed-suppression behavior of the state/spindle trackers — see §4.5). With the tab still open and connected, power-cycle the board (or otherwise force the WebSocket connection closed); confirm `ws_disconnect` fires exactly once. Wait for the board to come back online and the WebSocket to auto-reconnect; confirm `ws_connect` fires exactly once at that point, respecting the longer recommended `delay` for this pair (§4.1) so a `WebSocketService.ts` reconnect-attempt cycle doesn't produce multiple fires.
11. **Unreachable target.** Point a rule's URL at a nonexistent host; confirm no toast/hang/crash — only the existing `console.log("Request failed: ...")`, matching `URI_SILENT`'s pre-existing behavior, and confirm the rest of the UI (jog, status, terminal) is unaffected while the request is pending/timing out.
12. **Per-item disable + multiple rules per event.** Configure two rows both bound to `door_open` with different URLs (mirroring "cut power to both [devices]"); disable one row's `enabled` checkbox; trigger `door_open`; confirm only the enabled row fires.
13. **Multi-tab awareness (documentation check, not a bug fix — §3 point 3).** Open the WebUI in two tabs against the same board with a TOGGLE-style test endpoint configured; trigger a qualifying edge; confirm (as expected and documented, not as a defect to fix) that **both** tabs fire independently. This validates that the caveat in §3 is accurately described; there is no fix in scope.
14. **Multi-language check.** Switch UI language to German; confirm the new section header, field labels, dropdown options, and help text render translated text, not raw `S*`/`FL*` keys or the literal `eventmacros` string.