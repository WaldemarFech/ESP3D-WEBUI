# Event-Triggered Macros — Follow-up Tasks (post on-device testing feedback)

Continuation of the original 6-commit build (`c30d00f`..`fdae32d` on `feat/event-triggered-macros`).
Same Global Constraints as before (see `event-triggered-macros-tasks.md`) apply here too. Three tasks,
do them in order, same process as before: implement, verify, self-review, commit, report, stop.

## Task 6: Fix settings-panel tooltip clipping (affects the whole Settings UI, not just Event Macros)

**Symptom, as reported by the user testing the real feature:** hovering "Enable event macros" (and
other fields in that section, and apparently elsewhere in Settings too) produces a tooltip that causes
horizontal scrolling and is truncated with "..." - unreadable. This is the exact same root-cause bug
category already fixed once for the Jog panel's distance-selector tooltip (see PR #17 on this repo's
`fix/jog-distance-keyboard-shortcuts` branch, already merged into this branch's history via
`feat/silent-url-macro`): the default Spectre `.tooltip::after` CSS is `position: absolute`, gets
clipped by any ancestor's `overflow: hidden` (Settings panels have this), and its content doesn't wrap
for long text.

**What was already built and proven for the Jog panel** — find it in `src/components/Panels/JogCNC.tsx`
(the `positionPortalTooltip` function) and `src/style/components/_control.scss` (the
`.tooltip.tooltip-portal` rule): a `position: fixed` tooltip variant, positioned via a small
`onMouseEnter` handler that measures `getBoundingClientRect()` and clamps the tooltip's X/Y so it always
stays fully inside the viewport regardless of ancestor `overflow` or how close to the window edge the
element is. This was fought hard to get right (several iterations, including a clamp-math bug where
narrow-window edge cases could push the box off-screen on the wrong side - the current version in
`JogCNC.tsx` has that fixed, use it as the reference, don't reinvent the clamp math).

**The task:** extract that mechanism into something reusable (a small shared hook/helper, e.g. in
`src/components/Helpers/` or as a small new file - your call on the cleanest fit for this codebase's
patterns) and apply it to the **generic settings-field tooltip rendering** - wherever `Field.tsx` and
its sub-components (`Select.tsx`, boolean/checkbox rendering, text input rendering, etc.) render a
`data-tooltip`/`class="tooltip"` for a field's `help` text. This is shared infrastructure used by every
settings section, not something specific to Event Macros - fixing it here should fix "Enable event
macros"'s tooltip and every other long-help-text tooltip in Settings at once. Do NOT just copy-paste the
positioning code into JogCNC.tsx a second time inline in a different file - extract it once, use it from
both places (refactor JogCNC.tsx's own usage to consume the extracted version too, so there's exactly
one implementation of this logic in the codebase, not two).

**Verification:** type-check, build, lint. Manual dev-server check: hover a field with genuinely long
help text (e.g. the `enableeventmacros` boolean's `S233` help, or the `event` field's new `S236` help)
and confirm the tooltip is fully readable, multi-line if needed, and never causes the page to scroll
horizontally regardless of where on screen the field sits. Also re-check the Jog panel's distance
tooltip still works identically after the refactor (regression check on the thing you're extracting
from).

## Task 7: Event dropdown clarity — what triggers each event, plus example action templates

**Two related UX gaps, reported by the user:**

1. The event dropdown shows friendly names like "Spindle turns on" with no indication of *how* the
   system actually detects it (a G-code command? an RPM reading? a state string?). Add this information
   somewhere the user can actually see it when picking an event - a per-option tooltip/description is
   the natural fit given `src/targets/CNC/FluidNC/eventMacros.ts`'s `conditionHolds()` already has the
   exact ground truth for each of the 10 events (what field, what comparison). Don't invent new
   detection logic here - just surface, in plain language, what that function already does per event,
   e.g. "Spindle turns on — detected when the reported spindle RPM changes from 0 to a positive value"
   / "Cycle start — detected when the machine state changes from Idle to Run" / "Alarm triggered —
   detected when the machine state becomes Alarm (covers hard/soft limits, config errors, and E-stop
   conditions)". Write one accurate, concise sentence per event, matching `conditionHolds()` exactly -
   verify each one against the actual code, don't guess.

2. **Example/template action values, one per event, that the user can quickly apply.** Real, plausible
   examples for THIS project's actual use case (a Tasmota-style HTTP-GET-controllable smart plug
   switching mains power to shop equipment - already validated working in this codebase's `URI_SILENT`
   macro type):
   - `spindle_on` → `http://192.168.30.4/cm?cmnd=Power%20ON` (turn on dust extraction)
   - `spindle_off` → `http://192.168.30.4/cm?cmnd=Power%20OFF` (turn off dust extraction - pair with a
     multi-second `delay` on this rule, see the plan's §4.1 recommended-delay table)
   - `cycle_start` → `http://<light-plug-ip>/cm?cmnd=Power%20ON` (turn on a work light/status beacon)
   - `cycle_stop` → `http://<light-plug-ip>/cm?cmnd=Power%20OFF` (turn the light back off)
   - `door_open` → `http://192.168.30.4/cm?cmnd=Power%20OFF` (cut a non-essential device's power as a
     convenience measure when the enclosure is opened - NOT a substitute for real safety wiring, keep
     that caveat attached)
   - `door_closed` → `http://192.168.30.4/cm?cmnd=Power%20ON` (resume, paired with the door_open rule
     above)
   - `hold` → leave without a strong example; a generic placeholder like
     `http://<device-ip>/your-endpoint` is honest here, don't invent a use case that isn't obviously
     real
   - `alarm` → same as `door_open` (cut non-essential power) is a reasonable, defensible example
   - `ws_connect` / `ws_disconnect` → these are the weakest fit for a smart-plug example (they're about
     the browser tab's own connection, not the machine); a generic placeholder is more honest than a
     forced example - don't invent a use case that doesn't hold up.

   Implement this as whatever concrete UI mechanism fits this codebase's existing patterns best - a
   small "insert example" affordance next to the `action` field that fills in the placeholder for the
   currently-selected `event` when clicked (only if the field is empty, to avoid silently overwriting a
   user's real value), OR the example text shown as part of the same per-option description from point
   1 above if a one-click-fill turns out to be disproportionately invasive for this codebase's field
   rendering architecture - your call on which is the better fit, but the user explicitly asked for a
   "quick-fill" affordance, so prefer the clickable version if it's reasonably achievable, and explain
   your choice in the report if you go the description-only route instead.

**Verification:** type-check, build, lint. Manual check: open the event dropdown, confirm each option
has an accurate description; if a quick-fill mechanism was built, confirm clicking it for a couple of
different events fills the `action` field with the corresponding example and does NOT overwrite a
non-empty existing value.

## Task 8: Fix the `enabled` checkbox layout + add a per-rule "Test" button

**8a. Layout bug, reported by the user:** the `enabled` boolean checkbox for an event-macro row renders
visually outside the row's own fieldset/frame. Investigate the actual rendered DOM (dev server,
inspect element) to find the real cause before guessing - likely candidates worth checking first:
whether `case "enabled":` in `importHelper.ts`'s `formatItem()` is missing a property the other boolean
fields in this codebase set (compare against `enablepolling`'s or `enableeventmacros`'s own boolean
field definitions, which render correctly), or a CSS class mismatch in how `ItemsList.tsx` wraps list-
item sub-fields (`fieldset`/`field-group` classes, around line 414 of that file) that a boolean-typed
field interacts with differently than text/select/number fields do. Fix the actual root cause, not just
the visual symptom with an override class.

**8b. Per-rule "Test" button:** the user wants to fire a configured rule's action immediately, without
waiting for the real machine event, to verify the URL/action actually works before trusting it to an
automatic trigger. Add a small test-trigger control per row (button/icon, your call on the exact
placement matching this list's existing per-row control layout - there's already a delete button per
row to pattern-match against) that calls the same `silentFetch` helper directly with that row's current
`action` value, completely bypassing the event-detection engine (`eventMacros.ts`) - this is purely a
"does this URL work" check, not a simulated event. Should work even while the row is being edited
(before saving), so a user can test before committing to a save+reload.

**Verification:** type-check, build, lint. Manual check: confirm the enabled checkbox visually sits
inside its row's frame like every other field; confirm clicking the test button on a rule pointed at the
real Tasmota plug (`192.168.30.4`) actually fires the request (visible in the Network tab / on the
plug), and confirm it does NOT go through `eventMacros.ts`'s cooldown/in-flight/settle-delay machinery
(a manual test should never be silently dropped or delayed by rules meant for automatic firing).

## Not in scope for this round (flagged, not forgotten)

- Multiple actions per event: already supported (multiple rows can share the same `event` value) - no
  code change needed, just make sure Task 7's UI work doesn't obscure this (e.g. don't build anything
  that implies one-rule-per-event is a constraint).
- Non-HTTP action types for event macros (running G-code/SD-card scripts on a machine event, e.g. an
  auto-probing routine) - explicitly out of scope, a separate, larger, safety-sensitive design decision
  the user deferred rather than requested now. Do not add this.

## Task 9: Make every tooltip in the app behave consistently (Task 6 only fixed 3 of ~25 files)

**Symptom, as reported by the user after retesting the real build:** tooltips across the whole app are
still inconsistent - "manche sind richtig und gut, manche noch alt, am div abgeschnitten und einzeilig"
(some are correct and good, some still old, clipped at the div, single-line). Task 6 only wired the
viewport-anchored portal mechanism (`positionPortalTooltip` from `src/components/Helpers/tooltip.ts`,
`.tooltip.tooltip-portal::after` in `src/style/components/_control.scss`) into three places: `Select.tsx`,
`Boolean.tsx`, and `Input.tsx`'s default text/number case. Everywhere else in the app still uses the bare
Spectre `.tooltip` class with no `tooltip-portal` modifier and no `onMouseEnter` handler - so it's still
`position: absolute`, gets clipped by any ancestor's `overflow: hidden`, and truncates long text to one
line with "...". A `grep -rln 'tooltip'` sweep across `src/` (done during triage for this task, not by
you) found 103 tooltip-attribute occurrences across 25 files - the user's complaint is accurate and
app-wide, not a couple of stray spots.

**Root-cause architecture (found during triage, verify it yourself before relying on it):**
`src/components/Controls/Button.tsx` is created via
`createComponent("button", "btn", modifiers)` (the factory in
`src/components/Helpers/components.tsx`), where `modifiers` maps boolean-ish JSX props to CSS class
strings - including `tooltip: "tooltip"`, `btooltip: "tooltip-bottom"`, `ltooltip: "tooltip tooltip-left"`,
`rtooltip: "tooltip tooltip-right"`. `createComponent`'s generated component forwards every prop that
isn't a recognized modifier key straight onto the underlying element (so `data-tooltip` and any
`onMouseEnter` a caller passes already flow through untouched - `createComponent` itself needs no
changes). `ButtonImg.tsx` wraps `Button` and spreads `{...rest}` through to it, so it inherits whatever
`Button` does for free. Between `Button`/`ButtonImg`, this backs the large majority of the app's
tooltip-bearing controls (jog buttons, panel action buttons, `QuickStopButton`, feature/interface/wifi/
about tabs, `MachineSettings`, etc. - `JogCNC.tsx` alone has 25 tooltip occurrences, almost all plain
`<Button tooltip data-tooltip=...>`). A handful of spots render tooltips on raw markup instead of through
`Button` - confirmed example: `JogCNC.tsx`'s XY/Z distance-selector wrapper divs
(`class="flatbtn tooltip tooltip-left"` around line 552 and its siblings) - these are NOT wired to
`positionPortalTooltip` at all currently (the original PR #17 fix for this exact spot lives on the sibling
`fix/jog-distance-keyboard-shortcuts` branch and was never merged into this branch - Task 6 confirmed and
correctly left it alone; you are now the one extending the fix to it, on this branch, using the already-
extracted shared helper - don't reference or import anything from that other branch).

**The task:**

1. **Centralize the `Button`/`ButtonImg` path.** Turn `Button.tsx` from a bare
   `createComponent(...)` call into a small wrapper that: (a) extends the `tooltip`/`btooltip`/`ltooltip`/
   `rtooltip` modifier class strings to also include `tooltip-portal` (e.g. `"tooltip tooltip-portal"`),
   and (b) auto-attaches `onMouseEnter={positionPortalTooltip}` whenever the caller used one of those four
   tooltip modifier props - merged with any `onMouseEnter` the caller already passes explicitly, don't
   silently drop a caller's own handler if one exists. Verify this one change is sufficient to fix every
   `<Button tooltip .../>` and `<ButtonImg tooltip .../>` call site app-wide (spot-check at least
   `JogCNC.tsx`'s jog/home/zero buttons, `QuickStopButton.tsx`, and one panel outside `Panels/` like
   `tabs/interface/index.tsx` or `tabs/wifi/index.tsx`) rather than assuming it from reading the code.
2. **Sweep the raw-markup usages that don't go through `Button`/`ButtonImg`.** Find every remaining
   `class="...tooltip..."` that isn't rendered via `Button`/`ButtonImg` (start from the 25-file list you
   can reproduce with `grep -rln 'tooltip' src --include=*.tsx --include=*.ts`, cross-reference against
   which ones actually render raw markup vs. just importing/using `Button`) and apply the same
   `tooltip-portal` class + `onMouseEnter={positionPortalTooltip}` pattern directly, exactly like Task 6
   did for `Select.tsx`/`Boolean.tsx`/`Input.tsx`. Confirmed raw-markup case to fix:
   `JogCNC.tsx`'s distance-selector wrapper divs (all `class="flatbtn tooltip tooltip-left"` occurrences,
   XY and Z groups both). Check `ItemsList.tsx`, `ScanAp.tsx`, `ScanPacksList.tsx`,
   `ExtraContent/extraContentItem.tsx`, and `Panels/Files.tsx` too - some of their matches may already be
   covered indirectly via `Button`/`ButtonImg`/`Select`/`Boolean`/`Input`, don't touch what's already
   correct, only fix what's genuinely still raw/unfixed.
