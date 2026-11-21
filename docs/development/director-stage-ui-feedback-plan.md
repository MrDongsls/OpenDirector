# Director Stage UI feedback follow-up

This plan tracks the three follow-up changes identified from the annotated
Director Stage comparison against the local Jiemeng reference screenshots.
Work stays on the semantic `feat/stage-gizmo-placement` branch.

## Acceptance stages

| Stage | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| F1 | Transform tool mode | Move, rotate, and scale are a discriminated single-choice state; only the selected helper is visible and keyboard/buttons preserve that invariant | complete |
| F2 | Asset card previews | Stage object cards show a PNG thumbnail rendered from the corresponding 3D object at the origin, centered and cropped from the render; imported objects use their loaded scene when available | complete |
| F3 | Object tree and inspector layout | Right rail follows the reference split between searchable object tree and property inspector, with stable grouping and scroll behavior | planned |

Each stage requires a focused behavior or browser check, the relevant project
checks, and a signed Git commit before the next stage begins.
