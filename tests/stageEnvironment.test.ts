import assert from "node:assert/strict";
import test from "node:test";
import { createLocalStage } from "../src/canvas/stageDocument.ts";
import {
  projectStageEnvironment,
  STAGE_ENVIRONMENT_PRESETS,
  STAGE_GROUND_NAME,
  STAGE_GRID_NAME,
  STAGE_LIGHT_NAMES,
} from "../src/canvas/stageEnvironment.ts";

test("environment preset catalog is bounded and uses valid ordinary values", () => {
  assert.deepEqual(STAGE_ENVIRONMENT_PRESETS.map((preset) => preset.preset), ["studio", "warm-sunset", "moonlit"]);
  for (const preset of STAGE_ENVIRONMENT_PRESETS) {
    assert.match(preset.background, /^#[0-9a-f]{6}$/i);
    assert.match(preset.groundColor, /^#[0-9a-f]{6}$/i);
    assert.ok(preset.exposure >= 0 && preset.exposure <= 4);
    assert.deepEqual(Object.keys(preset.lights).sort(), ["fill", "hemisphere", "key"]);
  }
});

test("projects persisted environment facts into deterministic scene roles", () => {
  const stage = createLocalStage();
  stage.background = "#102030";
  stage.environment = {
    preset: "studio",
    groundColor: "#405060",
    groundVisible: false,
    exposure: 2.25,
    backgroundAsset: null,
  };
  stage.lights = [...stage.lights].reverse().map((light) =>
    light.id === "key"
      ? { ...light, color: "#ffccaa", intensity: 4, position: { x: 1, y: 2, z: 3 }, castShadow: false }
      : light,
  );

  const descriptor = projectStageEnvironment(stage);

  assert.equal(descriptor.backgroundColor, "#102030");
  assert.equal(descriptor.backgroundAsset, null);
  assert.equal(descriptor.exposure, 2.25);
  assert.deepEqual(descriptor.ground, { color: "#405060", visible: false });
  assert.deepEqual(descriptor.lights.key, {
    id: "key",
    color: "#ffccaa",
    intensity: 4,
    position: { x: 1, y: 2, z: 3 },
    castShadow: false,
  });
  assert.deepEqual(Object.keys(descriptor.lights).sort(), ["fill", "hemisphere", "key"]);
  assert.equal(STAGE_GROUND_NAME, "stage-ground");
  assert.equal(STAGE_GRID_NAME, "stage-grid");
  assert.deepEqual(STAGE_LIGHT_NAMES, {
    hemisphere: "stage-light-hemisphere",
    key: "stage-light-key",
    fill: "stage-light-fill",
  });
});

test("projection copies vector data instead of retaining persisted references", () => {
  const stage = createLocalStage();
  const descriptor = projectStageEnvironment(stage);
  stage.lights[0]!.position.x = 99;
  assert.equal(descriptor.lights.hemisphere.position.x, 0);
});
