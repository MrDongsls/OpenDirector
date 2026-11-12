/** First-phase Director Stage acceptance: create, open, edit, reopen, undo, and redo.
 * DIRECTOR_STAGE_LOCALE runs the same flow in another UI language (default en-US). */
import assert from "node:assert/strict";
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
    positionX: "Position X",
    recordKeyframe: "Record a keyframe here",
    closeEditor: "Close editor",
    undo: "Undo",
    redo: "Redo",
    openStage: "Open Director Stage",
  },
  "zh-CN": {
    saved: "已保存到本机",
    addStage: "添加导演台",
    apply: "应用编辑",
    cameraName: "机位名称",
    playhead: "舞台播放位置",
    positionX: "位置 X",
    recordKeyframe: "在此记录关键帧",
    closeEditor: "关闭编辑器",
    undo: "撤销",
    redo: "重做",
    openStage: "打开导演台",
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
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
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
      (candidate.visible && candidate.kind === "external"),
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

  await page.getByLabel(L.cameraName, { exact: true }).fill("Acceptance camera");
  await page
    .getByRole("slider", { name: L.playhead, exact: true })
    .press("End");
  await page.getByLabel(L.positionX, { exact: true }).fill("2");
  await page
    .getByRole("button", { name: L.recordKeyframe, exact: true })
    .click();
  await page.getByRole("button", { name: "6.00s", exact: true }).waitFor();
  await page.getByRole("button", { name: L.apply, exact: true }).click();

  const committed = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name === "Acceptance camera" &&
      keyframeCount(result.document) >= 2
    );
  }, "edited director document with keyframes");
  const committedRefs = director(committed, itemId);
  assert.equal(committedRefs.document.data.objects[0].id, objectId);
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
  const undo = page.getByRole("button", { name: L.undo, exact: true });
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

  const redo = page.getByRole("button", { name: L.redo, exact: true });
  assert.equal(await redo.isEnabled(), true);
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
        "keyframes persist and reopen",
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
