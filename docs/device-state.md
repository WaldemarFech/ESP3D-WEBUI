# Device state

The physical board (`192.168.30.2`) is only ever flashed from the `local/daily-driver`
branch — never from a single feature branch directly. `local/daily-driver` is a
standing (non-PR) merge of every feature branch currently wanted on the real device.
It is never deleted; it gets updated (merge/rebase) whenever a source branch changes.

## Currently merged into `local/daily-driver`

- `fix/jog-distance-keyboard-shortcuts` (PR #17) — jog keyboard-shortcut fixes,
  dynamic bound-key tooltips (`keyTooltip`/`boundKey`/`distanceGroupTooltip` in
  `JogCNC.tsx`).
- `feat/silent-url-macro` (PR #18) — `URI_SILENT` macro type.
- `feat/event-triggered-macros` (not yet a PR) — event-triggered silent-macro engine,
  plus the app-wide tooltip-portal consistency fix (Tasks 6-10).

## Notable merge decisions

- `_control.scss`'s `.tooltip.tooltip-portal::after`: kept `feat/event-triggered-macros`'s
  version (has the `right: auto` fix from Task 10 and the `white-space: pre-wrap`/
  `overflow: visible` multi-line support from Task 6) over PR #17's earlier, less
  complete version of the same rule.
- `JogCNC.tsx` distance-selector tooltips: kept PR #17's single combined tooltip per
  group (on the group wrapper, showing the bound cycle-up/down keys) instead of
  `feat/event-triggered-macros`'s redundant per-button tooltip. Removed PR #17's own
  local `positionPortalTooltip` (predates the Task 6 extraction) so the file consumes
  the one shared implementation in `src/components/Helpers/tooltip.ts`.
- `src/components/Helpers/http.ts`'s `silentFetch`: PR #18's `mode: "cors"` -> `"no-cors"`
  fix (Copilot review) conflicted here because Task 1 had already extracted this function
  out of `Macros.tsx` before the fix was made. Applied the equivalent fix directly to the
  extracted version instead of taking the incoming (stale-location) diff.

## Review-fix status (Copilot automated review on PR #17/#18)

All findings addressed as of 2026-07-30, each on its origin branch, pushed to origin,
then propagated into `local/daily-driver`:
- PR #17: default `btndistSelZ+` key `"#"` -> `"5"` (`6c2e672`) - `"#"` is a shifted
  character on many layouts, never matched the unshifted stored default.
- PR #18: `silentFetch` `mode: "cors"` -> `"no-cors"` (`4d94201`) - CORS-less LAN devices
  (e.g. the Tasmota plug) made successful requests log as "failed"; missing `S226` added
  to `master_translations.json` (`f5657c5`).

## Event-macro templates (Tasks 11-14 on `feat/event-triggered-macros`)

Four one-click templates in the Event Macros list editor, seeded from real, verified devices
(Tasmota plugs: "Mill"/"Fräse" `192.168.30.3` with `Power%201`/`Power%200`, "Vac"
`192.168.30.4` with `Power%20ON`/`Power%20OFF`):
- **Staubsauger**: `spindle_on` -> Vac on; `cycle_stop` -> Vac off (not `spindle_off` -
  waits for the whole end-of-job sequence, not just the spindle stopping).
- **Türsicherung**: `door_open` -> Mill+Vac off; `door_closed` -> Mill+Vac on.
- **Alarm-Absicherung**: `alarm` -> Mill+Vac off.
- **Fräse-Sync**: `cycle_start` -> Mill on (immediate); `cycle_stop` -> Mill off (15s
  delay, deliberate - see the template's own description for the trade-off).

Task 13 fixed a pre-existing missing-`key`-prop defect in `ItemsList.tsx`'s row/field
`.map()` calls (found while investigating an unreproduced "templates stop working after
~8 rows" report) - not confirmed as the root cause, but a real, independently-justified
fix regardless.

**Known infra gotcha**: a continued Bauhütte agent's transcript can become unresumable
after many long tasks (happened once this session, 12 tasks in) - see
`feedback_bauhuette_workflow.md` in the cross-session memory for the recovery process.

## Trigger a saved Macro from an event (Task 15)

An event-macro rule's `actiontype` can be `"url"` (default, unchanged) or `"macro"`
(`macroid` references an existing Macros-panel entry, any type incl. `CMD`/raw G-code -
explicitly user-approved, not a safety oversight). Fires via `executeMacroAction()`
(`src/targets/CNC/FluidNC/macroExecution.ts`, extracted from `Macros.tsx`'s
`processMacro`) reached through a `sendCommand` runner registered from
`ConnectionManager` (NOT `TargetContextProvider` - that's an ancestor of
`ToastsContextProvider`/`HttpQueueContextProvider`, calling `useTargetCommands()` there
crashes). Works even when the Macros panel is unmounted (panels only render when
visible - verified). The referenced macro is re-read fresh from settings on every fire;
a deleted macro logs an error and the rule just doesn't fire, no crash.

## Rule

Before any device upload: check this file is still accurate, update `local/daily-driver`
from its source branches if not, and build from `local/daily-driver` — never from a
single feature branch, unless explicitly testing one branch in isolation with the
understanding that the device will temporarily lose the other branches' features.