3. **Don't touch** `Select.tsx`, `Boolean.tsx`, `Input.tsx`'s default case (Task 6's work) beyond whatever
   naturally follows from them already being correct - no regressions expected there, but re-verify they
   still work after your `Button.tsx` change (in case any of them internally render a `Button`).
4. Leave the CSS (`.tooltip.tooltip-portal::after` in `_control.scss`) and the helper function
   (`positionPortalTooltip` in `src/components/Helpers/tooltip.ts`) as-is - this task is entirely about
   wiring the existing mechanism onto every remaining tooltip site, not inventing a new one.

**Verification:** type-check, build, lint. Manual dev-server check across a representative spread, not
just Settings: hover a jog button's tooltip (`JogCNC.tsx`), the distance-selector tooltip, a panel button
tooltip (e.g. `SpindleCNC.tsx` or `ProbeCNC.tsx`), and at least one tab-level tooltip
(`tabs/wifi/index.tsx` or `tabs/interface/index.tsx`) - confirm all of them are now multi-line-capable,
never truncate with "...", and never cause horizontal page scroll, matching the already-fixed Settings
fields exactly. Also confirm no tooltip now shows in the wrong place (e.g. centered on the viewport instead
of near its trigger element) - a sign the `onMouseEnter` wiring didn't actually attach.

**Scope note:** this is a broader-blast-radius change than prior tasks (touches the shared `Button`
component used throughout the app, not just Event Macros). That is intentional and matches the user's
explicit ask ("alle Tooltips gleich behandeln") - but it does mean the review for this task should pay
particular attention to whether the `Button.tsx` change could regress any existing non-tooltip button
usage (e.g. buttons that pass their own `onMouseEnter` for an unrelated reason, buttons with no tooltip at
all - must remain completely unaffected).

## Task 10: Fix Task 9 regression - jog distance-selector tooltips render squeezed/unreadable

**Symptom, reported by the user after testing the Task 9 build on the real device:** every other tooltip
in the app looked correct, except the XY and Z jog step-size selector tooltips (`JogCNC.tsx`, the "mm"
button-group with 0.1/1/10/100 etc. options) - these now render very narrow and dark, with only a couple
of white letters visible, the rest of the text not readable. Before Task 9 (i.e. on the unmodified Spectre
default) it looked better - a normal-looking single-line tooltip near the button, not a squeezed sliver.

**Root cause, already found and empirically confirmed - implement the fix directly, no need to
re-diagnose:** each of these step-size wrapper divs has class
`"flatbtn tooltip tooltip-left tooltip-portal"` (`src/components/Panels/JogCNC.tsx`, five occurrences in
the XY group starting around line 553, five more in the Z group starting around line 717 - grep
`tooltip-portal` in that file to find all ten). Spectre's own `.tooltip-left::after` rule
(`node_modules/spectre.css/src/_tooltips.scss:65-78`) sets `left: auto; right: 100%;` to position the
tooltip to the left of the element. The portal rule (`.tooltip.tooltip-portal::after` in
`src/style/components/_control.scss`) sets `left: var(--tooltip-x, 50%)` but never resets `right`, so
`right: 100%` from the `-left` modifier survives the cascade untouched (confirmed via
`src/style/index.scss`: `@import "./spectre"` on line 4 runs before `@import "./components/control"` on
line 12, so `_control.scss`'s rules win ties over Spectre's - this is exactly why `left` already gets
overridden correctly while `right` doesn't, since only `left` is contested between the two rules). The
result: a `position: fixed` box with both `left` and `right` set and `width: auto` gets its width computed
from the gap between those two anchors instead of from its content/`max-width` - with `left` pinned near
the hovered button and `right: 100%` effectively pinning the right edge at the viewport's left edge, that
gap collapses to something tiny, squeezing the tooltip text into an unreadably narrow box. Same class of
bug would affect `tooltip-right` (leftover `left: 100%` from Spectre) and `tooltip-bottom` (leftover
`transform`/`top`/`bottom` values) if those are ever combined with `tooltip-portal` elsewhere - check
whether any other portal-fixed site in the app combines `tooltip-portal` with a direction modifier
(`tooltip-right`/`tooltip-bottom`/`ltooltip`/`rtooltip`/`btooltip` prop on `Button`/`ButtonImg`, or raw
`tooltip-right`/`tooltip-bottom` class) and fix the same underlying gap there too, not just for
`tooltip-left`.

**The fix:** in `.tooltip.tooltip-portal::after` (`_control.scss`), explicitly reset every positioning
property a direction modifier could set, not just `left`/`bottom`/`top` (already covered) - add
`right: auto;` at minimum, and re-check the modifier source above for anything else a direction class sets
that the portal rule doesn't already override (e.g. `tooltip-right`/`tooltip-bottom`'s `transform` values -
the portal rule already sets its own `transform`, so that one's likely already fine, but verify rather than
assume). The `positionPortalTooltip` JS function (`src/components/Helpers/tooltip.ts`) always positions
above and horizontally centered on the hovered element regardless of any direction modifier - so once the
CSS conflict is resolved, a portal tooltip combined with `tooltip-left`/`tooltip-right`/`tooltip-bottom`
will just render above-centered like every other portal tooltip, ignoring the (now-moot) direction
modifier. That's fine and expected - don't try to make portal tooltips honor direction modifiers, the
existing JS doesn't support that and this bugfix isn't the place to add it.

**Second part of the same report, lower priority, use your judgement:** the user also noted that before
this branch's changes, hovering the step-size group looked like "one tooltip centered above the whole
group", whereas now each individual step-size button shows its own tooltip on hover (all ten wrapper divs
carry the identical text `T("CN18")`). This was already structurally true before Task 9 too (each option
already had its own separate wrapper div and its own `tooltip`/`data-tooltip`) - it's likely just more
noticeable now that the tooltip renders as an actual readable multi-line box instead of a barely-visible
sliver. Once the width bug above is fixed, re-check with the user's description in mind: if it now reads
fine as "a tooltip appears above whichever button you're hovering" (which is a reasonable, correct
behavior, not a bug), leave it as-is. Only consider consolidating to a single shared tooltip on the
button-group's own wrapper (`class="btn-group jog-distance-selector-container"` at line ~547) if the
per-button repetition is genuinely confusing in practice - and if so, keep it minimal (move the
`tooltip`/`data-tooltip`/`onMouseEnter` from the ten individual option divs onto the one group wrapper),
don't invent new markup or copy anything from the sibling `fix/jog-distance-keyboard-shortcuts` branch.

**Verification:** type-check, build, lint. Manual dev-server check: hover each of the ten step-size
options (XY group and Z group) and confirm the tooltip renders as a normal readable box - full text
visible, not squeezed, positioned above the button, clamped to stay inside the viewport like every other
portal tooltip. Also re-check a couple of the Task 9 fixes that use a direction modifier alongside
`tooltip-portal` elsewhere in the app (if any were found during the direction-modifier check above) to
confirm they're fixed too, and re-check a non-direction-modifier portal tooltip (e.g. a jog `+X` button)
still works exactly as before - this fix should only affect the `left`/`right`/etc. properties, nothing
else.
