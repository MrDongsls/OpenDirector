import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalStage,
  defaultStageCamera,
  parseLocalStageValue,
  sameLocalStage,
  sampleStage,
  sampleStageCamera,
  sampleStageCameraEndpoint,
  stageCameraEndpointId,
  editStageObjectAt,
  editStageObjectPlacement,
  editStageCameraAt,
  editStageCameraEndpointAt,
  captureStageFrame,
  removeStageFrame,
  stageOutputSize,
  stageExportPlan,
  STAGE_FPS,
  STAGE_RATIOS,
  type StageCameraChannels,
} from "../src/canvas/stageDocument.ts";
import {
  sampleJointPose,
  selectStageAnimation,
  STAGE_ANIMATION_HINTS,
  STAGE_MOTIONS,
} from "../src/canvas/stageMotion.ts";
import {
  createStageHistory,
  commitStageHistory,
  navigateStageHistory,
} from "../src/canvas/stageHistory.ts";

function oldStage() {
  const camera = defaultStageCamera();
  const object = {
    id: "person",
    kind: "person",
    name: "人物",
    color: "#a09af9",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    motion: { preset: "walk", speed: 1.5, amount: 0.8 },
  };
  return {
    format: "opendirector-local-stage",
    version: 1,
    background: "#151923",
    grid: true,
    duration: 6,
    camera,
    objects: [object],
    keyframes: [
      {
        id: "a",
        time: 0,
        camera,
        objects: [{ id: object.id, transform: object }],
      },
      {
        id: "b",
        time: 6,
        camera: { ...camera, position: { x: 11, y: 3.5, z: 7 } },
        objects: [
          {
            id: object.id,
            transform: { ...object, position: { x: 6, y: 6, z: 0 } },
          },
        ],
      },
    ],
  };
}

test("V1 migrates once to independent tracks without changing camera, object or motion sampling", () => {
  const raw = oldStage(),
    stage = parseLocalStageValue(raw),
    pose = sampleStage(stage, 3);
  assert.equal(stage.version, 2);
  assert.equal(stage.fps, 30);
  assert.deepEqual(pose.objects[0]!.position, { x: 3, y: 3, z: 0 });
  assert.equal(pose.camera.position.x, 8);
  assert.equal(pose.objects[0]!.motion?.preset, "walk");
  assert.equal(pose.objects[0]!.motionTime, 3);
  assert.equal(sampleStage(stage, 100).objects[0]!.position.x, 6);
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(stage))),
    stage,
  );
  stage.objects[0]!.keyframes[0]!.value.position.x = 99;
  assert.equal(raw.objects[0]!.position.x, 0);
  assert.equal(sameLocalStage(stage, parseLocalStageValue(raw)), false);
});

test("stage FPS defaults, round-trips, and participates in sameLocalStage without changing sampling", () => {
  const stage = createLocalStage();
  assert.deepEqual(STAGE_FPS, [24, 25, 30, 50, 60]);
  assert.equal(stage.fps, 30);
  const legacyV2 = JSON.parse(JSON.stringify(stage));
  delete legacyV2.fps;
  assert.equal(parseLocalStageValue(legacyV2).fps, 30);
  const explicit = parseLocalStageValue({ ...stage, fps: 60 });
  assert.equal(explicit.fps, 60);
  assert.deepEqual(parseLocalStageValue(JSON.parse(JSON.stringify(explicit))), explicit);
  assert.equal(sameLocalStage(stage, explicit), false);
  assert.deepEqual(sampleStage(stage, 3), sampleStage(explicit, 3));
});

test("stage FPS parser rejects values outside the export contract", () => {
  const stage = createLocalStage();
  for (const fps of [0, 23, 29, 61, true, 24.5]) {
    assert.throws(() => parseLocalStageValue({ ...stage, fps }), /无效|invalid/i);
  }
});

