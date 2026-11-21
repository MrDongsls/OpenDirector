/** Director Stage gizmo acceptance: preview dragging repositions a
 * keyframe-free subject through base transforms only, and once the subject
 * carries transform keyframes the same drag poses it at the playhead through
 * the keyframe writer the numeric fields use.
 * DIRECTOR_STAGE_LOCALE runs the same flow in another UI language. */
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
    positionX: "Position X",
    positionY: "Position Y",
    positionZ: "Position Z",
    camera: "Camera 1",
    viewpoint: "Viewpoint",
    cameraX: "Camera X",
    targetX: "Target X",
    object: "Person 1",
    rotationX: "Rotation X",
    undo: "Undo",
    redo: "Redo",
    previewMode: "Preview mode",
    dynamicPreview: "Dynamic",
    playhead: "Stage playhead",
    recordKeyframe: "Record a keyframe here",
    openStage: "Open Director Stage",
  },
  "zh-CN": {
    saved: "已保存到本机",
    addStage: "添加导演台",
    apply: "应用编辑",
    positionX: "位置 X",
    positionY: "位置 Y",
    positionZ: "位置 Z",
    camera: "摄像机 1",
    viewpoint: "视点",
    cameraX: "机位 X",
    targetX: "目标 X",
    object: "人物 1",
    rotationX: "旋转 X",
    undo: "撤销",
    redo: "重做",
    previewMode: "预览模式",
    dynamicPreview: "动态",
    playhead: "舞台播放位置",
    recordKeyframe: "在此记录关键帧",
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
  payload: { name: `Director Stage gizmo ${projectId.slice(0, 8)}` },
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
  localStorage.setItem("opendirector.locale.v1", value);
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
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
  const item = snapshot.canvasItems.find((candidate) => candidate.id === itemId);
  const document = snapshot.editorDocuments.find(
    (candidate) => candidate.id === item?.binding?.objectRef?.id,
  );
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

/** Grabs the translate X handle of the placement gizmo. Project the handle
 * from the director camera instead of relying on a fixed screen offset; the
 * latter silently regresses when the director view is not the stage camera. */
const xHandlePoint = async () => {
  const box = await page
    .locator(".cw-stage-scene")
    .boundingBox();
  assert.ok(box, "stage viewport is visible");
  const center = projectToViewport(0, 0, 0, box);
  const ahead = projectToViewport(1, 0, 0, box);
  const direction = { x: ahead.x - center.x, y: ahead.y - center.y };
  const length = Math.hypot(direction.x, direction.y);
  return {
    from: {
      x: center.x + (direction.x / length) * box.width * 0.03,
      y: center.y + (direction.y / length) * box.width * 0.03,
    },
    by: box.width * 0.11,
    direction: { x: direction.x / length, y: direction.y / length },
  };
};

/** Drags the X translate handle rightwards along its own screen axis. */
const dragXHandle = async () => {
  const { from, by, direction } = await xHandlePoint();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(
    from.x + direction.x * by,
    from.y + direction.y * by,
    { steps: 12 },
  );
  await page.mouse.up();
};

const positionX = () => page.getByLabel(L.positionX, { exact: true });

/** Director view every fresh stage opens with. The projection helper below
 * mirrors the render camera's look-at math. */
const DEFAULT_CAMERA = {
  eye: { x: 8, y: 6, z: 10 },
  target: { x: 0, y: 1, z: 0 },
  fov: 45,
};
const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const normalize3 = (a) => {
  const length = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};
const VIEW_BASIS = (() => {
  const forward = normalize3(sub3(DEFAULT_CAMERA.target, DEFAULT_CAMERA.eye));
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }));
  return { forward, right, up: normalize3(cross3(right, forward)) };
})();

/** Projects a world point to viewport pixels under the default camera, so a
 * drag can find the gizmo of a subject that no longer sits at the origin. */
const projectToViewport = (px, py, pz, box) => {
  const view = sub3({ x: px, y: py, z: pz }, DEFAULT_CAMERA.eye);
  const depth = dot3(view, VIEW_BASIS.forward);
  const halfH = depth * Math.tan((DEFAULT_CAMERA.fov * Math.PI) / 360);
  const halfW = halfH * (box.width / box.height);
  return {
    x: box.x + ((dot3(view, VIEW_BASIS.right) / halfW + 1) / 2) * box.width,
    y: box.y + ((1 - dot3(view, VIEW_BASIS.up) / halfH) / 2) * box.height,
  };
};

