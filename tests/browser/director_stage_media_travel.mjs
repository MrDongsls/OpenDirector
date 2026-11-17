/** PR #330 review regressions: stage media surviving cross-project pastes,
 * canvas archives, slow or failing model loads, selection-tolerant emissive
 * materials, and the published stage's provenance edge. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { makeEmissiveGlb } from "./director_stage_fixture.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const shots = process.env.PR330_SHOTS ?? "/tmp/pr330";
mkdirSync(shots, { recursive: true });
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

const projectA = crypto.randomUUID();
const projectB = crypto.randomUUID();
const projectC = crypto.randomUUID();
for (const [id, label] of [
  [projectA, "Travel A"],
  [projectB, "Travel B"],
  [projectC, "Travel C"],
]) {
  await call(`/api/creation/projects/${id}/commands`, {
    commandId: crypto.randomUUID(),
    projectId: id,
    type: "project.create",
    payload: { name: `${label} ${id.slice(0, 8)}` },
  });
}

const state = (id) => call(`/api/creation/projects/${id}`);
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
});
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, predicate, label) => {
  const deadline = Date.now() + 30000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await read();
    if (predicate(snapshot)) return snapshot;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};
const apply = async () => {
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
};
const openStage = async (itemId) => {
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: "Open Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
};
const shot = (name) => page.screenshot({ path: `${shots}/${name}.png` });

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectA}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  const created = await until(
    () => state(projectA),
    (snapshot) => stageDoc(snapshot)?.kind === "director",
    "created director document",
  );
  const itemId = created.canvasItems.find(
    (item) => item.kind === "external",
  ).id;
  await page.getByLabel("Stage duration", { exact: true }).fill("1");
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "acceptance.glb",
      mimeType: "model/gltf-binary",
      buffer: makeEmissiveGlb(),
    });
  await page
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  await apply();
  const saved = await until(
    () => state(projectA),
    (snapshot) => {
      const doc = stageDoc(snapshot);
      const model = doc?.data.objects.find(
        (object) => object.kind === "gltf",
      );
      return model?.asset && doc?.data.still;
    },
    "saved stage pins the model and a captured still",
  );
  const modelObject = saved.editorDocuments
    .find((doc) => doc.kind === "director")
    .data.objects.find((object) => object.kind === "gltf");
  const gltfAssetId = modelObject.asset.assetId;
  const stillAssetId = saved.editorDocuments
    .find((doc) => doc.kind === "director")
    .data.still.assetId;
  assert.equal(
    saved.assets.some((asset) => asset.id === gltfAssetId && asset.kind === "file"),
    true,
  );

  // Authored emissive survives selecting and deselecting the model: the
  // captured still keeps the emission, a zeroed material would go dark.
  await openStage(itemId);
  await page.getByRole("button", { name: "acceptance", exact: true }).click();
  await page.getByRole("button", { name: "Person 1", exact: true }).click();
  await page
    .getByRole("button", { name: "Capture camera still", exact: true })
    .click();
  await page
    .getByText(
      "Still captured. Applying registers it as a project image asset.",
      { exact: true },
    )
    .waitFor();
  await apply();
  const emissiveSaved = await until(
    () => state(projectA),
    (snapshot) =>
      snapshot.editorDocuments
        .find((doc) => doc.kind === "director")
        .data.still.assetId !== stillAssetId,
    "emissive capture registers a new still",
  );
  const emissiveStillId = emissiveSaved.editorDocuments
    .find((doc) => doc.kind === "director")
    .data.still.assetId;
  const probe = await page.evaluate(async (path) => {
    const response = await fetch(path, {
      headers: { "X-OpenDirector-Request": "1" },
    });
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // The emissive triangle is small on screen; its brightest pixel must
    // dominate, while the dark blue-grey background stays red-deficient.
    let strongest = -255;
    for (let index = 0; index < data.length; index += 4) {
      strongest = Math.max(strongest, data[index] - data[index + 2]);
    }
    return strongest;
  }, `/api/creation/projects/${projectA}/assets/${emissiveStillId}/content`);
  assert.ok(
    probe > 60,
    `authored emissive must survive into the still (strongest red minus blue ${probe})`,
  );
  await shot("lane6-emissive");

  // Stage JSON round trip: the export strips preview URLs, so the same
  // project's import must resolve the pinned asset instead of a placeholder.
  await openStage(itemId);
  const jsonDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export stage JSON", exact: true })
    .click();
  const jsonPath = await (await jsonDownload).path();
  await page
    .locator('input[type="file"][accept^="application/json"]')
    .setInputFiles({
      name: "roundtrip.stage.json",
      mimeType: "application/json",
      buffer: readFileSync(jsonPath),
    });
  await page.getByRole("button", { name: "acceptance", exact: true }).waitFor();
  assert.equal(
    await page
      .getByText("The imported asset is unavailable.", { exact: true })
      .count(),
    0,
    "the round trip must resolve the pinned model, not flag it unavailable",
  );
  await apply();
  const roundTripped = await until(
    () => state(projectA),
    (snapshot) =>
      snapshot.editorDocuments
        .find((doc) => doc.kind === "director")
        .data.objects.find((object) => object.kind === "gltf")?.asset
        ?.assetId === gltfAssetId,
    "stage JSON round trip keeps the pinned model",
  );
  assert.equal(roundTripped.assets.length, emissiveSaved.assets.length);
  await shot("lane5-json-roundtrip");

  // A slow model fetch must hold the render until the model arrives. The
  // delay outlasts the whole encode, so a render that cloned the placeholder
  // would complete before the bytes are even released.
  let modelReleasedAt = 0;
  await page.route(`**/assets/${gltfAssetId}**`, async (route) => {
    await sleep(8000);
    modelReleasedAt = Date.now();
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await openStage(itemId);
  await page
    .getByRole("button", { name: "Render preview MP4", exact: true })
    .click();
  await page
    .getByText("Preview MP4 complete · 1280×720 · 30 fps", { exact: true })
    .waitFor({ timeout: 240000 });
  assert.ok(
    modelReleasedAt > 0 && Date.now() >= modelReleasedAt,
    "render must not complete before the delayed model arrives",
  );
  await page
    .getByRole("button", { name: "Add preview video to canvas", exact: true })
    .click();
  const published = await until(
    () => state(projectA),
    (snapshot) =>
      snapshot.canvasItems.some(
        (item) =>
          item.kind === "video" && item.binding.role === "material",
      ),
    "the preview MP4 publishes an output node",
  );
  const outputItem = published.canvasItems.find(
    (item) => item.kind === "video" && item.binding.role === "material",
  );
  const outputAsset = published.assets.find(
    (asset) => asset.id === outputItem.binding.objectRef.assetId,
  );
  assert.equal(outputAsset.provenance.sourceItemId, itemId);
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__edge").length >= 1,
  );
  await shot("lane7-published-edge");
  await page.unroute(`**/assets/${gltfAssetId}**`);

  // A model fetch that outright fails refuses the render with the localized
  // load failure, and publishes nothing.
  await page.route(`**/assets/${gltfAssetId}**`, (route) =>
    route.fulfill({ status: 404, body: "gone" }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await openStage(itemId);
  await page
    .getByRole("button", { name: "Render preview MP4", exact: true })
    .click();
  await page
    .getByText(
      "Could not load “acceptance”. The file may be corrupt or reference external resources.",
      { exact: true },
    )
    .waitFor();
  await sleep(1500);
  const afterFailure = await state(projectA);
  assert.equal(
    afterFailure.canvasItems.filter((item) => item.kind === "video").length,
    1,
    "a failed model load must not publish another output",
  );
  await shot("lane4-render-refused");
  await page.unroute(`**/assets/${gltfAssetId}**`);

  // Cross-project paste re-homes the pinned still and the model bytes.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Control+c");
  await page
    .getByRole("button", { name: "Switch project", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: `Travel B ${projectB.slice(0, 8)}` })
    .click();
  await page
    .locator(".cw-project-name")
    .filter({ hasText: `Travel B ${projectB.slice(0, 8)}` })
    .waitFor();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Control+v");
  const pasted = await until(
    () => state(projectB),
    (snapshot) => {
      const doc = stageDoc(snapshot);
      const model = doc?.data.objects.find(
        (object) => object.kind === "gltf",
      );
      return (
        snapshot.canvasItems.some((item) => item.kind === "external") &&
        doc?.data.still &&
        model?.asset &&
        snapshot.assets.some(
          (asset) =>
            asset.id === doc.data.still.assetId && asset.kind === "image",
        ) &&
        snapshot.assets.some(
          (asset) => asset.id === model.asset.assetId && asset.kind === "file",
        )
      );
    },
    "pasted stage pins assets registered in the target project",
  );
  const pastedDoc = stageDoc(pasted);
  const pastedModel = pastedDoc.data.objects.find(
    (object) => object.kind === "gltf",
  );
  assert.notEqual(pastedDoc.data.still.assetId, stillAssetId);
  assert.notEqual(pastedModel.asset.assetId, gltfAssetId);
  await shot("lane2-cross-project-paste");

  // The pasted canvas exports as an archive and re-imports into a third
  // project with the stage's model and still bytes carried inside. The
  // archive's node ids collide with project A's originals, so project C keeps
  // the import free of that collision, which is also the sharing scenario.
  const archiveDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export canvas", exact: true })
    .click();
  const archivePath = await (await archiveDownload).path();
  await page
    .getByRole("button", { name: "Switch project", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: `Travel C ${projectC.slice(0, 8)}` })
    .click();
  await page
    .locator(".cw-project-name")
    .filter({ hasText: `Travel C ${projectC.slice(0, 8)}` })
    .waitFor();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept=".canvas,application/zip"]')
    .setInputFiles(archivePath);
  // An archive import becomes its own new project and switches to it; the
  // workspace URL is reset, so the project is identified by its title.
  await page
    .getByText(/Imported “Travel B .*” and restored \d+ assets\./)
    .waitFor();
  const listed = await call("/api/creation/projects");
  const importedProjectId = listed.projects.find(
    (project) =>
      project.name.startsWith(`Travel B ${projectB.slice(0, 8)}`) &&
      project.id !== projectB,
  )?.id;
  assert.ok(importedProjectId, JSON.stringify(listed.projects.map((p) => p.name)));
  const archived = await until(
    () => state(importedProjectId),
    (snapshot) => {
      const doc = stageDoc(snapshot);
      const model = doc?.data.objects.find(
        (object) => object.kind === "gltf",
      );
      return (
        snapshot.canvasItems.some((item) => item.kind === "external") &&
        doc?.data.still &&
        model?.asset &&
        snapshot.assets.some(
          (asset) =>
            asset.id === doc.data.still.assetId && asset.kind === "image",
        ) &&
        snapshot.assets.some(
          (asset) =>
            asset.id === model.asset.assetId && asset.kind === "file",
        )
      );
    },
    "the archive import registers the stage's media in a new project",
  );
  const importedDoc = stageDoc(archived);
  assert.notEqual(
    importedDoc.data.still.assetId,
    stageDoc(pasted).data.still.assetId,
  );
  const importedItem = archived.canvasItems.find(
    (item) => item.kind === "external",
  );
  await openStage(importedItem.id);
  await page.getByRole("button", { name: "acceptance", exact: true }).waitFor();
  assert.equal(
    await page
      .getByText("The imported asset is unavailable.", { exact: true })
      .count(),
    0,
    "the archived model must load in the importing project",
  );
  await apply();
  assert.deepEqual(errors, []);
  await shot("lane3-archive-roundtrip");

  console.log(
    JSON.stringify({
      passed: true,
      projectA,
      projectB,
      checks: [
        "authored emissive survives selection into the captured still",
        "stage JSON round trip resolves pinned assets in the same project",
        "a delayed model holds the render and the MP4 publishes",
        "the published stage renders a provenance edge",
        "a failed model load refuses the render without publishing",
        "cross-project paste re-homes the still and model pins",
        "canvas archive round trip carries stage media",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  await shot("failure").catch(() => {});
  console.error("page errors:", JSON.stringify(errors));
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
