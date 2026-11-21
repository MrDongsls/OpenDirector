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
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
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
  payload: { name: `Pointer alignment ${projectId.slice(0, 8)}` },
});
const state = () => call(`/api/creation/projects/${projectId}`);
const stageDoc = (snapshot) =>
  snapshot.editorDocuments.find((candidate) => candidate.kind === "director");
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
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(20000);
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
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
const camera = {
  eye: { x: 8, y: 6, z: 10 },
  target: { x: 0, y: 1, z: 0 },
  fov: 45,
};
const groundPointAt = (box, xFraction, yFraction) => {
  const forward = normalize3(sub3(camera.target, camera.eye));
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }));
  const up = normalize3(cross3(right, forward));
  const nx = xFraction * 2 - 1;
  const ny = 1 - yFraction * 2;
  const halfHeight = Math.tan((camera.fov * Math.PI) / 360);
  const halfWidth = halfHeight * (box.width / box.height);
  const direction = normalize3({
    x: forward.x + right.x * halfWidth * nx + up.x * halfHeight * ny,
    y: forward.y + right.y * halfWidth * nx + up.y * halfHeight * ny,
    z: forward.z + right.z * halfWidth * nx + up.z * halfHeight * ny,
  });
  const distance = -camera.eye.y / direction.y;
  return {
    x: camera.eye.x + direction.x * distance,
    z: camera.eye.z + direction.z * distance,
  };
};
const projectPointAt = (box, point) => {
  const forward = normalize3(sub3(camera.target, camera.eye));
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }));
  const up = normalize3(cross3(right, forward));
  const view = sub3(point, camera.eye);
  const depth = view.x * forward.x + view.y * forward.y + view.z * forward.z;
  const halfHeight = depth * Math.tan((camera.fov * Math.PI) / 360);
  const halfWidth = halfHeight * (box.width / box.height);
  return {
    x:
      box.x +
      (((view.x * right.x + view.y * right.y + view.z * right.z) / halfWidth +
        1) *
        box.width) /
        2,
    y:
      box.y +
      ((1 - (view.x * up.x + view.y * up.y + view.z * up.z) / halfHeight) *
        box.height) /
        2,
  };
};
const coloredPixelsNear = async (screenshot, center, radius) =>
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
              if (
                (red > 180 && green < 80 && blue < 80) ||
                (green > 180 && red < 80 && blue < 80) ||
                (blue > 180 && red < 80 && green < 100)
              )
                count++;
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

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).waitFor();
  const box = await page.locator(".cw-stage-scene").boundingBox();
  assert.ok(box);
  const clicks = [
    [0.37, 0.53],
    [0.58, 0.59],
    [0.69, 0.66],
  ];
  for (const [x, y] of clicks) {
    await page
      .locator('.cw-stage-object-grid button[data-stage-placement-kind="person"]')
      .first()
      .click();
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    if (
      await page
        .getByRole("dialog", { name: "Director console controls" })
        .count()
    )
      await page
        .getByRole("dialog", { name: "Director console controls" })
        .getByRole("button", { name: "Close help", exact: true })
        .click();
  }
  const first = groundPointAt(box, ...clicks[0]);
  const firstCenter = projectPointAt(box, { x: first.x, y: 0.9, z: first.z });
  await page.mouse.click(firstCenter.x, firstCenter.y);
  assert.equal(
    await page
      .locator(".cw-stage-right-tree .cw-stage-tree-row")
      .filter({ hasText: "Person 2" })
      .locator("button")
      .first()
      .getAttribute("aria-selected"),
    "true",
    "clicking the visible object center selects the object under the cursor",
  );
  await page.waitForTimeout(500);
  const handleCenter = projectPointAt(box, { x: first.x, y: 0, z: first.z });
  const handleAhead = projectPointAt(box, { x: first.x + 1, y: 0, z: first.z });
  const handleDirection = {
    x: handleAhead.x - handleCenter.x,
    y: handleAhead.y - handleCenter.y,
  };
  const handleLength = Math.hypot(handleDirection.x, handleDirection.y);
  const handleStart = {
    x: handleCenter.x + (handleDirection.x / handleLength) * box.width * 0.03,
    y: handleCenter.y + (handleDirection.y / handleLength) * box.width * 0.03,
  };
  const beforeDrag = Number(
    await page.getByLabel("Position X", { exact: true }).inputValue(),
  );
  await page.mouse.move(handleStart.x, handleStart.y);
  await page.mouse.down();
  await page.mouse.move(
    handleStart.x + (handleDirection.x / handleLength) * box.width * 0.08,
    handleStart.y + (handleDirection.y / handleLength) * box.width * 0.08,
    { steps: 12 },
  );
  await page.mouse.up();
  const afterDrag = Number(
    await page.getByLabel("Position X", { exact: true }).inputValue(),
  );
  assert.ok(
    afterDrag > beforeDrag + 0.1,
    `the visible X gizmo follows Person 2 after selection (before ${beforeDrag}, after ${afterDrag})`,
  );
  await page
    .locator(".cw-stage-console")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await page.waitForFunction(
    ({ label, value }) => {
      const field = document.querySelector(`[aria-label="${label}"]`);
      return (
        field instanceof HTMLInputElement &&
        Math.abs(Number(field.value) - value) < 0.01
      );
    },
    { label: "Position X", value: beforeDrag },
  );
  const screenshot = await page.screenshot();
  const gizmoPixels = await coloredPixelsNear(
    screenshot,
    projectPointAt(box, { x: first.x, y: 0, z: first.z }),
    box.width * 0.24,
  );
  assert.ok(
    gizmoPixels > 100,
    `the rendered gizmo is in the selected object's viewport region (colored pixels ${gizmoPixels})`,
  );
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  const snapshot = await until(
    (candidate) => (stageDoc(candidate)?.data.objects ?? []).length === 4,
    "three placed people",
  );
  const objects = stageDoc(snapshot).data.objects.slice(1);
  for (const [index, [x, y]] of clicks.entries()) {
    const expected = groundPointAt(box, x, y);
    const actual = objects[index].position;
    const distance = Math.hypot(actual.x - expected.x, actual.z - expected.z);
    assert.ok(
      distance < 0.05,
      `click ${index} landed at (${actual.x}, ${actual.z}), expected (${expected.x}, ${expected.z}), error ${distance}`,
    );
  }
  console.log(JSON.stringify({ passed: true, projectId, objects }));
} finally {
  await browser.close();
}
