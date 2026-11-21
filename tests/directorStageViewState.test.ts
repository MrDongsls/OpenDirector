import assert from "node:assert/strict";
import test from "node:test";
import {
  createDirectorStageViewState,
  directorStageViewReducer,
} from "../src/canvas/directorStageViewState.ts";

function reduce(
  state: ReturnType<typeof createDirectorStageViewState>,
  ...actions: Parameters<typeof directorStageViewReducer>[1][]
) {
  return actions.reduce(directorStageViewReducer, state);
}

test("initial view state contains only ephemeral stage-session concerns", () => {
  const state = createDirectorStageViewState("person");

  assert.deepEqual(state.selection, { kind: "object", objectId: "person" });
  assert.equal(state.interactionMode.kind, "edit");
  assert.equal(state.cameraPreview, true);
  assert.equal(state.cameraPreviewCameraId, null);
  assert.equal(state.previewMode, "static");
  assert.deepEqual(state.splitView, { kind: "closed", ratio: 0.5 });
  assert.equal(state.drawerOpen, false);
  assert.equal(state.helpOpen, false);
  assert.deepEqual(state.selectedStillIds, new Set<string>());
  assert.equal(state.lastExportFps, null);
  assert.deepEqual(state.exportDialog, {
    kind: "closed",
    source: "",
    clarity: 1280,
    fps: 30,
  });
  assert.equal("objects" in state, false);
  assert.equal("cameras" in state, false);
  assert.equal("duration" in state, false);
});

test("viewfinder and roam transitions keep interaction modes exclusive", () => {
  const initial = createDirectorStageViewState(null);
  const viewfinder = reduce(initial, { type: "toggleViewfinder" });

  assert.deepEqual(viewfinder.interactionMode, { kind: "viewfinder" });
  assert.equal(viewfinder.cameraPreview, true);
  assert.equal(viewfinder.viewFlags.aspectMask, true);

  const roam = reduce(viewfinder, { type: "toggleRoam" });
  assert.deepEqual(roam.interactionMode, { kind: "roam" });
  assert.equal(roam.cameraPreview, false);
  assert.notEqual(roam.interactionMode.kind, "viewfinder");

  const edit = reduce(roam, { type: "toggleRoam" });
  assert.deepEqual(edit.interactionMode, { kind: "edit" });
});

test("placement is a cancellable two-step interaction mode", () => {
  const initial = createDirectorStageViewState(null);
  const armed = reduce(initial, {
    type: "armPlacement",
    objectKind: "person",
    sourceObjectId: null,
  });

  assert.deepEqual(armed.interactionMode, {
    kind: "placement",
    objectKind: "person",
    sourceObjectId: null,
  });
  const cancelled = reduce(armed, { type: "cancelPlacement" });
  assert.deepEqual(cancelled.interactionMode, { kind: "edit" });
  assert.deepEqual(
    reduce(initial, { type: "cancelPlacement" }),
    initial,
  );
});

test("placement can retain the preview object's source identity", () => {
  const armed = reduce(createDirectorStageViewState(null), {
    type: "armPlacement",
    objectKind: "gltf",
    sourceObjectId: "imported-character",
  });

  assert.deepEqual(armed.interactionMode, {
    kind: "placement",
    objectKind: "gltf",
    sourceObjectId: "imported-character",
  });
});
test("camera presets arm an exclusive target-object placement mode", () => {
  const initial = createDirectorStageViewState(null);
  const armed = reduce(initial, {
    type: "armCameraPreset",
    preset: "frontMedium",
  });

  assert.deepEqual(armed.interactionMode, {
    kind: "cameraPreset",
    preset: "frontMedium",
  });
  assert.deepEqual(
    reduce(armed, { type: "cancelCameraPreset" }).interactionMode,
    { kind: "edit" },
  );
  assert.deepEqual(
    reduce(
      armed,
      { type: "armPlacement", objectKind: "person", sourceObjectId: null },
    ).interactionMode,
    { kind: "placement", objectKind: "person", sourceObjectId: null },
  );
  assert.deepEqual(
    reduce(armed, { type: "armCameraPreset", preset: "frontMedium" })
      .interactionMode,
    { kind: "edit" },
  );
});
test("split view owns its ratio and camera without changing selection", () => {
  const initial = createDirectorStageViewState("person");
  const split = reduce(initial, {
    type: "openSplit",
    cameraId: "camera-2",
    ratio: 1.2,
  });

  assert.deepEqual(split.splitView, {
    kind: "open",
    cameraId: "camera-2",
    ratio: 0.8,
  });
  assert.deepEqual(split.selection, { kind: "object", objectId: "person" });
  assert.deepEqual(
    reduce(split, { type: "setSplitCamera", cameraId: null }).splitView,
    { kind: "open", cameraId: null, ratio: 0.8 },
  );
  assert.deepEqual(
    reduce(split, { type: "setSplitRatio", ratio: 0.1 }).splitView,
    { kind: "open", cameraId: "camera-2", ratio: 0.2 },
  );
  const closed = reduce(split, { type: "closeSplit" });
  assert.deepEqual(closed.splitView, { kind: "closed", ratio: 0.8 });
  assert.deepEqual(
    reduce(closed, { type: "setSplitRatio", ratio: 0.4 }),
    { ...closed, splitView: { kind: "closed", ratio: 0.4 } },
  );
});

