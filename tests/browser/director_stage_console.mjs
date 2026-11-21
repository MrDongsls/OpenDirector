/** Console-phase acceptance: controls cheat-sheet, split live preview and
 * transform sliders over the fullscreen console. */
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
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Console ${projectId.slice(0, 8)}` },
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

  // The first completed placement opens the console controls once: arm,
  // land the click, then the panel appears.
  const scene = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(scene);
  await page
    .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
    .first()
    .click();
  await page.mouse.click(
    scene.x + scene.width * 0.55,
    scene.y + scene.height * 0.5,
  );
  const firstHelp = page.getByRole("dialog", { name: "Director console controls" });
  await firstHelp.getByText("Left-drag · orbit").waitFor();
  await firstHelp
    .getByRole("button", { name: "Close help", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "Director console controls" })
      .count(),
    0,
  );
  // A second placement does not reopen it: the marker is one-shot.
  await page
    .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
    .first()
    .click();
  await page.mouse.click(
    scene.x + scene.width * 0.45,
    scene.y + scene.height * 0.5,
  );
  await page.waitForTimeout(300);
  assert.equal(
    await page
      .getByRole("dialog", { name: "Director console controls" })
      .count(),
    0,
  );
  // The top-bar entry reopens the same panel; Escape owns the close.
  await page
    .getByRole("button", { name: "Shortcuts", exact: true })
    .click();
  const reopened = page.getByRole("dialog", { name: "Director console controls" });
  await reopened.waitFor();
  await reopened.hover();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("dialog", { name: "Director console controls" })
      .count(),
    0,
    "Escape closes the help panel without guard-closing the editor",
  );
  assert.equal(
    await page.getByRole("button", { name: "Apply edits", exact: true }).count(),
    1,
    "the editor itself stays open",
  );

  // Transform sliders pair with the exact inputs and drive the stage.
  await page
    .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
    .first()
    .click();
  const positionSlider = page.getByLabel("Position X slider", { exact: true });
  await positionSlider.waitFor();
  await positionSlider.fill("5");
  assert.equal(
    await page.getByLabel("Position X", { exact: true }).inputValue(),
    "5",
    "dragging the slider updates the exact input immediately",
  );
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  const saved = await until(
    (snapshot) =>
      stageDoc(snapshot)?.data.objects.some(
        (object) => Math.abs(object.position.x - 5) < 1e-6,
      ),
    "slider-driven position persists",
  );
  const movedId = saved.editorDocuments
    .find((doc) => doc.kind === "director")
    .data.objects.find((object) => Math.abs(object.position.x - 5) < 1e-6).id;

  // Each camera can be selected in the independent preview frame after a
  // camera is duplicated from the right-side inspector.
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: "Open Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  await page
    .getByRole("tab", { name: "Cameras", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Duplicate as new camera", exact: true })
    .click();
  const cameraPreviewSelect = page.getByLabel("Preview camera", { exact: true });
  await cameraPreviewSelect.waitFor();
  await cameraPreviewSelect.selectOption({ label: "Camera 2" });
  assert.equal(
    await cameraPreviewSelect.locator("option:checked").innerText(),
    "Camera 2",
    "the independent preview follows the selected camera",
  );
  assert.equal(await page.locator(".cw-stage-pipframe").count(), 1);

  // The preview selection is editor-local: the moved object stays as saved.
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  const final = await state();
  assert.ok(
    final.editorDocuments
      .find((doc) => doc.kind === "director")
      .data.objects.some((object) => object.id === movedId),
    "the slider-moved object survives",
  );
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
      "first object add opens the console controls once",
      "the top-bar shortcuts entry reopens the panel",
      "Escape closes the help panel without closing the editor",
      "transform sliders drive the exact inputs and persist",
      "the right inspector duplicates a camera",
      "the independent preview follows the selected camera",
      "no page errors",
    ],
  }),
);
