/**
 * V1 visual-alignment evidence for the Director Stage workbench shell.
 *
 * The assertions intentionally cover geometry and computed surface colors,
 * while the PNG is the human comparison artifact against the local Jiemeng
 * screenshots.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(pathname, body) {
  const response = await fetch(api + pathname, {
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
  payload: { name: `Stage visual ${projectId.slice(0, 8)}` },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const viewportWidth = Number(process.env.VISUAL_WIDTH ?? 1700);
const viewportHeight = Number(process.env.VISUAL_HEIGHT ?? 1100);
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: viewportWidth, height: viewportHeight },
});
page.setDefaultTimeout(20000);
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);

const outputDirectory = path.resolve("artifacts/director-stage/visual");
fs.mkdirSync(outputDirectory, { recursive: true });
const screenshotPath = path.join(
  outputDirectory,
  `v1-stage-shell-${viewportWidth}x${viewportHeight}.png`,
);
const dynamicScreenshotPath = path.join(
  outputDirectory,
  `v2-stage-dynamic-${viewportWidth}x${viewportHeight}.png`,
);

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Open Director Stage", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Person", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Director console controls" });
  if (await help.count()) {
    await help.getByRole("button", { name: "Close help", exact: true }).click();
  }

  const shell = page.locator(".cw-stage-console");
  const topbar = page.locator(".cw-stage-topbar");
  const left = page.locator(".cw-stage-left");
  const right = page.locator(".cw-stage-right");
  const bottom = page.locator(".cw-stage-bottom");
  const staticMode = page.getByRole("button", { name: "Static", exact: true });
  const dynamicMode = page.getByRole("button", { name: "Dynamic", exact: true });
  const brand = page.locator(".cw-stage-identity h2");
  const assetSearch = page.locator(".cw-stage-asset-search input");
  const objectGrid = page.locator(".cw-stage-object-grid");
  await shell.waitFor();

  const [shellBox, topbarBox, leftBox, rightBox] = await Promise.all(
    [shell, topbar, left, right].map((locator) => locator.boundingBox()),
  );
  assert.ok(shellBox && topbarBox && leftBox && rightBox);
  assert.equal(shellBox.x, 0);
  assert.equal(shellBox.y, 0);
  assert.equal(shellBox.width, viewportWidth);
  assert.equal(shellBox.height, viewportHeight);
  assert.ok(Math.abs(topbarBox.height - 52) <= 1);
  assert.equal(leftBox.x, 0);
  assert.ok(Math.abs(leftBox.width - 248) <= 1);
  assert.ok(Math.abs(leftBox.y - 52) <= 1);
  assert.equal(rightBox.x + rightBox.width, viewportWidth);
  assert.ok(Math.abs(rightBox.width - 300) <= 1);
  assert.ok(Math.abs(rightBox.y - 52) <= 1);
  assert.equal(await staticMode.getAttribute("aria-pressed"), "true");
  assert.equal(await dynamicMode.getAttribute("aria-pressed"), "false");
  assert.equal(await bottom.count(), 0);
  await dynamicMode.click();
  await bottom.waitFor();
  const timeOutput = bottom.locator(".cw-stage-transport > output").first();
  await timeOutput.waitFor();
  const timeAtModeSwitch = await timeOutput.textContent();
  await page.waitForTimeout(350);
  assert.equal(
    await timeOutput.textContent(),
    timeAtModeSwitch,
    "switching to dynamic mode must not start playback",
  );
  const bottomBox = await bottom.boundingBox();
  assert.ok(bottomBox);
  assert.equal(bottomBox.x, 0);
  assert.equal(bottomBox.width, viewportWidth);
  assert.ok(Math.abs(bottomBox.height - 280) <= 1);
  assert.equal(await dynamicMode.getAttribute("aria-pressed"), "true");
  assert.equal(await staticMode.getAttribute("aria-pressed"), "false");
  await page.screenshot({ path: dynamicScreenshotPath, fullPage: false });
  await staticMode.click();
  await bottom.waitFor({ state: "detached" });
  assert.equal(await brand.textContent(), "3D Director Stage");
  assert.equal(
    await assetSearch.getAttribute("placeholder"),
    "Search assets",
  );
  assert.equal(await objectGrid.evaluate((element) => getComputedStyle(element).display), "grid");
  assert.equal(
    await objectGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
    2,
  );
  const objectCards = objectGrid.locator("button");
  const objectPreviews = objectGrid.locator(".cw-stage-object-preview");
  assert.equal(await objectPreviews.count(), await objectCards.count());
  const firstPreview = objectPreviews.first();
  await firstPreview.locator("img").waitFor({ state: "visible" });
  assert.equal(await firstPreview.getAttribute("data-thumbnail-state"), "ready");
  const thumbnail = firstPreview.locator("img");
  assert.equal(await thumbnail.count(), 1);
  assert.match(await thumbnail.getAttribute("src"), /^blob:/);
  assert.ok(await thumbnail.evaluate((element) => element.naturalWidth > 0 && element.naturalHeight > 0));
  assert.equal(
    await firstPreview.getAttribute("data-stage-object-kind"),
    "person",
  );

  const [consoleBackground, leftBackground, rightBackground] =
    await Promise.all(
      [shell, left, right].map((locator) =>
        locator.evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    );
  assert.equal(consoleBackground, "rgb(11, 11, 11)");
  assert.equal(leftBackground, "rgb(26, 26, 26)");
  assert.equal(rightBackground, "rgb(26, 26, 26)");

  await page.screenshot({ path: screenshotPath, fullPage: false });
} finally {
  await browser.close();
}

console.log(
  JSON.stringify({
    passed: true,
    screenshot: screenshotPath,
    checks: [
      "fullscreen shell bounds",
      "52px top bar",
      "248px left rail",
      "300px right rail",
      "static mode hides the timeline",
      "dynamic mode shows a 280px bottom timeline",
      "neutral dark workbench surfaces",
    ],
  }),
);