test("view flags, focus, panels, drawer selection, export, and gizmo mode reduce explicitly", () => {
  const state = reduce(
    createDirectorStageViewState(null),
    { type: "focusSurface", surface: "drawer" },
    { type: "toggleViewFlag", flag: "motionPaths" },
    { type: "setViewFlag", flag: "ground", enabled: false },
    { type: "toggleViewMenu" },
    { type: "setLeftTab", tab: "cameras" },
    { type: "setAssetRole", role: "scene" },
    { type: "toggleTreeGroup", group: "characters" },
    { type: "toggleHelp" },
    { type: "toggleDrawer" },
    { type: "toggleStillSelection", stillId: "still-1" },
    { type: "toggleStillSelection", stillId: "still-2" },
    { type: "setPreviewStill", stillId: "still-1" },
    { type: "setGizmo", gizmo: "scale" },
    { type: "openExport", source: "camera-1", clarity: 1920, fps: 60 },
    { type: "setExportSource", source: "storyboard" },
    { type: "setExportClarity", clarity: 1280 },
    { type: "setExportFps", fps: 30 },
  );

  assert.equal(state.focusedSurface, "drawer");
  assert.equal(state.viewFlags.motionPaths, true);
  assert.equal(state.viewFlags.ground, false);
  assert.equal(state.viewMenuOpen, true);
  assert.equal(state.leftTab, "cameras");
  assert.equal(state.assetRole, "scene");
  assert.equal(state.treeGroups.characters, false);
  assert.equal(state.helpOpen, true);
  assert.equal(state.drawerOpen, true);
  assert.deepEqual(state.selectedStillIds, new Set(["still-1", "still-2"]));
  assert.equal(state.previewStillId, "still-1");
  assert.equal(state.activeGizmo, "scale");
  assert.deepEqual(state.exportDialog, {
    kind: "open",
    source: "storyboard",
    clarity: 1280,
    fps: 30,
  });
  assert.equal(state.lastExportFps, 30);

  const cleared = reduce(state, { type: "clearStillSelection" });
  assert.deepEqual(cleared.selectedStillIds, new Set<string>());
  assert.equal(cleared.previewStillId, null);
  assert.deepEqual(
    reduce(cleared, { type: "closeExport" }).exportDialog,
    {
      kind: "closed",
      source: "storyboard",
      clarity: 1280,
      fps: 30,
    },
  );
  assert.equal(
    reduce(
      reduce(cleared, { type: "closeExport" }),
      { type: "openExport", source: "camera-2", clarity: 1280, fps: 60 },
    ).exportDialog.fps,
    30,
  );
});

test("explicit setters cover the remaining session boundaries", () => {
  const state = reduce(
    createDirectorStageViewState(null),
    { type: "selectObject", objectId: "object-1" },
    { type: "focusSurface", surface: "inspector" },
    { type: "setCameraPreview", enabled: true },
    { type: "setCameraPreviewCamera", cameraId: "camera-2" },
    { type: "setViewMenu", open: true },
    { type: "setTreeGroup", group: "objects", expanded: false },
    { type: "setHelp", open: true },
    { type: "setDrawer", open: true },
    { type: "setPreviewStill", stillId: "still-1" },
  );

  assert.deepEqual(state.selection, { kind: "object", objectId: "object-1" });
  assert.equal(state.focusedSurface, "inspector");
  assert.equal(state.cameraPreview, true);
  assert.equal(state.cameraPreviewCameraId, "camera-2");
  assert.equal(state.viewMenuOpen, true);
  assert.equal(state.treeGroups.objects, false);
  assert.equal(state.helpOpen, true);
  assert.equal(state.drawerOpen, true);
  assert.equal(state.previewStillId, "still-1");
});

test("camera preview selection is independent from the main selection", () => {
  const initial = createDirectorStageViewState("object-1", "camera-1");
  const preview = directorStageViewReducer(initial, {
    type: "setCameraPreviewCamera",
    cameraId: "camera-2",
  });

  assert.equal(preview.cameraPreviewCameraId, "camera-2");
  assert.deepEqual(preview.selection, { kind: "object", objectId: "object-1" });
  assert.equal(preview.cameraPreview, true);
});

test("preview mode is ephemeral and preserves the current selection", () => {
  const initial = createDirectorStageViewState("object-1");
  const dynamic = directorStageViewReducer(initial, {
    type: "setPreviewMode",
    mode: "dynamic",
  });

  assert.equal(dynamic.previewMode, "dynamic");
  assert.deepEqual(dynamic.selection, { kind: "object", objectId: "object-1" });
});

test("camera and viewpoint selections force the translation gizmo", () => {
  const initial = createDirectorStageViewState("object-1");
  const camera = reduce(initial, { type: "selectCamera", cameraId: "camera-1" });
  assert.deepEqual(camera.selection, { kind: "camera", cameraId: "camera-1" });
  assert.equal(camera.activeGizmo, "translate");
  assert.equal(
    reduce(camera, { type: "setGizmo", gizmo: "rotate" }).activeGizmo,
    "translate",
  );

  const viewpoint = reduce(camera, {
    type: "selectViewpoint",
    cameraId: "camera-1",
  });
  assert.deepEqual(viewpoint.selection, {
    kind: "viewpoint",
    cameraId: "camera-1",
  });
  assert.equal(viewpoint.activeGizmo, "translate");
  assert.equal(
    reduce(viewpoint, { type: "setGizmo", gizmo: "scale" }).activeGizmo,
    "translate",
  );
});