test("object state defaults, migrates, round-trips, and locked objects stay unchanged", () => {
  const stage = createLocalStage();
  const legacy = JSON.parse(JSON.stringify(stage));
  delete legacy.objects[0].visible;
  delete legacy.objects[0].locked;
  delete legacy.objects[0].opacity;
  const migrated = parseLocalStageValue(legacy);
  assert.equal(migrated.objects[0]!.visible, true);
  assert.equal(migrated.objects[0]!.locked, false);
  assert.equal(migrated.objects[0]!.opacity, 1);
  const explicit = parseLocalStageValue({
    ...stage,
    objects: [{ ...stage.objects[0]!, visible: false, locked: true, opacity: 0.35 }],
  });
  assert.deepEqual(parseLocalStageValue(JSON.parse(JSON.stringify(explicit))), explicit);
  assert.equal(sameLocalStage(stage, explicit), false);
  assert.deepEqual(sampleStage(stage, 3).objects[0]!.position, sampleStage(explicit, 3).objects[0]!.position);
  assert.deepEqual(editStageObjectAt(explicit, explicit.objects[0]!.id, 2, { name: "blocked" }), explicit);
  assert.deepEqual(editStageObjectPlacement(explicit, explicit.objects[0]!.id, {
    position: { x: 5, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  }), explicit);
  assert.deepEqual(
    captureStageFrame(explicit, 2).objects[0]!.keyframes,
    explicit.objects[0]!.keyframes,
  );
  for (const patch of [{ visible: 1 }, { locked: 0 }, { opacity: -0.1 }, { opacity: 1.1 }])
    assert.throws(() => parseLocalStageValue({ ...stage, objects: [{ ...stage.objects[0]!, ...patch }] }), /无效|invalid/i);
});
test("environment and lights default, migrate, round-trip, and reject invalid configuration", () => {
  const stage = createLocalStage();
  assert.deepEqual(stage.environment, { preset: "studio", groundColor: "#181818", groundVisible: true, exposure: 1, backgroundAsset: null });
  assert.deepEqual(stage.lights.map(({ id, intensity, position, castShadow }) => ({ id, intensity, position, castShadow })), [
    { id: "hemisphere", intensity: 2.4, position: { x: 0, y: 1, z: 0 }, castShadow: false },
    { id: "key", intensity: 3.5, position: { x: 5, y: 10, z: 6 }, castShadow: true },
    { id: "fill", intensity: 1.6, position: { x: -6, y: 5, z: -5 }, castShadow: false },
  ]);
  const legacy = JSON.parse(JSON.stringify(stage));
  delete legacy.environment;
  delete legacy.lights;
  const migrated = parseLocalStageValue(legacy);
  assert.deepEqual(migrated.environment, stage.environment);
  assert.deepEqual(migrated.lights, stage.lights);
  const explicit = parseLocalStageValue({
    ...stage,
    environment: { preset: "studio", groundColor: "#202020", groundVisible: false, exposure: 2.25, backgroundAsset: null },
    lights: stage.lights.map((light) => light.id === "key" ? { ...light, intensity: 4.2 } : light),
  });
  assert.deepEqual(parseLocalStageValue(JSON.parse(JSON.stringify(explicit))), explicit);
  const oldEnvironment = { ...explicit, environment: { preset: "studio", groundColor: "#202020", groundVisible: false } };
  assert.equal(parseLocalStageValue(oldEnvironment).environment.exposure, 1);
  assert.equal(sameLocalStage(stage, explicit), false);
  assert.deepEqual(sampleStage(stage, 3), sampleStage(explicit, 3));
  for (const invalid of [
    { environment: { ...stage.environment, preset: "sunset" } },
    { environment: { ...stage.environment, groundColor: "#fff" } },
    { environment: { ...stage.environment, exposure: -0.1 } },
    { environment: { ...stage.environment, exposure: 4.1 } },
    { environment: { ...stage.environment, backgroundAsset: {
      assetId: "00000000-0000-0000-0000-000000000001",
      revision: 1,
      fingerprint: `sha256:${"0".repeat(64)}`,
      kind: "file",
    } } },
    { lights: stage.lights.slice(0, 2) },
    { lights: stage.lights.map((light) => light.id === "key" ? { ...light, intensity: 11 } : light) },
    { lights: stage.lights.map((light) => light.id === "key" ? { ...light, color: "#fff" } : light) },
    { lights: stage.lights.map((light) => light.id === "key" ? { ...light, position: { x: 0, y: 0 } } : light) },
  ]) assert.throws(() => parseLocalStageValue({ ...stage, ...invalid }), /无效|invalid/i);
});
test("camera channels round-trip independently and a position edit does not touch target or focal length", () => {
  const stage = createLocalStage();
  const camera = stage.cameras[0]!;
  const explicit = parseLocalStageValue({
    ...stage,
    cameras: [{
      ...camera,
      channels: {
        position: [{ id: "p", time: 2, value: { x: 8, y: 4, z: 6 } }],
        target: [{ id: "t", time: 2, value: { x: 1, y: 2, z: 0 } }],
        up: [{ id: "u", time: 2, value: { x: 0, y: 1, z: 0 } }],
        focalLength: [{ id: "f", time: 2, value: 55 }],
      },
    }],
  });
  const roundTrip = parseLocalStageValue(JSON.parse(JSON.stringify(explicit)));
  assert.deepEqual(roundTrip.cameras[0]!.channels, explicit.cameras[0]!.channels);
  const edited = editStageCameraAt(explicit, "camera-1", 2, {
    position: { x: 10, y: 4, z: 6 },
  });
  const channels = edited.cameras[0]!.channels!;
  assert.equal(channels.position.at(-1)!.value.x, 10);
  assert.equal(edited.cameras[0]!.keyframes.at(-1)!.time, 2);
  assert.deepEqual(channels.target, explicit.cameras[0]!.channels!.target);
  assert.deepEqual(channels.up, explicit.cameras[0]!.channels!.up);
  assert.deepEqual(channels.focalLength, explicit.cameras[0]!.channels!.focalLength);
});

test("camera and viewpoint endpoints have stable identities and independent edits", () => {
  const stage = createLocalStage();
  const camera = sampleStageCameraEndpoint(stage, "camera-1", "camera", 0);
  const viewpoint = sampleStageCameraEndpoint(stage, "camera-1", "viewpoint", 0);
  assert.equal(stageCameraEndpointId("camera-1", "camera"), "camera-1:camera");
  assert.equal(stageCameraEndpointId("camera-1", "viewpoint"), "camera-1:viewpoint");
  assert.deepEqual(camera, {
    id: "camera-1:camera",
    cameraId: "camera-1",
    kind: "camera",
    position: stage.cameras[0]!.pose.position,
  });
  assert.deepEqual(viewpoint, {
    id: "camera-1:viewpoint",
    cameraId: "camera-1",
    kind: "viewpoint",
    position: stage.cameras[0]!.pose.target,
  });

  const movedCamera = editStageCameraEndpointAt(
    stage,
    "camera-1",
    "camera",
    0,
    { x: 8, y: 4, z: 6 },
  );
  assert.deepEqual(sampleStageCamera(movedCamera, "camera-1", 0), {
    ...stage.cameras[0]!.pose,
    position: { x: 8, y: 4, z: 6 },
  });
  assert.deepEqual(
    sampleStageCameraEndpoint(movedCamera, "camera-1", "viewpoint", 0).position,
    viewpoint.position,
  );

  const movedViewpoint = editStageCameraEndpointAt(
    stage,
    "camera-1",
    "viewpoint",
    0,
    { x: 1, y: 2, z: 0 },
  );
  assert.deepEqual(sampleStageCamera(movedViewpoint, "camera-1", 0), {
    ...stage.cameras[0]!.pose,
    target: { x: 1, y: 2, z: 0 },
  });
  assert.deepEqual(
    sampleStageCameraEndpoint(movedViewpoint, "camera-1", "camera", 0).position,
    camera.position,
  );
  assert.throws(
    () =>
      editStageCameraEndpointAt(
        stage,
        "camera-1",
        "viewpoint",
        0,
        camera.position,
      ),
    /摄像机|camera/i,
  );
});

test("camera channels reject malformed values and old keyframes keep their sampled result", () => {
  const legacy = parseLocalStageValue(oldStage());
  assert.equal(legacy.cameras[0]!.aspectRatio, "16:9");
  assert.equal(legacy.cameras[0]!.channels!.position.length, 2);
  assert.equal(sampleStage(legacy, 3).camera.position.x, 8);
  const oldV2 = createLocalStage();
  delete (oldV2.cameras[0] as { channels?: StageCameraChannels }).channels;
  const migratedV2 = parseLocalStageValue(oldV2);
  assert.deepEqual(migratedV2.cameras[0]!.channels, {
    position: [],
    target: [],
    up: [],
    focalLength: [],
  });
  assert.equal(migratedV2.cameras[0]!.aspectRatio, "16:9");
  assert.throws(() => parseLocalStageValue({
    ...createLocalStage(),
    cameras: [{
      ...createLocalStage().cameras[0]!,
      channels: {
        position: [{ id: "p", time: 2, value: { x: 1, y: 2, z: 3 } }],
        target: [],
        up: [],
        focalLength: [{ id: "f", time: 2, value: 0 }],
      },
    }],
  }), /摄像机|camera/i);
});
test("legacy malformed references and duplicate frame times remain rejected during migration", () => {
  const raw = oldStage();
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        keyframes: [
          ...raw.keyframes,
          { ...raw.keyframes[0], id: "duplicate-time" },
        ],
      }),
    /不能重复/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        keyframes: [
          {
            ...raw.keyframes[0],
            objects: [{ id: "missing", transform: raw.objects[0] }],
          },
        ],
      }),
    /缺失/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        objects: [{ ...raw.objects[0], kind: "box" }],
      }),
    /只有人物/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        camera: { ...raw.camera, target: raw.camera.position },
      }),
    /摄像机/,
  );
});

