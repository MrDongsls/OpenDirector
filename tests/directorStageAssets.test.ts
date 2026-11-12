import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalStage,
  parseLocalStageValue,
  sameLocalStage,
} from "../src/canvas/stageDocument.ts";

const asset = {
  assetId: "asset-gltf",
  revision: 2,
  fingerprint: `sha256:${"a".repeat(64)}`,
  kind: "file" as const,
};

test("GLB/GLTF stage objects accept transient previews and retain stable asset identity", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const imported = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "character",
        format: "glb",
        source: "blob:director-preview",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  assert.equal(imported.objects[0]!.asset?.assetId, "asset-gltf");
  assert.equal(imported.objects[0]!.source, "blob:director-preview");
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(imported))),
    imported,
  );
  assert.equal(
    sameLocalStage(
      imported,
      parseLocalStageValue({
        ...imported,
        objects: [{ ...imported.objects[0]!, source: "blob:reloaded" }],
      }),
    ),
    true,
  );
});

test("a new local imported object may be previewed before its first project save", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const parsed = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "scene",
        format: "gltf",
        source: "blob:unsaved-scene",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  assert.equal(parsed.objects[0]!.asset, undefined);
  assert.equal(parsed.objects[0]!.role, "scene");
});

test("imported asset validation rejects missing identity, scene motion and absent animation data", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const base = {
    ...person,
    kind: "gltf",
    role: "character",
    format: "glb",
    asset,
    animationNames: [],
    hasAnimation: false,
    motionClips: [],
  };
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...base, asset: undefined }],
      }),
    /舞台对象/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            role: "scene",
            motionClips: [
              {
                id: "scene-motion",
                start: 0,
                duration: 1,
                motion: { preset: "idle", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /场景素材/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            motionClips: [
              {
                id: "missing-animation",
                start: 0,
                duration: 1,
                motion: { preset: "walk", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /没有动画/,
  );
});