/** Drags the X translate handle of a subject at an arbitrary base position:
 * projects the base position and its +X offset to get the arrow's screen
 * direction at that depth, then pulls along it like dragXHandle does. */
const dragXHandleAt = async (position) => {
  const box = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(box, "stage viewport is visible");
  const center = projectToViewport(
    position.x,
    position.y,
    position.z,
    box,
  );
  const ahead = projectToViewport(position.x + 1, position.y, position.z, box);
  const dx = ahead.x - center.x,
    dy = ahead.y - center.y;
  const length = Math.hypot(dx, dy);
  const from = {
    x: center.x + (dx / length) * box.width * 0.03,
    y: center.y + (dy / length) * box.width * 0.03,
  };
  const by = box.width * 0.11;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (dx / length) * by, from.y + (dy / length) * by, {
    steps: 12,
  });
  await page.mouse.up();
};

const fieldNumber = (label) =>
  page.getByLabel(label, { exact: true }).inputValue().then(Number);

const neutralPixelsNear = async (screenshot, center, radius) =>
  page.evaluate(
    ({ dataUrl, center, radius }) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) return reject(new Error("2D canvas is unavailable"));
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          const scale = canvas.width / window.innerWidth;
          const x = center.x * scale;
          const y = center.y * scale;
          const r = radius * scale;
          let count = 0;
          for (
            let py = Math.max(0, Math.floor(y - r));
            py < Math.min(canvas.height, Math.ceil(y + r));
            py += 2
          ) {
            for (
              let px = Math.max(0, Math.floor(x - r));
              px < Math.min(canvas.width, Math.ceil(x + r));
              px += 2
            ) {
              const offset = (py * canvas.width + px) * 4;
              const red = pixels[offset];
              const green = pixels[offset + 1];
              const blue = pixels[offset + 2];
              const brightest = Math.max(red, green, blue);
              const darkest = Math.min(red, green, blue);
              if (brightest > 160 && brightest - darkest < 35) count++;
            }
          }
          resolve(count);
        };
        image.onerror = () => reject(new Error("screenshot decode failed"));
        image.src = dataUrl;
      }),
    {
      dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
      center,
      radius,
    },
  );

