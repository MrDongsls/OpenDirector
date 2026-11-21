/** Second-phase Director Stage acceptance: create, import GLB, edit, reopen, undo, and redo.
 * DIRECTOR_STAGE_LOCALE runs the same flow in another UI language (default en-US). */
import assert from "node:assert/strict";
import { makeCorruptGlb, makeGlb } from "./director_stage_fixture.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const locale = process.env.DIRECTOR_STAGE_LOCALE ?? "en-US";
const L = {
  "en-US": {
    saved: "Saved on this device",
    addStage: "Add Director Stage",
    apply: "Apply edits",
    cameraName: "Camera name",
    playhead: "Stage playhead",
    timeline: "Director Stage timeline tracks",
    previewMode: "Preview mode",
    staticPreview: "Static",
    dynamicPreview: "Dynamic",
    addShot: "Add current camera at playhead",
    positionX: "Position X",
    recordKeyframe: "Record a keyframe here",
    activeState: "At playhead:",
    editKeyframe: "Edit selected keyframe",
    deleteSelectedKeyframe: "Delete selected keyframe",
    closeEditor: "Close editor",
    undo: "Undo",
    redo: "Redo",
    openStage: "Open Director Stage",
    importAsset: "Import GLB / GLTF",
    importJson: "Import stage JSON",
    exportJson: "Export stage JSON",
    background: "Background",
    backgroundAsset: "Background image",
    environmentPreset: "Environment preset",
    groundColor: "Ground color",
    groundVisible: "Show ground",
    exposure: "Exposure",
    keyIntensity: "Key light intensity",
    noAnimationNote: "Character · Imported acceptance · no animation data",
    corruptAssetNotice:
      "Could not read “broken.glb”: the GLB header is valid but the embedded JSON is missing or corrupt.",
    loadFailedNotice:
      "Could not load “broken.glb”. The file may be corrupt or reference external resources.",
    unsupportedAssetNotice:
      "Only GLB and self-contained GLTF files are supported. FBX and external GLTF resources are not supported yet.",
    exportUnsavedImportsNotice:
      "The stage file cannot carry imported models that exist only in this browser: acceptance. Apply edits to save them to the project first.",
    importForeignAssetsNotice:
      "The stage file pins imported models that are not registered in this project: Foreign actor. Open the stage in its original project, or import the model files here first.",
  },
  "zh-CN": {
    saved: "已保存到本机",
    addStage: "添加导演台",
    apply: "应用编辑",
    cameraName: "机位名称",
    playhead: "舞台播放位置",
    timeline: "导演舞台时间线轨道",
    previewMode: "预览模式",
    staticPreview: "静态",
    dynamicPreview: "动态",
    addShot: "在播放头添加当前机位",
    positionX: "位置 X",
    recordKeyframe: "在此记录关键帧",
    activeState: "播放头状态：",
    editKeyframe: "编辑所选关键帧",
    deleteSelectedKeyframe: "删除所选关键帧",
    closeEditor: "关闭编辑器",
    undo: "撤销",
    redo: "重做",
    openStage: "打开导演台",
    importAsset: "导入 GLB / GLTF",
    importJson: "导入舞台 JSON",
    exportJson: "导出舞台 JSON",
    background: "背景",
    backgroundAsset: "背景图片",
    environmentPreset: "环境预设",
    groundColor: "地面颜色",
    groundVisible: "显示地面",
    exposure: "曝光",
    keyIntensity: "主光强度",
    noAnimationNote: "人物 · 已导入 acceptance · 无动画数据",
    corruptAssetNotice:
      "无法读取「broken.glb」：GLB 头有效，但内嵌 JSON 缺失或已损坏。",
    loadFailedNotice:
      "无法加载「broken.glb」。文件可能损坏，或引用了外部资源。",
    unsupportedAssetNotice:
      "目前仅支持 GLB 和自包含 GLTF；FBX 及外部 GLTF 资源暂不支持。",
    exportUnsavedImportsNotice:
      "舞台文件无法携带仅存在于当前浏览器的导入模型：acceptance。请先应用编辑，将其保存为工程素材。",
    importForeignAssetsNotice:
      "舞台文件引用了未在本工程登记的导入模型：Foreign actor。请在原工程中打开，或先在此工程导入对应模型文件。",
  },
}[locale];
assert.ok(L, `Unsupported DIRECTOR_STAGE_LOCALE: ${locale}`);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Director Stage entry ${projectId.slice(0, 8)}` },
});

const state = () => call(`/api/creation/projects/${projectId}`);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  locale,
  viewport: { width: 1700, height: 1100 },
});
await page.addInitScript((value) => {
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  localStorage.setItem("opendirector.locale.v1", value);
}, locale);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};

const director = (snapshot, itemId) => {
  const item = snapshot.canvasItems.find(
    (candidate) =>
      candidate.id === itemId ||
      (itemId === undefined &&
        candidate.visible &&
        candidate.kind === "external"),
  );
  const document = item
    ? snapshot.editorDocuments.find(
        (candidate) => candidate.id === item.binding?.objectRef?.id,
      )
    : undefined;
  return { item, document };
};

const keyframeCount = (document) =>
  document.data.objects.reduce(
    (count, object) => count + object.keyframes.length,
    0,
  ) +
  document.data.cameras.reduce(
    (count, camera) => count + camera.keyframes.length,
    0,
  );

// A well-formed stage document pinning a model asset this project never
// registered; import must refuse it by naming the object.
const foreignStage = {
  format: "opendirector-local-stage",
  version: 2,
  background: "#151923",
  grid: true,
  duration: 6,
  aspectRatio: "16:9",
  activeCameraId: "camera-1",
  cameraSource: "camera",
  shots: [],
  cameras: [
    {
      id: "camera-1",
      name: "Camera",
      pose: {
        position: { x: 5, y: 3.5, z: 7 },
        target: { x: 0, y: 1, z: 0 },
        fov: 45,
      },
      keyframes: [],
    },
  ],
  objects: [
    {
      id: "foreign-actor",
      kind: "gltf",
      name: "Foreign actor",
      color: "#b8c5ff",
      role: "character",
      format: "glb",
      asset: {
        assetId: crypto.randomUUID(),
        revision: 1,
        fingerprint: `sha256:${"c".repeat(64)}`,
        kind: "file",
      },
      animationNames: ["Walk"],
      hasAnimation: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      keyframes: [],
      motionClips: [],
    },
  ],
};

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText(L.saved, { exact: true }).waitFor();

  const addStage = page.getByRole("button", {
    name: L.addStage,
    exact: true,
  });
  await addStage.waitFor();
  assert.equal(await addStage.isEnabled(), true);
  await addStage.click();

  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();
  const created = await until((snapshot) => {
    const result = director(snapshot);
    return result.item?.kind === "external" && result.document?.kind === "director";
  }, "created external item and director document");
  const createdRefs = director(created);
  assert.ok(createdRefs.item);
  assert.ok(createdRefs.document);
  assert.equal(createdRefs.item.binding.objectRef.kind, "director");
  assert.equal(createdRefs.document.kind, "director");
  const itemId = createdRefs.item.id;
  const documentId = createdRefs.document.id;
  const objectId = createdRefs.document.data.objects[0].id;
  assert.equal(keyframeCount(createdRefs.document), 0);

  // Environment controls edit the persisted document through the same local
  // history/apply path as camera and object edits.
  await page.getByRole("tab", { name: L.background, exact: true }).click();
  assert.equal(await page.getByLabel(L.backgroundAsset, { exact: true }).inputValue(), "");
  await page.getByLabel(L.environmentPreset, { exact: true }).selectOption("moonlit");
  assert.equal(await page.getByLabel(L.environmentPreset, { exact: true }).inputValue(), "moonlit");
  assert.equal(await page.getByLabel(L.exposure, { exact: true }).inputValue(), "0.8");
  assert.equal(await page.getByLabel(L.keyIntensity, { exact: true }).inputValue(), "2.4");
  await page.getByLabel(L.groundColor, { exact: true }).fill("#405060");
  await page.getByLabel(L.groundVisible, { exact: true }).uncheck();
  await page.getByLabel(L.exposure, { exact: true }).fill("2.25");
  await page.getByLabel(L.keyIntensity, { exact: true }).fill("4.2");
  await page.getByRole("button", { name: L.apply, exact: true }).click();
  const environmentCommitted = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.document?.data.environment?.groundColor === "#405060" &&
      result.document.data.environment.groundVisible === false &&
      result.document.data.environment.preset === "moonlit" &&
      result.document.data.environment.exposure === 2.25 &&
      result.document.data.lights.find((light) => light.id === "key")?.intensity === 4.2
    );
  }, "persisted ground and key light edits");
  const savedEnvironment = director(environmentCommitted, itemId).document.data;
  assert.equal(savedEnvironment.environment.groundColor, "#405060");
  assert.equal(savedEnvironment.environment.groundVisible, false);
  assert.equal(savedEnvironment.environment.exposure, 2.25);
  assert.equal(savedEnvironment.environment.preset, "moonlit");
  assert.equal(savedEnvironment.environment.backgroundAsset, null);
  assert.equal(savedEnvironment.lights.find((light) => light.id === "key").intensity, 4.2);

  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page.getByRole("button", { name: L.openStage, exact: true }).click();
  await page.getByRole("button", { name: L.apply, exact: true }).waitFor();
  await page.getByRole("tab", { name: L.background, exact: true }).click();
  assert.equal(await page.getByLabel(L.groundColor, { exact: true }).inputValue(), "#405060");
  assert.equal(await page.getByLabel(L.groundVisible, { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel(L.exposure, { exact: true }).inputValue(), "2.25");
  assert.equal(await page.getByLabel(L.backgroundAsset, { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel(L.keyIntensity, { exact: true }).inputValue(), "4.2");

  // Corrupt GLB JSON, plain non-GLB bytes, external GLTF, and GLB with
  // external references are rejected with localized notices before anything
  // reaches the project.
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "broken.glb",
      mimeType: "model/gltf-binary",
      buffer: makeCorruptGlb(),
    });
  await page.getByText(L.corruptAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "broken.glb",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from("not a glb at all"),
    });
  await page.getByText(L.loadFailedNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "external.gltf",
      mimeType: "model/gltf+json",
      buffer: Buffer.from(
        JSON.stringify({
          asset: { version: "2.0" },
          buffers: [{ uri: "scene.bin", byteLength: 4 }],
        }),
      ),
    });
  await page.getByText(L.unsupportedAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "external.glb",
      mimeType: "model/gltf-binary",
      buffer: makeGlb({ images: [{ uri: "texture.png" }] }),
    });
  await page.getByText(L.unsupportedAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "acceptance.glb",
      mimeType: "model/gltf-binary",
      buffer: makeGlb(),
    });
  await page
    .locator(".cw-stage-right-tree")
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  await page.getByText(L.noAnimationNote, { exact: true }).waitFor();

  // The export carries no model bytes, so it must name imports that exist
  // only as browser URLs instead of writing unopenable objects.
  await page
    .getByRole("button", { name: L.exportJson, exact: true })
    .click();
  await page
    .getByText(L.exportUnsavedImportsNotice, { exact: true })
    .waitFor();
  // Stage JSON imports reject objects pinning assets this project never
  // registered, keeping the in-progress stage untouched.
  await page
    .locator('input[type="file"][accept^="application/json"]')
    .setInputFiles({
      name: "foreign.stage.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(foreignStage)),
    });
  await page
    .getByText(L.importForeignAssetsNotice, { exact: true })
    .waitFor();
  await page
    .locator(".cw-stage-right-tree")
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();

  const previewMode = page.getByRole("group", { name: L.previewMode, exact: true });
  await previewMode.getByRole("button", { name: L.staticPreview, exact: true }).waitFor();
  assert.equal(
    await previewMode.getByRole("button", { name: L.staticPreview, exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const timeline = page.getByTestId("director-stage-timeline");
  assert.equal(await timeline.count(), 0);
  await previewMode.getByRole("button", { name: L.dynamicPreview, exact: true }).click();
  await timeline.waitFor();
  assert.equal(await timeline.getAttribute("aria-label"), L.timeline);

  await page.getByLabel(L.cameraName, { exact: true }).fill("Acceptance camera");
  await page
    .getByRole("slider", { name: L.playhead, exact: true })
    .press("Home");
  await page.getByRole("button", { name: L.addShot, exact: true }).click();
  await page.getByRole("slider", { name: L.playhead, exact: true }).fill("1");
  const heldTime = await page.getByRole("slider", { name: L.playhead, exact: true }).inputValue();
  await previewMode.getByRole("button", { name: L.dynamicPreview, exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    await page.getByRole("slider", { name: L.playhead, exact: true }).inputValue(),
    heldTime,
    "switching to dynamic mode must not start playback",
  );
  await previewMode.getByRole("button", { name: L.staticPreview, exact: true }).click();
  assert.equal(await timeline.count(), 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await timeline.count(), 0);
  await previewMode.getByRole("button", { name: L.dynamicPreview, exact: true }).click();
  await timeline.waitFor();
  await timeline.getByRole("button", { name: /Shots.*0\.00 seconds|分镜.*0\.00 秒/ }).click();
  assert.equal(
    await page.getByRole("slider", { name: L.playhead, exact: true }).inputValue(),
    "0",
  );
  await page
    .getByRole("slider", { name: L.playhead, exact: true })
    .press("End");
  await page.getByLabel(L.positionX, { exact: true }).fill("2");
  await page
    .getByRole("button", { name: L.recordKeyframe, exact: true })
    .click();
  await page.getByRole("button", { name: "6.00s", exact: true }).waitFor();
  await page.getByTestId("director-stage-active-state").getByText(L.activeState, { exact: false }).waitFor();
  const positionPoint = timeline.getByRole("button", {
    name: /Acceptance camera.*Position.*6\.00 seconds|Acceptance camera.*位置.*6\.00 秒/,
  });
  await positionPoint.click();
  const keyframeEditor = page.locator(".cw-stage-keyframe-editor");
  await keyframeEditor.waitFor();
  await keyframeEditor.locator('input[name="x"]').fill("9");
  await keyframeEditor.getByRole("button", { name: L.editKeyframe, exact: true }).click();
  await positionPoint.click();
  await keyframeEditor.getByRole("button", { name: L.deleteSelectedKeyframe, exact: true }).click();
  await page.getByRole("button", { name: L.apply, exact: true }).click();

  const committed = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name === "Acceptance camera" &&
      keyframeCount(result.document) >= 2 &&
      result.document.data.cameras[0].channels.position.every((frame) => frame.time !== 6) &&
      result.document.data.cameras[0].channels.target.some((frame) => frame.time === 6)
    );
  }, "edited director document with keyframes");
  const committedRefs = director(committed, itemId);
  assert.equal(committedRefs.document.data.objects[0].id, objectId);
  const imported = committedRefs.document.data.objects.find(
    (object) => object.kind === "gltf",
  );
  assert.ok(imported);
  assert.equal(imported.role, "character");
  assert.equal(imported.format, "glb");
  assert.equal(imported.asset.kind, "file");
  assert.ok(
    committed.assets.some((asset) => asset.id === imported.asset.assetId),
  );
  const importedObjectId = imported.id;
  const importedAssetId = imported.asset.assetId;
  assert.ok(
    committedRefs.document.data.objects[0].keyframes.some(
      (frame) => frame.time === 6,
    ),
  );
  assert.ok(
    committedRefs.document.data.cameras[0].keyframes.some(
      (frame) => frame.time === 6,
    ),
  );

  // Applying saves and closes the stage editor in one step.
  // The toolbar undo carries an aria-label; the stage modal's undo is plain text.
  const undo = page
    .locator(".cw-undo-controls")
    .getByRole("button", { name: L.undo, exact: true });
  await undo.waitFor();
  assert.equal(await undo.isEnabled(), true);
  await undo.click();
  const undone = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name !== "Acceptance camera" &&
      keyframeCount(result.document) === 0
    );
  }, "undo restores the original director document without changing identity");
  assert.equal(director(undone, itemId).document.data.objects[0].id, objectId);
  assert.equal(
    director(undone, itemId).document.data.objects.some(
      (object) => object.id === importedObjectId,
    ),
    false,
  );

  const redo = page.getByLabel(L.redo, { exact: true });
  const redoDeadline = Date.now() + 20000;
  while (!(await redo.isEnabled())) {
    if (Date.now() > redoDeadline) throw new Error("redo never became enabled");
    await page.waitForTimeout(100);
  }
  await redo.click();
  const redone = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name === "Acceptance camera" &&
      keyframeCount(result.document) >= 2
    );
  }, "redo restores the edited director document without changing identity");
  assert.equal(director(redone, itemId).document.data.objects[0].id, objectId);
  const redoneImported = director(redone, itemId).document.data.objects.find(
    (object) => object.id === importedObjectId,
  );
  assert.equal(redoneImported.asset.assetId, importedAssetId);

  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: L.openStage, exact: true })
    .click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel(L.cameraName, { exact: true }).inputValue(),
    "Acceptance camera",
  );
  await page
    .locator(".cw-stage-left")
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  await previewMode.getByRole("button", { name: L.dynamicPreview, exact: true }).click();
  await timeline.waitFor();
  await page.getByRole("button", { name: "6.00s", exact: true }).waitFor();
  assert.deepEqual(director(await state(), itemId).document, director(redone, itemId).document);
  await page
    .getByRole("button", { name: L.closeEditor, exact: true })
    .click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      itemId,
      documentId,
      objectId,
      checks: [
        "shared creation toolbar entry",
        "automatic editor opening",
        "external node projects to director document",
        "corrupt GLB JSON is reported as corruption, not a load failure",
        "GLB import previews before save and registers a file asset",
        "stage JSON export names imports that are not saved yet",
        "stage JSON import rejects foreign pinned assets",
        "imported asset identity survives undo, redo, and reopen",
        "keyframes persist and reopen",
        "timeline tracks are visible, localized, and locate the playhead",
        "undo preserves node and document identities",
        "redo restores the edited document and keyframes",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