test("editing one axis at the playhead preserves the other sampled axes and untouched tracks", () => {
  const stage = parseLocalStageValue(oldStage());
  const at = sampleStage(stage, 3);
  const edited = editStageObjectAt(stage, "person", 3, {
    position: { ...at.objects[0]!.position, y: 4 },
  });
  assert.deepEqual(sampleStage(edited, 3).objects[0]!.position, {
    x: 3,
    y: 4,
    z: 0,
  });
  assert.deepEqual(sampleStage(edited, 0).objects[0]!.position, {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.deepEqual(sampleStage(edited, 6).objects[0]!.position, {
    x: 6,
    y: 6,
    z: 0,
  });
  assert.deepEqual(edited.cameras, stage.cameras);
  const camera = sampleStageCamera(edited, "camera-1", 3);
  const cameraEdit = editStageCameraAt(edited, "camera-1", 3, {
    position: { ...camera.position, y: 5 },
  });
  assert.deepEqual(sampleStage(cameraEdit, 3).camera.position, {
    x: 8,
    y: 5,
    z: 7,
  });
  assert.deepEqual(cameraEdit.objects, edited.objects);
});

test("the first edit away from zero anchors the opening pose; unchanged orbit commits create no undo step", () => {
  const stage = createLocalStage(),
    id = stage.objects[0]!.id;
  const moved = editStageObjectAt(stage, id, 4, {
    position: { x: 4, y: 2, z: 0 },
  });
  assert.deepEqual(sampleStage(moved, 0).objects[0]!.position, {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.deepEqual(sampleStage(moved, 2).objects[0]!.position, {
    x: 2,
    y: 1,
    z: 0,
  });
  const camera = sampleStage(stage, 0).camera;
  assert.equal(
    editStageCameraAt(stage, stage.activeCameraId, 3, camera),
    stage,
  );
  const history = createStageHistory(stage);
  assert.equal(
    commitStageHistory(
      history,
      editStageCameraAt(stage, stage.activeCameraId, 3, camera),
    ),
    history,
  );
  const renamed = editStageObjectAt(moved, id, 2, { name: "改名" });
  assert.deepEqual(renamed.objects[0]!.position, moved.objects[0]!.position);
  assert.deepEqual(renamed.objects[0]!.keyframes, moved.objects[0]!.keyframes);
});

test("an orbit end within renderer float noise commits no camera edit", () => {
  const stage = createLocalStage();
  // setCamera round-trips the pose through the renderer's spherical camera
  // math, so an unchanged camera can read back one ulp away; that must stay
  // a no-op instead of authoring an epsilon pose with a keyframe.
  const camera = sampleStage(stage, 0).camera;
  const drifted = {
    ...camera,
    position: {
      x: camera.position.x + 1e-15,
      y: camera.position.y,
      z: camera.position.z,
    },
  };
  const history = createStageHistory(stage);
  assert.equal(
    commitStageHistory(
      history,
      editStageCameraAt(stage, stage.activeCameraId, 3, drifted),
    ),
    history,
  );
  // A real camera move still commits and anchors the opening pose.
  const moved = editStageCameraAt(stage, stage.activeCameraId, 3, {
    ...camera,
    position: { x: 6, y: camera.position.y, z: camera.position.z },
  });
  assert.notEqual(moved, stage);
  assert.equal(moved.cameras[0]!.keyframes.length, 2);
});

test("placement dragging rewrites the base transform without authoring keyframes", () => {
  const stage = createLocalStage(),
    id = stage.objects[0]!.id;
  const placed = editStageObjectPlacement(stage, id, {
    position: { x: 3, y: 1, z: -2 },
    rotation: { x: 0, y: 1.2, z: 0 },
    scale: { x: 2, y: 2, z: 2 },
  });
  // Unlike a playhead edit, no anchor frame appears at t=0.
  assert.deepEqual(placed.objects[0]!.keyframes, []);
  assert.deepEqual(placed.objects[0]!.position, { x: 3, y: 1, z: -2 });
  assert.deepEqual(placed.objects[0]!.rotation, { x: 0, y: 1.2, z: 0 });
  assert.deepEqual(placed.objects[0]!.scale, { x: 2, y: 2, z: 2 });
  for (const at of [0, 2, stage.duration])
    assert.deepEqual(sampleStage(placed, at).objects[0]!.position, {
      x: 3,
      y: 1,
      z: -2,
    });
  assert.equal(
    editStageObjectPlacement(stage, "missing", {
      position: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    }),
    stage,
  );
  assert.throws(
    () =>
      editStageObjectPlacement(stage, id, {
        position: { x: 1, y: 1, z: 1 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 0, y: 1, z: 1 },
      }),
    /无效/,
  );
});

test("placement on keyframed subjects changes only their base transform", () => {
  const stage = parseLocalStageValue(oldStage());
  stage.objects.push({
    id: "box",
    kind: "box",
    name: "木箱",
    color: "#80c9c0",
    position: { x: 2, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    locked: false,
    opacity: 1,
    keyframes: [],
    motionClips: [],
  });
  const parsed = parseLocalStageValue(stage);
  const placed = editStageObjectPlacement(parsed, "person", {
    position: { x: 9, y: 1, z: 2 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  assert.deepEqual(placed.objects[0]!.keyframes, parsed.objects[0]!.keyframes);
  assert.deepEqual(placed.objects[0]!.position, { x: 9, y: 1, z: 2 });
  // The keyframed track still owns sampling; the base write stays UI-gated.
  assert.deepEqual(sampleStage(placed, 3).objects[0]!.position, {
    x: 3,
    y: 3,
    z: 0,
  });
  const other = editStageObjectPlacement(placed, "box", {
    position: { x: -1, y: 0, z: 4 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  assert.deepEqual(other.objects[0]!.keyframes, parsed.objects[0]!.keyframes);
  assert.deepEqual(other.objects[1]!.keyframes, []);
  assert.deepEqual(other.objects[1]!.position, { x: -1, y: 0, z: 4 });
});

test("current-frame capture and removal affect every sampled track, while history restores deleted objects and clips", () => {
  const stage = parseLocalStageValue(oldStage());
  let history = createStageHistory(stage);
  history = commitStageHistory(history, captureStageFrame(stage, 3));
  assert.equal(history.present.objects[0]!.keyframes.length, 3);
  history = commitStageHistory(history, { ...history.present, objects: [] });
  const restored = navigateStageHistory(history, "undo");
  assert.equal(restored.present.objects[0]!.motionClips.length, 1);
  assert.equal(restored.present.objects[0]!.keyframes.length, 3);
  assert.equal(
    navigateStageHistory(restored, "redo").present.objects.length,
    0,
  );
  const branched = commitStageHistory(
    restored,
    removeStageFrame(restored.present, 3),
  );
  assert.equal(branched.future.length, 0);
  assert.equal(branched.present.objects[0]!.keyframes.length, 2);
  assert.equal(branched.present.cameras[0]!.keyframes.length, 2);
  assert.equal(
    commitStageHistory(branched, structuredClone(branched.present)),
    branched,
  );
});

test("consecutive action clips switch exactly at boundaries, restart phase and leave gaps idle", () => {
  const stage = createLocalStage();
  stage.objects[0]!.motionClips = [
    {
      id: "walk",
      start: 0,
      duration: 2,
      motion: { preset: "walk", speed: 1, amount: 1 },
    },
    {
      id: "wave",
      start: 2,
      duration: 2,
      motion: { preset: "wave", speed: 2, amount: 0.5 },
    },
  ];
  const parsed = parseLocalStageValue(stage);
  assert.equal(sampleStage(parsed, 1.999).objects[0]!.motion?.preset, "walk");
  assert.equal(sampleStage(parsed, 2).objects[0]!.motion?.preset, "wave");
  assert.equal(sampleStage(parsed, 2).objects[0]!.motionTime, 0);
  const sample = sampleStage(parsed, 2.125).objects[0]!;
  assert.deepEqual(
    sampleJointPose(sample.motion, sample.motionTime),
    sampleJointPose({ preset: "wave", speed: 2, amount: 0.5 }, 0.125),
  );
  assert.equal(sampleStage(parsed, 4).objects[0]!.motion, undefined);
  assert.ok(Object.values(sampleJointPose(undefined, 0)).every((v) => v === 0));
  const changed = structuredClone(parsed);
  changed.objects[0]!.motionClips[1]!.motion.speed = 3;
  assert.equal(sameLocalStage(parsed, changed), false);
});

test("clips reject overlaps, invalid rates, out-of-bounds times and non-character owners", () => {
  const stage = createLocalStage();
  const clip = {
    id: "a",
    start: 0,
    duration: 2,
    motion: { preset: "walk", speed: 1, amount: 1 },
  };
  for (const clips of [
    [clip, { ...clip, id: "b", start: 1 }],
    [{ ...clip, start: 5 }],
    [{ ...clip, start: -1 }],
    [{ ...clip, duration: 0 }],
    [{ ...clip, motion: { ...clip.motion, speed: 0 } }],
    [{ ...clip, motion: { ...clip.motion, preset: "missing" } }],
  ])
    assert.throws(() =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...stage.objects[0], motionClips: clips }],
      }),
    );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...stage.objects[0], kind: "box", motionClips: [clip] }],
      }),
    /只有人物/,
  );
});

test("storyboard hard cuts use independent camera animation, hold the last frame, and share JSON/MP4 sample semantics", () => {
  let stage = createLocalStage();
  stage.cameras.push({
    id: "b",
    name: "反打",
    pose: { ...defaultStageCamera(), position: { x: -5, y: 3.5, z: 7 } },
    keyframes: [],
  });
  stage = editStageCameraAt(stage, "camera-1", 0, {
    position: { x: 1, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "camera-1", 6, {
    position: { x: 7, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "b", 0, {
    position: { x: -1, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "b", 6, {
    position: { x: -7, y: 3.5, z: 7 },
  });
  stage.cameraSource = "storyboard";
  stage.shots = [
    { id: "first", cameraId: "camera-1", start: 0, duration: 2 },
    { id: "reverse", cameraId: "b", start: 2, duration: 4 },
  ];
  const reloaded = parseLocalStageValue(JSON.parse(JSON.stringify(stage)));
  assert.equal(sampleStage(reloaded, 2 - 1 / 30).cameraId, "camera-1");
  assert.equal(sampleStage(reloaded, 2).cameraId, "b");
  assert.equal(sampleStage(reloaded, 2).camera.position.x, -3);
  assert.equal(sampleStage(reloaded, 6).camera.position.x, -7);
  assert.equal(
    sampleStage({ ...reloaded, cameraSource: "camera" }, 3).cameraId,
    "camera-1",
  );
  assert.equal(
    sampleStage({ ...reloaded, shots: [reloaded.shots[1]!] }, 1).cameraId,
    "camera-1",
  );
  for (const at of [0, 1 / 30, 1.99, 2, 3, 5.99])
    assert.deepEqual(sampleStage(reloaded, at), sampleStage(stage, at));
  assert.equal(sameLocalStage(stage, reloaded), true);
  assert.equal(
    sameLocalStage(stage, { ...reloaded, cameraSource: "camera" }),
    false,
  );
});

test("camera and storyboard persistence rejects dangling IDs, duplicate camera IDs and overlapping cuts", () => {
  const stage = createLocalStage();
  const shot = {
    id: "a",
    cameraId: stage.activeCameraId,
    start: 0,
    duration: 2,
  };
  assert.throws(
    () => parseLocalStageValue({ ...stage, cameras: [] }),
    /摄像机/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        cameras: [stage.cameras[0], stage.cameras[0]],
      }),
    /摄像机/,
  );
  assert.throws(
    () => parseLocalStageValue({ ...stage, activeCameraId: "missing" }),
    /摄像机/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        shots: [{ ...shot, cameraId: "missing" }],
      }),
    /分镜/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        shots: [shot, { ...shot, id: "b", start: 1 }],
      }),
    /重叠/,
  );
  assert.throws(
    () => parseLocalStageValue({ ...stage, shots: [{ ...shot, start: 5 }] }),
    /时长/,
  );
});

test("supported preview and output frames have one exact aspect with even encoder dimensions", () => {
  for (const ratio of STAGE_RATIOS) {
    const { width, height } = stageOutputSize(ratio),
      [w, h] = ratio.split(":").map(Number);
    // Even encoder dimensions cannot express every ratio exactly
    // (2.39:1 lands on 1280x536); keep the aspect within one percent.
    assert.ok(Math.abs(width / height - w! / h!) < 0.01);
    assert.equal(width % 2, 0);
    assert.equal(height % 2, 0);
    assert.equal(Math.max(width, height), 1280);
    const narrowWidth = 270;
    assert.equal(
      narrowWidth / ((narrowWidth * height) / width),
      width / height,
    );
  }
  assert.throws(() =>
    parseLocalStageValue({ ...createLocalStage(), aspectRatio: "0:1" }),
  );
});

test("motion presets pick imported clips by contained name hints, clip order first", () => {
  assert.deepEqual(
    Object.keys(STAGE_ANIMATION_HINTS).sort(),
    Object.keys(STAGE_MOTIONS).sort(),
  );
  const clips = [
    { name: "mixamo.com" },
    { name: "Standing_Idle" },
    { name: "Walk Forward" },
  ];
  assert.equal(selectStageAnimation(clips, "walk")!.name, "Walk Forward");
  assert.equal(selectStageAnimation(clips, "idle")!.name, "Standing_Idle");
  assert.equal(selectStageAnimation([{ name: "WALK" }], "walk")!.name, "WALK");
  assert.equal(selectStageAnimation(clips, "run")!.name, "mixamo.com");
  assert.equal(selectStageAnimation([], "walk"), undefined);
  const ordered = [{ name: "Walking_slow" }, { name: "Walk_fast" }];
  assert.equal(
    selectStageAnimation(ordered, "walk")!.name,
    "Walking_slow",
  );
});

test("the production canvas boundary persists the full edited stage and its changes participate in canvas undo", async () => {
  const { createDocument, createNode } = await import("../src/canvas/model.ts");
  const { serializeDocument, parseDocument } =
    await import("../src/canvas/storage.ts");
  const { createHistory, recordChange, undo, redo } =
    await import("../src/canvas/history.ts");
  const node = createNode("external");
  const stage = parseLocalStageValue(oldStage());
  stage.cameras.push({
    id: "second",
    name: "侧面",
    aspectRatio: "16:9",
    pose: { ...defaultStageCamera(), position: { x: -5, y: 4, z: 0 } },
    channels: { position: [], target: [], up: [], focalLength: [] },
    keyframes: [],
  });
  stage.cameraSource = "storyboard";
  stage.aspectRatio = "9:16";
  stage.shots = [{ id: "cut", cameraId: "second", start: 2, duration: 4 }];
  const document = { ...createDocument(), nodes: [node] };
  const edited = {
    ...document,
    nodes: [{ ...node, data: { ...node.data, localStage: stage } }],
  };
  const encoded = serializeDocument(edited);
  assert.ok(encoded.ok);
  if (!encoded.ok) return;
  const decoded = parseDocument(encoded.value);
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.value.nodes[0]!.data.localStage, stage);
  const history = recordChange(createHistory(document), decoded.value);
  assert.equal(history.past.length, 1);
  assert.deepEqual(undo(history).present, document);
  assert.deepEqual(redo(undo(history)).present, decoded.value);
  const legacy = parseDocument({
    ...document,
    nodes: [{ ...node, data: { ...node.data, localStage: oldStage() } }],
  });
  assert.ok(legacy.ok);
  if (legacy.ok)
    assert.equal(legacy.value.nodes[0]!.data.localStage!.version, 2);
});

test("export plans concatenate the storyboard and skip uncovered gaps", () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    duration: 8,
    cameras: [
      {
        id: "camera-1",
        name: "Camera 1",
        pose: defaultStageCamera(),
        keyframes: [],
      },
      {
        id: "b",
        name: "Camera B",
        pose: defaultStageCamera(),
        keyframes: [],
      },
    ],
    shots: [
      { id: "first", cameraId: "camera-1", start: 0, duration: 2 },
      { id: "later", cameraId: "b", start: 4, duration: 1.5 },
    ],
  });
  const plan = stageExportPlan(stage, "storyboard");
  assert.equal(plan.duration, 3.5);
  // Export time 0..2 covers the first shot's document window.
  assert.equal(plan.timeAt(0), 0);
  assert.equal(plan.timeAt(1.5), 1.5);
  // The uncovered 2..4 document gap never appears in the export.
  assert.equal(plan.timeAt(2), 4);
  assert.equal(plan.timeAt(3.5), 5.5);
  assert.equal(sampleStage(plan.stage, plan.timeAt(1)).cameraId, "camera-1");
  assert.equal(sampleStage(plan.stage, plan.timeAt(2.5)).cameraId, "b");
  // The draft keeps its own camera strategy; only the plan changed.
  assert.equal(stage.cameraSource, "camera");
});

test("export plans pin one camera for the whole document and validate the source", () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    duration: 5,
    cameras: [
      {
        id: "camera-1",
        name: "Camera 1",
        pose: defaultStageCamera(),
        keyframes: [],
      },
      {
        id: "b",
        name: "Camera B",
        pose: defaultStageCamera(),
        keyframes: [],
      },
    ],
    cameraSource: "storyboard",
    shots: [{ id: "only", cameraId: "b", start: 0, duration: 5 }],
  });
  const plan = stageExportPlan(stage, "camera-1");
  assert.equal(plan.duration, 5);
  assert.equal(plan.timeAt(4.2), 4.2);
  assert.equal(plan.stage.cameraSource, "camera");
  assert.equal(plan.stage.activeCameraId, "camera-1");
  assert.throws(() => stageExportPlan(stage, "nope"), /camera|摄像机/);
  assert.throws(
    () =>
      stageExportPlan(parseLocalStageValue(createLocalStage()), "storyboard"),
    /shot|分镜/,
  );
});
