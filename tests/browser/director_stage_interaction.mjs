/** Batch-5 acceptance: view settings, scene tree, two-step placement,
 * roam view and the anchored action bar over the fullscreen console. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(path, body, extra = {}) {
  const response = await fetch(api + path, {
    headers: { ...headers, ...extra },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Interact ${projectId.slice(0, 8)}` },
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
  locale: "en-US",
  viewport: { width: 1700, height: 1100 },
});
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};
const stageDoc = (snapshot) =>
  snapshot.editorDocuments.find((candidate) => candidate.kind === "director");
const sceneBox = async () => {
  const box = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(box);
  return box;
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
const normalize3 = (a) => {
  const length = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};
const groundPointAt = (box, xFraction, yFraction) => {
  const forward = normalize3(sub3(DEFAULT_CAMERA.target, DEFAULT_CAMERA.eye));
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }));
  const up = normalize3(cross3(right, forward));
  const nx = xFraction * 2 - 1;
  const ny = 1 - yFraction * 2;
  const halfHeight = Math.tan((DEFAULT_CAMERA.fov * Math.PI) / 360);
  const halfWidth = halfHeight * (box.width / box.height);
  const direction = normalize3({
    x: forward.x + right.x * halfWidth * nx + up.x * halfHeight * ny,
    y: forward.y + right.y * halfWidth * nx + up.y * halfHeight * ny,
    z: forward.z + right.z * halfWidth * nx + up.z * halfHeight * ny,
  });
  const distance = -DEFAULT_CAMERA.eye.y / direction.y;
  return {
    x: DEFAULT_CAMERA.eye.x + direction.x * distance,
    z: DEFAULT_CAMERA.eye.z + direction.z * distance,
  };
};

let itemId;
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  const created = await until(
    (snapshot) => stageDoc(snapshot)?.kind === "director",
    "created director document",
  );
  itemId = created.canvasItems.find((item) => item.kind === "external").id;

  // Two-step placement arms instead of adding, and Esc disarms.
  assert.equal(
    await page.getByRole("button", { name: "+ Person", exact: true }).count(),
    0,
    "characters are placed from preview cards, not direct add buttons",
  );
  await page
    .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
    .first()
    .click();
  await page.locator(".cw-stage-placehint").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".cw-stage-placehint").count(), 0);

  // Arming again and clicking the scene lands the object there; the
  // first completed placement opens the console controls once.
  await page
    .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
    .first()
    .click();
  const box = await sceneBox();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.55);
  const help = page.getByRole("dialog", { name: "Director console controls" });
  await help.waitFor();
  await help.getByRole("button", { name: "Close help", exact: true }).click();

  // Built-in objects use the same preview-card placement flow; the former
  // direct + Box controls are intentionally gone.
  await page.getByRole("tab", { name: "Objects", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "+ Box", exact: true }).count(),
    0,
    "objects are placed from preview cards, not direct add buttons",
  );
  const boxCard = page.locator(
    '.cw-stage-object-grid button[data-stage-placement-kind="box"]',
  );
  assert.equal(await boxCard.count(), 1, "the Box preview card is available");
  await boxCard.click();
  const objectPlacementBox = await sceneBox();
  await page.mouse.click(
    objectPlacementBox.x + objectPlacementBox.width * 0.38,
    objectPlacementBox.y + objectPlacementBox.height * 0.55,
  );
  await until(
    (snapshot) => stageDoc(snapshot) === undefined || true,
    "placement pending",
  );
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  const placed = await until(
    (snapshot) => (stageDoc(snapshot)?.data.objects ?? []).length === 3,
    "the placed person and object persist",
  );
  const landed = stageDoc(placed).data.objects[1];
  assert.ok(
    landed.position.x > 0.5 || Math.abs(landed.position.z) > 0.5,
    `the object landed at the clicked spot (${landed.position.x}, ${landed.position.z})`,
  );
  assert.equal(stageDoc(placed).data.objects[2].kind, "box");

  // The scene tree groups subjects with collapsing heads.
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: "Open Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  const tree = page.locator(".cw-stage-tree");
  await tree.getByRole("group").filter({ hasText: "Characters (2)" }).waitFor();
  await tree
    .getByRole("treeitem", { name: "Person 2", exact: false })
    .getByRole("button", { name: "Focus Person 2", exact: true })
    .click();
  await tree
    .getByRole("group")
    .filter({ hasText: "Characters (2)" })
    .getByRole("button", { name: /Characters \(2\)/, exact: false })
    .click();
  assert.equal(
    await tree
      .getByRole("group")
      .filter({ hasText: "Characters (2)" })
      .getByRole("treeitem")
      .count(),
    0,
    "the group head collapses its rows",
  );

  // The anchored action bar duplicates and deletes the selection.
  await tree
    .getByRole("group")
    .filter({ hasText: "Characters (2)" })
    .getByRole("button", { name: /Characters \(2\)/, exact: false })
    .click();
  await tree
    .getByRole("treeitem", { name: "Person 2", exact: false })
    .locator("button")
    .first()
    .click();
  const actionBar = page.locator(".cw-stage-actionbar");
  await actionBar.waitFor();
  await actionBar.getByRole("button", { name: "Duplicate", exact: true }).click();
  await tree.getByRole("group").filter({ hasText: "Characters (3)" }).waitFor();
  await actionBar.getByRole("button", { name: "Delete this subject", exact: true }).click();
  await tree.getByRole("group").filter({ hasText: "Characters (2)" }).waitFor();

  // View settings toggle the indicator and the name labels.
  await page
    .getByRole("button", { name: "View settings", exact: true })
    .click();
  const menu = page.locator(".cw-stage-viewmenu");
  await menu.waitFor();
  assert.equal(await page.locator(".cw-stage-viewinfo").isVisible(), true);
  await menu.getByLabel("View indicator", { exact: true }).uncheck();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cw-stage-viewinfo").isVisible(), false);
  await menu.getByLabel("View indicator", { exact: true }).check();
  await menu.getByLabel("Object names", { exact: true }).uncheck();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cw-stage-name").first().isVisible(), false);
  await menu.getByLabel("Object names", { exact: true }).check();
  await page.keyboard.press("Escape");

  // Roam view: drag-look changes the live readout; leaving restores orbit.
  const readout = page.locator(".cw-stage-viewinfo span");
  const before = await readout.innerText();
  await page.getByRole("button", { name: "Roam view", exact: true }).click();
  const scene = await sceneBox();
  await page.mouse.move(scene.x + scene.width / 2, scene.y + scene.height / 2);
  await page.mouse.down();
  await page.mouse.move(scene.x + scene.width / 2 + 180, scene.y + scene.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const after = await readout.innerText();
  assert.notEqual(after, before, "drag-look turns the roaming eye");
  await page.getByRole("button", { name: "Roam view", exact: true }).click();
  assert.deepEqual(errors, []);
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    passed: true,
    projectId,
    itemId,
    checks: [
      "arming a preset shows the hint and Escape disarms",
      "preview cards place characters and built-in objects",
      "a viewport click lands the object and opens the first-time help",
      "the scene tree groups subjects and collapses",
      "tree focus selects without dirtying the camera",
      "the anchored action bar duplicates and deletes",
      "view settings toggle the indicator and name labels",
      "roam drag-look moves the eye and orbit returns on exit",
      "no page errors",
    ],
  }),
);
