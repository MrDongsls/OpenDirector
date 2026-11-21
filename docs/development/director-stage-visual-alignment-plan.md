# Director Stage visual alignment plan

This execution plan tracks the visual-alignment work against the native Jiemeng
Director Stage screenshots referenced by the external audit plan. It is scoped
to the existing `feat/stage-fullscreen` branch because the branch owns the
Director Stage shell, layout, asset tabs, and viewport tools.

The reference is the screenshot set in the local audit workspace:

`C:\Users\10425\.zcode\workspace\draft-9c960b48-85bb-4dbe-8ee1-03eba20460c0\jimeng-canvas-audit\screenshots`

Primary comparison states:

- `02-director-console.png`: static console shell.
- `09-director-console-dynamic.png`: dynamic-mode transition.
- `11-director-console-dynamic-mode.png`: dynamic console and timeline.
- `12-director-console-camera-moves.png`: camera-move asset tab.
- `13-director-console-view-settings.png`: viewport settings popover.
- `14-director-console-shoot.png`: camera/shoot view.

## Rules

- Match the reference geometry, spacing, density, color hierarchy, and state
  transitions before introducing new visual language.
- Keep the 3D viewport as the base layer. Panels are full-height workbench
  regions or overlays, not document-flow dialogs.
- Keep business values and bilingual message keys unchanged while changing
  presentation.
- Work on the existing semantic branch. Do not create a new branch for this
  alignment pass.
- Each stage must have a browser screenshot or computed-geometry check, the
  smallest relevant automated checks, and a signed commit (`commit -s`).
- After the shell commits land, rebase `feat/stage-gizmo-placement` onto this
  branch before continuing work that depends on the shell.

## Stages

| Stage | Scope | Reference states | Acceptance | Status |
| --- | --- | --- | --- | --- |
| V1 | Workbench shell geometry and base color tokens: top bar, left asset rail, right inspector, viewport bounds, and bottom timeline boundary | 02, 11 | No floating-dialog margins on the main shell; panel widths and boundaries are stable at 1920×1080 and 1700×1100; existing console browser flow remains green | complete |
| V2 | Top bar and asset-library density: compact actions, mode switch, asset tabs, search, cards, and active states | 02, 11, 12 | Header and left rail follow the reference rhythm; active tab and compact control states are visible and keyboard accessible | complete |
| V3 | Object tree and inspector hierarchy: grouped rows, section dividers, fields, toggles, and scroll behavior | 02, 11, 13 | Right side reads as object tree above properties; selected/empty states preserve the same geometry | complete |
| V4 | Dynamic timeline: transport, ruler, tracks, playhead, frame/keyframe density, and dynamic/static state transition | 09, 11, 12 | Dynamic mode exposes the timeline with reference density; static mode does not reserve an unexplained editor area | planned |
| V5 | Viewport overlays and transient surfaces: tool rail, PiP, settings menu, viewfinder, help, and shoot state | 03, 13, 14 | Each overlay matches its reference anchor, z-order, padding, and dismissal behavior | planned |
| V6 | Screenshot matrix and rebase handoff | 02, 09, 11–14 | Capture before/after comparison evidence, run required checks, commit, then rebase `feat/stage-gizmo-placement` and rerun its browser lanes | planned |
