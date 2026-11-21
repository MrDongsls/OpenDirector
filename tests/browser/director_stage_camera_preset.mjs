/** Director Stage camera-preset placement acceptance.
 * A preset is an armed interaction: the next viewport click on a scene object
 * creates a new camera around that object's position and local facing.
 * DIRECTOR_STAGE_LOCALE runs the same flow in another UI language.
 */
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
    openStage: "Open Director Stage",
    cameras: "Cameras",
    addCamera: "Add camera",
    frontMedium: "Front medium",
    camera2: "Camera 2",
    rotationY: "Rotation Y",
    presetHint: "Click a character or object in the viewport to place a new camera",
  },
  "zh-CN": {
    saved: "已保存到本机",
    addStage: "添加导演台",
    apply: "应用编辑",
    openStage: "打开导演台",
    cameras: "机位",
    addCamera: "添加机位",
    frontMedium: "正面中景",
    camera2: "摄像机 2",
    rotationY: "旋转 Y",
    presetHint: "点击画面中的角色或物体，按此预设放置新的机位",
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
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
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
  payload: { name: `Director Stage camera preset ${projectId.slice(0, 8)}` },
});

const state = () => call(`/api/creation/projects/${projectId}`);
const director = (snapshot) => {
  const item = snapshot.canvasItems.find(
    (candidate) => candidate.visible && candidate.kind === "external",
  );
  return snapshot.editorDocuments.find(
    (candidate) => candidate.id === item?.binding?.objectRef?.id,
  );
};

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
const projectToViewport = (point, box) => {
  const view = sub3(point, DEFAULT_CAMERA.eye);
  const depth = dot3(view, VIEW_BASIS.forward);
  const halfHeight = depth * Math.tan((DEFAULT_CAMERA.fov * Math.PI) / 360);
  const halfWidth = halfHeight * (box.width / box.height);
  return {
    x: box.x + ((dot3(view, VIEW_BASIS.right) / halfWidth + 1) / 2) * box.width,
    y: box.y + ((1 - dot3(view, VIEW_BASIS.up) / halfHeight) / 2) * box.height,
  };
};

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
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(20_000);
await page.addInitScript((value) => {
  localStorage.setItem("opendirector.locale.v1", value);
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
}, locale);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const until = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText(L.saved, { exact: true }).waitFor();
  await page.getByRole("button", { name: L.addStage, exact: true }).click();
  await page.getByRole("button", { name: L.apply, exact: true }).click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: L.openStage, exact: true }).click();
  await page.getByRole("button", { name: L.apply, exact: true }).waitFor();
  await page.locator(".cw-stage-scene canvas:not(.cw-stage-pipcanvas)").waitFor();

  // Rotate the existing subject so the assertion proves that the preset uses
  // the object's local facing instead of world-space offsets.
  const rotationY = page.getByLabel(L.rotationY, { exact: true });
  await rotationY.fill("90");
  await page.waitForFunction(
    (label) => {
      const field = document.querySelector(`[aria-label="${label}"]`);
      return field instanceof HTMLInputElement && Math.abs(Number(field.value) - 90) < 0.01;
    },
    L.rotationY,
  );

  await page.getByRole("tab", { name: L.cameras, exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: L.addCamera, exact: true }).count(),
    0,
    "the left camera panel does not duplicate the right-side camera controls",
  );
  assert.equal(
    await page.locator(".cw-stage-camera-list").count(),
    0,
    "the left camera panel does not render a second camera list",
  );
  const preset = page.getByRole("button", {
    name: L.frontMedium,
    exact: true,
  });
  await preset.click();
  assert.equal(await preset.getAttribute("aria-pressed"), "true");
  await page.getByText(L.presetHint, { exact: false }).waitFor();

  const scene = page.locator(".cw-stage-scene");
  const sceneBox = await scene.boundingBox();
  assert.ok(sceneBox, "stage viewport is visible for preset placement");
  const objectPoint = projectToViewport({ x: 0, y: 0.9, z: 0 }, sceneBox);
  await page.mouse.click(objectPoint.x, objectPoint.y);
  assert.equal(await preset.getAttribute("aria-pressed"), "false");

  await page
    .locator(".cw-stage-camera-tree-row:not(.cw-stage-camera-tree-row-child)")
    .filter({ hasText: L.camera2 })
    .waitFor();
  const localCameraCount = await page.locator(
    ".cw-stage-camera-tree-row:not(.cw-stage-camera-tree-row-child)",
  ).count();
  assert.equal(localCameraCount, 2, "preset click adds a second camera");

  await page.getByRole("button", { name: L.apply, exact: true }).click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor({ state: "detached" });
  const snapshot = await until(
    (value) => director(value)?.data.cameras.length === 2,
    "camera preset placement persisted",
  );
  const document = director(snapshot);
  assert.ok(document);
  const [original, placed] = document.data.cameras;
  assert.deepEqual(original.pose, {
    position: { x: 5, y: 3.5, z: 7 },
    target: { x: 0, y: 1, z: 0 },
    fov: 45,
    roll: 0,
  });
  assert.ok(placed);
  assert.ok(Math.abs(placed.pose.position.x - 6) < 0.01);
  assert.ok(Math.abs(placed.pose.position.y - 1.9) < 0.01);
  assert.ok(Math.abs(placed.pose.position.z) < 0.01);
  assert.deepEqual(placed.pose.target, { x: 0, y: 1.3, z: 0 });
  assert.equal(placed.pose.fov, 45);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      cameraId: placed.id,
      checks: [
        "preset arms a two-step placement instead of editing the active camera",
        "clicking a scene object creates a new camera",
        "camera offset follows the object's local Y rotation",
        "the original camera remains unchanged",
        "placement persists after apply",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
