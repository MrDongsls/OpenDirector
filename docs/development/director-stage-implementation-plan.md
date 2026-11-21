# Director Stage implementation plan

This plan keeps the Director Stage work in reviewable, dependency-ordered
feature branches. Each branch owns a complete user-facing capability and is
stacked on the branch immediately before it.

## Branch stack

1. `feat/stage-output-assets` — output assets, frozen render plans, and the
   publication contract.
2. `feat/stage-fullscreen` — the Director Stage shell, full-screen layout, and
   shared stage geometry contracts.
3. `feat/director-stage-assets` — asset rail cards, thumbnail capture, and
   registered asset references.
4. `feat/stage-gizmo-placement` — the editable stage core: placement from
   preview cards, mutually exclusive transform tools, viewport/view state,
   object tree and inspector, timeline editing, environment controls, and
   persistence validation.
5. `feat/stage-camera-rigs` — independent camera rigs, viewpoint controls,
   Director View, and camera monitors.
6. `feat/stage-agent-publish` — the parallel agent publication capability,
   based on the shared stage core and independent of the camera UI.

## Delivery rules

- Keep a branch limited to its capability and the contracts it must expose to
  the next branch.
- Move a prerequisite to the lowest branch that needs it; do not duplicate it
  in a later feature branch.
- Every feature unit includes focused tests, a production build, bilingual
  message validation, and the relevant Python contract tests.
- Every code-ready unit receives a semantic signed commit with a body starting
  with `## summary`.
- Rebase the stack from low to high only after the lower branch passes its
  checks. Keep the branches local until the review targets are agreed.

## Acceptance boundary

The Director Stage document is the persisted source of business facts. View
state, selection, preview mode, split view, menus, and interaction modes stay
ephemeral. Asset cards and agent operations use the same placement and apply
contracts as direct user interaction. Camera preview output is independent
from the main Director View and does not make viewpoint movement move the main
stage camera.