const waitForFieldValue = (label, value) =>
  page.waitForFunction(
    ({ label, value }) => {
      const field = document.querySelector(`[aria-label="${label}"]`);
      return (
        field instanceof HTMLInputElement &&
        Math.abs(Number(field.value) - value) < 0.01
      );
    },
    { label, value },
  );

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText(L.saved, { exact: true }).waitFor();

  const addStage = page.getByRole("button", { name: L.addStage, exact: true });
  await addStage.waitFor();
  await addStage.click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();

  // Wait for the stage surface before checking the mutually exclusive
  // transform tool state and starting the first drag.
  await page.locator(".cw-stage-scene canvas:not(.cw-stage-pipcanvas)").waitFor();
  const gizmoButtons = page.locator(
    ".cw-stage-gizmo button[data-icon]",
  );
  const moveGizmo = gizmoButtons.nth(0);
  const rotateGizmo = gizmoButtons.nth(1);
  const scaleGizmo = gizmoButtons.nth(2);
  assert.equal(await moveGizmo.getAttribute("aria-pressed"), "true");
  assert.equal(await rotateGizmo.getAttribute("aria-pressed"), "false");
  assert.equal(await scaleGizmo.getAttribute("aria-pressed"), "false");
  await rotateGizmo.click();
  assert.equal(await moveGizmo.getAttribute("aria-pressed"), "false");
  assert.equal(await rotateGizmo.getAttribute("aria-pressed"), "true");
  assert.equal(await scaleGizmo.getAttribute("aria-pressed"), "false");
  await moveGizmo.click();
  const viewportMetrics = await page.evaluate(() => {
    const canvas = document.querySelector(
      ".cw-stage-scene canvas:not(.cw-stage-pipcanvas)",
    );
    const rect = canvas?.getBoundingClientRect();
    return canvas instanceof HTMLCanvasElement && rect
      ? {
          width: rect.width,
          height: rect.height,
          bufferWidth: canvas.width / window.devicePixelRatio,
          bufferHeight: canvas.height / window.devicePixelRatio,
        }
      : null;
  });
  assert.ok(viewportMetrics, "the stage canvas has a measurable viewport");
  assert.ok(
    Math.abs(viewportMetrics.bufferWidth - viewportMetrics.width) < 1 &&
      Math.abs(viewportMetrics.bufferHeight - viewportMetrics.height) < 1,
    `the WebGL buffer follows the visible viewport (${JSON.stringify(viewportMetrics)})`,
  );

  const positionY = page.getByLabel(L.positionY, { exact: true });
  const stageBox = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(stageBox, "stage viewport is visible for underground placement");
  const undergroundCenter = projectToViewport(0, -0.45, 0, stageBox);
  const baseline = await page.locator(".cw-stage-scene").screenshot();
  const baselinePixels = await neutralPixelsNear(
    baseline,
    undergroundCenter,
    Math.min(stageBox.width, stageBox.height) * 0.02,
  );
  await positionY.fill("-1");
  await waitForFieldValue(L.positionY, -1);
  await page.waitForTimeout(200);
  const underground = await page.locator(".cw-stage-scene").screenshot();
  const undergroundPixels = await neutralPixelsNear(
    underground,
    undergroundCenter,
    Math.min(stageBox.width, stageBox.height) * 0.02,
  );
  assert.ok(
    undergroundPixels > baselinePixels + 12,
    `the below-ground portion remains visible (${baselinePixels} -> ${undergroundPixels} neutral pixels)`,
  );
  await positionY.fill("0");
  await waitForFieldValue(L.positionY, 0);
  await page.waitForTimeout(150);

  // Camera helpers are scene entities, not tree-only controls. Clicking the
  // projected camera endpoint must select the camera from the director view.
  const stageBox = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(stageBox, "stage viewport is visible for camera selection");
  const cameraEndpoint = projectToViewport(5, 3.5, 7, stageBox);
  await page.mouse.click(cameraEndpoint.x, cameraEndpoint.y);
  await page.waitForFunction(() =>
    document.querySelector(
      ".cw-stage-camera-tree-row:not(.cw-stage-camera-tree-row-child) button[aria-selected=\"true\"]",
    ) !== null,
  );
  assert.match(
    await page
      .locator(
        ".cw-stage-camera-tree-row:not(.cw-stage-camera-tree-row-child) button[aria-selected=\"true\"]",
      )
      .textContent(),
    new RegExp(L.camera),
    "clicking the camera body selects its camera endpoint",
  );

  // Cameras and viewpoints are independent scene selections. Both expose
  // only translation, while ordinary subjects keep all three gizmo modes.
  const stageTree = page.locator(".cw-stage-tree");
  await stageTree.getByRole("button", { name: L.camera, exact: true }).click();
  assert.equal(await moveGizmo.getAttribute("aria-pressed"), "true");
  await rotateGizmo.click();
  assert.equal(await moveGizmo.getAttribute("aria-pressed"), "true");
  assert.equal(await rotateGizmo.getAttribute("aria-pressed"), "false");
  await stageTree
    .getByRole("button", { name: L.viewpoint, exact: true })
    .click();
  assert.equal(await moveGizmo.getAttribute("aria-pressed"), "true");

  // Moving the viewpoint is a stage edit, not a director-view navigation.
  // The readout belongs to the orbit camera and must remain unchanged while
  // the camera output's target changes.
  const directorReadout = page.locator(".cw-stage-viewreadout");
  await directorReadout.waitFor();
  const beforeViewpointMove = await directorReadout.textContent();
  await page.getByLabel(L.targetX, { exact: true }).fill("2");
  await page.waitForTimeout(120);
  assert.equal(
    await directorReadout.textContent(),
    beforeViewpointMove,
    "viewpoint edits do not move the director view",
  );
  await page.getByLabel(L.targetX, { exact: true }).fill("0");
  await stageTree.getByRole("button", { name: L.object, exact: true }).click();
  await moveGizmo.click();

  await dragXHandle();
  const dragged = Number(await positionX().inputValue());
  // A miss would orbit the camera instead; the persisted-pose assertions
  // below would catch that, but fail fast here with the observed value.
  assert.ok(
    dragged > 0.5,
    `gizmo drag moved the subject along X (got ${dragged})`,
  );

  // Placement edits are ordinary history entries: one undo restores the
  // original position without touching any other subject data. The canvas
  // toolbar undo carries an aria-label; scope to the modal's plain-text one.
  const modalUndo = page
    .locator(".cw-stage-console")
    .getByRole("button", { name: L.undo, exact: true });
  await modalUndo.click();
  await page.waitForFunction(
    (label) => {
      const field = document.querySelector(`[aria-label="${label}"]`);
      return field instanceof HTMLInputElement &&
        Math.abs(Number(field.value)) < 0.01;
    },
    L.positionX,
  );
  const undone = Number(await positionX().inputValue());
  assert.ok(Math.abs(undone) < 0.01, `undo restored X (got ${undone})`);

  // Undo-and-apply persists the un-dragged pose with zero keyframes.
  await page.getByRole("button", { name: L.apply, exact: true }).click();
  const appliedUndo = await until((snapshot) => {
    const result = director(snapshot, snapshot.canvasItems.find(
      (candidate) => candidate.visible && candidate.kind === "external",
    )?.id);
    return result.document?.kind === "director";
  }, "stage document persisted after undo apply");
  const undoItemId = appliedUndo.canvasItems.find(
    (candidate) => candidate.visible && candidate.kind === "external",
  ).id;
  const undoDocument = director(appliedUndo, undoItemId).document;
  assert.equal(keyframeCount(undoDocument), 0);
  assert.ok(
    Math.abs(undoDocument.data.objects[0].position.x) < 0.01,
    "undo apply persisted the original X",
  );

  // Reopen and drag again: the placement persists as a base transform, and a
  // recorded keyframe then keeps the subject draggable, posing it at the
  // playhead, with no camera-pose side effects.
  await page.locator(`.react-flow__node[data-id="${undoItemId}"]`).click();
  await page.getByRole("button", { name: L.openStage, exact: true }).click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();
  // Select the rotate tool explicitly. Its ring turns the subject around the
  // X axis without touching its position, and the upper-left arc carries no
  // translate arrows. It runs before the translate drag while the subject
  // still sits at the world origin, where the gizmo center is fixed.
  await page.locator(".cw-stage-gizmo button[data-icon]").nth(1).click();
  const ringBox = await page.locator(".cw-stage-scene").boundingBox();
  const ringCenter = {
    x: ringBox.x + ringBox.width / 2,
    y: ringBox.y + ringBox.height * 0.625,
  };
  const radial = { x: -0.5, y: -0.866 };
  const ringPx = Math.min(ringBox.width, ringBox.height) * 0.053;
  const grab = {
    x: ringCenter.x + radial.x * ringPx,
    y: ringCenter.y + radial.y * ringPx,
  };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 0.866 * 80, grab.y - 0.5 * 80, { steps: 12 });
  await page.mouse.up();
  const turned = Number(
    await page.getByLabel(L.rotationX, { exact: true }).inputValue(),
  );
  assert.ok(
    Math.abs(turned) > 30,
    `rotate drag turned the subject (got ${turned})`,
  );
  assert.ok(
    Math.abs(Number(await positionX().inputValue())) < 0.01,
    "rotation left the placement position unchanged",
  );

  await page.locator(".cw-stage-gizmo button[data-icon]").nth(0).click();
  await dragXHandle();
  const draggedAgain = Number(await positionX().inputValue());
  assert.ok(
    draggedAgain > 0.5,
    `second gizmo drag moved the subject along X (got ${draggedAgain})`,
  );

  // A keyframed subject must stay draggable: with the playhead at 0, record a
  // frame first, then drag the X handle again. The pose lands in the frame at
  // the playhead through the same writer as the numeric fields.
  const previewMode = page.getByRole("group", { name: L.previewMode, exact: true });
  await previewMode.getByRole("button", { name: L.dynamicPreview, exact: true }).click();
  await page.getByTestId("director-stage-timeline").waitFor();
  await page.locator(".cw-stage-transport").getByRole("button").first().click();
  await page.getByRole("slider", { name: L.playhead, exact: true }).press("Home");
  await page
    .getByRole("button", { name: L.recordKeyframe, exact: true })
    .click();
  await page.getByRole("button", { name: "0.00s", exact: true }).waitFor();
  // The keyframe-hint row appearing above the viewport shifts it down, so
  // read the base transform fresh and project it to the moved gizmo.
  const posedPosition = {
    x: await fieldNumber(L.positionX),
    y: await fieldNumber(L.positionY),
    z: await fieldNumber(L.positionZ),
  };
  await dragXHandleAt(posedPosition);
  const posedDragged = await fieldNumber(L.positionX);
  assert.ok(
    posedDragged > posedPosition.x + 0.1,
    `drag on the keyframed subject moved the pose along X (got ${posedDragged})`,
  );
  // The pose drag is one history entry: one undo restores the pose the record
  // button captured, and redo re-applies the dragged pose.
  await modalUndo.click();
  await waitForFieldValue(L.positionX, posedPosition.x);
  await page
    .locator(".cw-stage-console")
    .getByRole("button", { name: L.redo, exact: true })
    .click();
  await waitForFieldValue(L.positionX, posedDragged);

  // Orbiting is a director-view inspection gesture, not a camera edit. The
  // camera and viewpoint gizmos are the only controls allowed to author the
  // camera pose.
  const beforeOrbitCameraX = await fieldNumber(L.cameraX);
  const beforeOrbitTargetX = await fieldNumber(L.targetX);
  const orbitBox = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(orbitBox, "stage viewport is visible for orbit regression");
  const orbitY = orbitBox.y + orbitBox.height * 0.82;
  await page.mouse.move(orbitBox.x + orbitBox.width * 0.82, orbitY);
  await page.mouse.down();
  await page.mouse.move(orbitBox.x + orbitBox.width * 0.68, orbitY, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.ok(
    Math.abs((await fieldNumber(L.cameraX)) - beforeOrbitCameraX) < 0.01,
    "orbiting leaves the camera endpoint unchanged",
  );
  assert.ok(
    Math.abs((await fieldNumber(L.targetX)) - beforeOrbitTargetX) < 0.01,
    "orbiting leaves the viewpoint endpoint unchanged",
  );

  await page.getByRole("button", { name: L.apply, exact: true }).click();
  const applied = await until((snapshot) => {
    const result = director(snapshot, undoItemId);
    return (
      result.document?.kind === "director" &&
      result.document.data.objects[0].position.x > 0.5 &&
      Math.abs(result.document.data.objects[0].rotation.x) > 0.5 &&
      result.document.data.objects[0].keyframes.length === 1
    );
  }, "dragged placement, rotation and pose keyframe persisted after apply");
  const document = director(applied, undoItemId).document;
  const subject = document.data.objects[0];
  // The drags authored no frames of their own: the recorded frame at 0 is
  // still the only one, and the pose drag overwrote its value in place while
  // the base transform carries the same dragged pose.
  assert.equal(subject.keyframes.length, 1);
  assert.ok(
    Math.abs(subject.keyframes[0].time) < 1e-9,
    "pose frame sits at the playhead time",
  );
  assert.ok(
    Math.abs(subject.keyframes[0].value.position.x - subject.position.x) <
      0.01,
    "pose keyframe holds the dragged position",
  );
  assert.ok(
    Math.abs(subject.position.x - posedDragged) < 0.01,
    "base transform carries the dragged pose",
  );
  const pose = document.data.cameras[0].pose;
  assert.deepEqual(pose.position, { x: 5, y: 3.5, z: 7 });
  assert.deepEqual(pose.target, { x: 0, y: 1, z: 0 });
  assert.equal(pose.fov, 45);
  assert.equal(
    document.data.cameras[0].keyframes.length,
    1,
    "drags authored no camera keyframes beyond the recorded frame",
  );

  // Apply already closed the editor; the modal is gone from the canvas.
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      itemId: undoItemId,
      checks: [
        "translate drag moves the selected subject",
        "one undo restores the placement",
        "rotate ring turns the subject in place",
        "placement and rotation persist as base transforms",
        "drags author no keyframes beyond the recorded frame",
        "dragging after a recorded keyframe poses at the playhead",
        "one undo reverts the pose drag",
        "camera and viewpoint selections force translate-only gizmos",
        "orbiting the director view does not edit camera endpoints",
        "dragging leaves the camera pose untouched",
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
