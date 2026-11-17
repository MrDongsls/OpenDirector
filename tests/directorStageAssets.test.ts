import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createLocalStage,
  parseLocalStageValue,
  probeStageAsset,
  sameLocalStage,
  unregisteredStageAssets,
} from "../src/canvas/stageDocument.ts";
import {
  CreationProjection,
  stageUploadTitle,
} from "../src/backend/creationProjection.ts";
import { CreationClient } from "../src/backend/creationClient.ts";
import {
  captureClipboardMedia,
  transferClipboardMedia,
  type RegisteredMedia,
} from "../src/canvas/clipboardMedia.ts";
import {
  buildCanvasArchive,
  readCanvasArchive,
} from "../src/canvas/canvasArchive.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";
import type { CanvasFragment } from "../src/canvas/operations.ts";
import { readZip } from "../src/canvas/zipArchive.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import type { AssetRef } from "../src/contracts/generated.ts";

const asset = {
  assetId: "asset-gltf",
  revision: 2,
  fingerprint: `sha256:${"a".repeat(64)}`,
  kind: "file" as const,
};

test("GLB/GLTF stage objects accept transient previews and retain stable asset identity", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const imported = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "character",
        format: "glb",
        source: "blob:director-preview",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  assert.equal(imported.objects[0]!.asset?.assetId, "asset-gltf");
  assert.equal(imported.objects[0]!.source, "blob:director-preview");
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(imported))),
    imported,
  );
  assert.equal(
    sameLocalStage(
      imported,
      parseLocalStageValue({
        ...imported,
        objects: [{ ...imported.objects[0]!, source: "blob:reloaded" }],
      }),
    ),
    true,
  );
});

test("a new local imported object may be previewed before its first project save", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const parsed = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "scene",
        format: "gltf",
        source: "blob:unsaved-scene",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  assert.equal(parsed.objects[0]!.asset, undefined);
  assert.equal(parsed.objects[0]!.role, "scene");
});

test("imported asset validation rejects missing identity, scene motion and absent animation data", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const base = {
    ...person,
    kind: "gltf",
    role: "character",
    format: "glb",
    asset,
    animationNames: [],
    hasAnimation: false,
    motionClips: [],
  };
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...base, asset: undefined }],
      }),
    /舞台对象/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            role: "scene",
            motionClips: [
              {
                id: "scene-motion",
                start: 0,
                duration: 1,
                motion: { preset: "idle", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /场景素材/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            motionClips: [
              {
                id: "missing-animation",
                start: 0,
                duration: 1,
                motion: { preset: "walk", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /没有动画/,
  );
});

test("stage upload titles stay path-free whatever the object is named", () => {
  assert.equal(stageUploadTitle("hero/v2", "glb"), "hero_v2.glb");
  assert.equal(stageUploadTitle("a\\b\u0007c", "gltf"), "a_b_c.gltf");
  assert.equal(stageUploadTitle("   ", "glb"), "导入模型.glb");
  assert.equal(
    stageUploadTitle("长".repeat(300), "gltf").length <= 255,
    true,
  );
  assert.equal(stageUploadTitle("长".repeat(300), "gltf").endsWith(".gltf"), true);
  // The limit cuts code points, never splitting a surrogate pair: a cut
  // title must round-trip through UTF-8 without replacement characters.
  const emoji = stageUploadTitle("a".repeat(249) + "😀", "glb");
  assert.ok(emoji.includes("😀"));
  assert.equal(Buffer.from(emoji, "utf8").toString("utf8"), emoji);
});

test("stage JSON imports flag imported objects the project has not registered", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const foreign = parseLocalStageValue({
    ...stage,
    objects: [
      person,
      {
        ...person,
        id: "foreign-actor",
        kind: "gltf",
        name: "Foreign actor",
        role: "character",
        format: "glb",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
      {
        ...person,
        id: "local-preview",
        kind: "gltf",
        name: "Unsaved import",
        role: "scene",
        format: "gltf",
        source: "blob:unsaved",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  const registered = (ref: AssetRef) =>
    ref.assetId !== "asset-gltf" && ref.revision <= 5;
  const flagged = unregisteredStageAssets(foreign, registered);
  assert.deepEqual(
    flagged.map((object) => object.id),
    ["foreign-actor"],
  );
  // A pinned asset at an older revision than the registered one still resolves.
  assert.deepEqual(
    unregisteredStageAssets(foreign, () => true),
    [],
  );
});

function glbBuffer(payload: string): ArrayBuffer {
  const padded = payload + " ".repeat((4 - (payload.length % 4)) % 4);
  const body = new Uint8Array(12 + 8 + padded.length);
  const view = new DataView(body.buffer);
  body.set([0x67, 0x6c, 0x54, 0x46], 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, body.length, true);
  view.setUint32(12, padded.length, true);
  body.set([0x4a, 0x53, 0x4f, 0x4e], 16);
  body.set(new TextEncoder().encode(padded), 20);
  return body.buffer;
}

test("stage asset probing distinguishes models, external resources and corruption", () => {
  const gltf = (document: unknown) =>
    new TextEncoder().encode(JSON.stringify(document)).buffer as ArrayBuffer;
  assert.deepEqual(
    probeStageAsset(glbBuffer(JSON.stringify({ asset: { version: "2.0" } }))),
    { format: "glb", external: false, compressed: false },
  );
  assert.deepEqual(
    probeStageAsset(
      glbBuffer(
        JSON.stringify({
          asset: { version: "2.0" },
          buffers: [{ uri: "scene.bin", byteLength: 4 }],
        }),
      ),
    ),
    { format: "glb", external: true, compressed: false },
  );
  assert.deepEqual(
    probeStageAsset(gltf({ asset: { version: "2.0" } })),
    { format: "gltf", external: false, compressed: false },
  );
  // Valid magic but truncated: the declared length exceeds the bytes present.
  const truncated = new Uint8Array(12);
  truncated.set([0x67, 0x6c, 0x54, 0x46], 0);
  new DataView(truncated.buffer).setUint32(8, 4096, true);
  assert.equal(probeStageAsset(truncated.buffer), undefined);
  // Valid container, unusable embedded JSON.
  assert.equal(probeStageAsset(glbBuffer("{not json")), "corrupt");
  assert.equal(probeStageAsset(glbBuffer("[1, 2, 3]")), "corrupt");
  assert.equal(probeStageAsset(gltf({ no: "document" })), undefined);
  assert.equal(probeStageAsset(gltf({ asset: { version: "2.0" } }).slice(0, 4)), undefined);
});

test("stage asset probing flags documents that need missing decoders", () => {
  const gltf = (document: unknown) =>
    new TextEncoder().encode(JSON.stringify(document)).buffer as ArrayBuffer;
  for (const extension of [
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_texture_basisu",
  ]) {
    assert.deepEqual(
      probeStageAsset(
        gltf({
          asset: { version: "2.0" },
          extensionsUsed: [extension],
        }),
      ),
      { format: "gltf", external: false, compressed: true },
      extension,
    );
    assert.deepEqual(
      probeStageAsset(
        glbBuffer(
          JSON.stringify({
            asset: { version: "2.0" },
            extensionsRequired: [extension],
          }),
        ),
      ),
      { format: "glb", external: false, compressed: true },
      extension,
    );
  }
  // Unrelated extensions stay importable.
  assert.deepEqual(
    probeStageAsset(
      gltf({
        asset: { version: "2.0" },
        extensionsUsed: ["KHR_materials_unlit"],
      }),
    ),
    { format: "gltf", external: false, compressed: false },
  );
});

test("director stage reads keep pinned identity when media bytes are unavailable", async () => {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const client = new CreationClient(source.project.id);
  client.install(source);
  const unavailable = "00000000-0000-0000-0000-00000000000e";
  client.mediaUrl = async (id) => {
    if (id === unavailable) throw new Error("asset content gone");
    return `blob:${id}`;
  };
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const document = await new CreationProjection(client).read();
  const stage = document.nodes
    .map((node) => node.data.localStage)
    .find((value) => value?.objects.some((object) => object.kind === "gltf"));
  assert.ok(stage, "director stage node missing from projection");
  const imported = stage.objects.find((object) => object.kind === "gltf")!;
  assert.equal(imported.asset?.assetId, unavailable);
  assert.equal(imported.source, undefined);
  // The document stays valid without the preview URL; the editor shows the
  // unavailable-asset notice instead of failing to reopen.
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(stage))).objects.find(
      (object) => object.kind === "gltf",
    )!.asset,
    imported.asset,
  );
  // An unreadable pin surfaces as a visible missing-asset state.
  const stageNode = document.nodes.find(
    (node) => node.data.localStage === stage,
  )!;
  assert.equal(stageNode.data.assetState, "missing");
});

test("director stage reads report ready when every pinned asset resolves", async () => {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const client = new CreationClient(source.project.id);
  client.install(source);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const document = await new CreationProjection(client).read();
  const stageNode = document.nodes.find((node) =>
    node.data.localStage?.objects.some((object) => object.kind === "gltf"),
  );
  assert.ok(stageNode, "director stage node missing from projection");
  assert.equal(stageNode.data.assetState, "ready");
});

/** The projection's save path for a director node, isolated from canvas state. */
function directorWrite(node: {
  id: string;
  title?: string;
  localStage?: unknown;
  stillCapture?: string;
  stillAsset?: AssetRef;
}) {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const client = new CreationClient(source.project.id);
  client.install(source);
  const imported: { name: string; kind: string }[] = [];
  client.importBlob = async (blob, name, kind) => {
    imported.push({ name, kind });
    void blob;
    return {
      assetId: `imported-${imported.length}`,
      revision: 1,
      fingerprint: `sha256:${"d".repeat(64)}`,
      kind,
    };
  };
  const projection = new CreationProjection(client);
  return {
    imported,
    document: (projection as unknown as {
      editorInput: (
        node: unknown,
        kind: "director",
      ) => Promise<{ kind: string; data: Record<string, unknown> }>;
    }).editorInput(
      {
        id: node.id,
        type: "external",
        position: { x: 0, y: 0 },
        data: {
          title: node.title,
          localStage: node.localStage,
          stillCapture: node.stillCapture,
          stillAsset: node.stillAsset,
        },
      },
      "director",
    ),
  };
}

test("director saves register unsaved model bytes and captured stills as project assets", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      ...createLocalStage().objects,
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        source: "data:application/octet-stream;base64,R0xGQg==",
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  const write = directorWrite({
    id: "director-node",
    title: "Stage board",
    localStage: stage,
    stillCapture: "data:image/png;base64,aVBoTkc=",
  });
  const document = await write.document;
  assert.equal(document.kind, "director");
  const objects = document.data.objects as {
    kind: string;
    asset?: { assetId: string };
    source?: string;
  }[];
  const walker = objects.find((object) => object.kind === "gltf")!;
  assert.equal(walker.asset?.assetId, "imported-1");
  // Browser-only preview URLs never reach the contract.
  assert.equal(walker.source, undefined);
  assert.equal(
    (document.data.still as { assetId: string }).assetId,
    "imported-2",
  );
  assert.deepEqual(write.imported, [
    { name: stageUploadTitle("Walker", "glb"), kind: "file" },
    { name: "Stage board.png", kind: "image" },
  ]);
});

test("director saves keep the pinned still when no fresh capture exists", async () => {
  const still = {
    assetId: "still-1",
    revision: 1,
    fingerprint: `sha256:${"e".repeat(64)}`,
    kind: "image" as const,
  };
  const write = directorWrite({
    id: "director-node",
    localStage: createLocalStage(),
    stillAsset: still,
  });
  const document = await write.document;
  assert.deepEqual(document.data.still, still);
  assert.deepEqual(write.imported, []);
});

test("director saves fail loudly when imported model bytes cannot be read", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        // A blob URL that died with the page that created it.
        source: "blob:revoked-session",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  await assert.rejects(directorWrite({ id: "director-node", localStage: stage }).document);
});

const stillRef: AssetRef = {
  assetId: "still-1",
  revision: 1,
  fingerprint: `sha256:${"e".repeat(64)}`,
  kind: "image",
};

test("cross-project pastes re-home the stage still and imported models", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      ...createLocalStage().objects,
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        source: "data:application/octet-stream;base64,R0xGQg==",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  const node = createNode("external", { x: 0, y: 0 }, {
    title: "Stage board",
    localStage: stage,
    src: "data:image/png;base64,aVBoTgc=",
    stillAsset: stillRef,
    stillCapture: "data:image/png;base64,aVBoTgc=",
  });
  const fragment: CanvasFragment = { nodes: [node], edges: [] };
  const media = captureClipboardMedia("project-a", fragment, {
    read: async (src) =>
      new Blob([src], {
        type: src.startsWith("data:image") ? "image/png" : "model/gltf-binary",
      }),
  });
  const calls: { title: string; kind: string }[] = [];
  const register = async (
    _blob: Blob,
    title: string,
    kind: string,
  ): Promise<RegisteredMedia> => {
    calls.push({ title, kind });
    return {
      assetId: `copy-${title}`,
      src: `blob:target/${title}`,
      ref: {
        assetId: `copy-${title}`,
        revision: 1,
        fingerprint: `sha256:${title}`,
        kind: kind as RegisteredMedia["ref"]["kind"],
      },
    };
  };
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    register,
  );
  assert.deepEqual(calls, [
    { title: "Stage board", kind: "image" },
    { title: "Walker", kind: "file" },
  ]);
  const data = pasted.nodes[0]!.data;
  // The still registers once through its preview; the pin follows that copy.
  assert.equal(data.src, "blob:target/Stage board");
  assert.equal(data.backendAssetId, "copy-Stage board");
  assert.equal(data.stillAsset?.assetId, "copy-Stage board");
  // The capture's bytes would register a duplicate in the target's first save.
  assert.equal(data.stillCapture, undefined);
  const walker = data.localStage!.objects.find(
    (object) => object.kind === "gltf",
  )!;
  assert.equal(walker.source, "blob:target/Walker");
  assert.equal(walker.asset?.assetId, "copy-Walker");
  // The clipboard original keeps the source project's identities.
  assert.equal(node.data.stillAsset?.assetId, "still-1");
  assert.equal(node.data.stillCapture, "data:image/png;base64,aVBoTgc=");
  assert.equal(
    stage.objects.find((object) => object.kind === "gltf")!.source,
    "data:application/octet-stream;base64,R0xGQg==",
  );
});

test("cross-project pastes fail when a stage pin has no reachable bytes", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      ...createLocalStage().objects,
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  const node = createNode("external", { x: 0, y: 0 }, {
    title: "Stage board",
    localStage: stage,
    stillAsset: stillRef,
  });
  const fragment: CanvasFragment = { nodes: [node], edges: [] };
  const media = captureClipboardMedia("project-a", fragment, {
    read: async () => new Blob(["x"]),
  });
  await assert.rejects(
    transferClipboardMedia(fragment, media, "project-b", async () => {
      throw Error("unreachable");
    }),
    /已失效/,
  );
});

test("an unreadable still pin falls back to the carried capture bytes", async () => {
  const node = createNode("external", { x: 0, y: 0 }, {
    title: "Stage board",
    localStage: createLocalStage(),
    stillAsset: stillRef,
    stillCapture: "data:image/png;base64,aVBoTgc=",
  });
  const fragment: CanvasFragment = { nodes: [node], edges: [] };
  const media = captureClipboardMedia("project-a", fragment, {
    read: async () => {
      throw Error("no preview to read");
    },
  });
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    async () => {
      throw Error("unreachable");
    },
  );
  const data = pasted.nodes[0]!.data;
  // The stale source-project pin is dropped; the target's save registers the
  // capture bytes the paste still carries.
  assert.equal(data.stillAsset, undefined);
  assert.equal(data.stillCapture, "data:image/png;base64,aVBoTgc=");
});

const archiveRead = async (src: string) =>
  new Blob([Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))], {
    type: /^data:([^;]+)/.exec(src)![1],
  });

test("canvas archives bundle stage models and re-home stage pins", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      ...createLocalStage().objects,
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        source: "data:application/octet-stream;base64,R0xGQg==",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  const document = createDocument("With stage");
  document.nodes = [
    createNode("external", { x: 0, y: 0 }, {
      title: "Stage board",
      localStage: stage,
      src: "data:image/png;base64,aVBoTgc=",
      stillAsset: stillRef,
    }),
  ];
  const archive = await buildCanvasArchive(document, { read: archiveRead });
  assert.deepEqual(archive.assets, [
    "assets/Stage_board.png",
    "assets/Walker",
  ]);
  const files = await readZip(archive.blob);
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get("manifest.json")!),
  );
  assert.equal(manifest.formatVersion, 4);

  const contents = await readCanvasArchive(archive.blob);
  assert.equal(contents.assets, 2);
  const data = contents.document.nodes[0]!.data;
  // The restored bytes become the capture the importing project's save
  // registers; the exporting project's pins cannot survive the trip.
  assert.equal(data.stillAsset, undefined);
  assert.match(data.stillCapture!, /^data:image\/png;base64,/);
  const walker = data.localStage!.objects.find(
    (object) => object.kind === "gltf",
  )!;
  assert.match(walker.source!, /^data:application\/octet-stream;base64,/);
  assert.equal(walker.asset, undefined);
});

test("canvas archives refuse stage pins whose bytes are unreachable", async () => {
  const stage = parseLocalStageValue({
    ...createLocalStage(),
    objects: [
      ...createLocalStage().objects,
      {
        ...createLocalStage().objects[0]!,
        id: "walker",
        kind: "gltf",
        name: "Walker",
        role: "character",
        format: "glb",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  const document = createDocument("With stage");
  document.nodes = [
    createNode("external", { x: 0, y: 0 }, {
      title: "Stage board",
      localStage: stage,
      stillAsset: stillRef,
    }),
  ];
  await assert.rejects(
    buildCanvasArchive(document, { read: archiveRead }),
    /舞台素材/,
  );
});

test("committed still captures are cleared instead of re-registering later", async () => {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const snapshot: ProjectSnapshot = {
    ...source,
    canvasItems: [],
    generationSpecs: [],
    references: [],
    editorDocuments: [],
    jobs: [],
    results: [],
  };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.assetForSource = () => undefined;
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  client.batch = async () => undefined;
  const importedImages: string[] = [];
  client.importBlob = async (_blob, name, kind) => {
    importedImages.push(`${kind}:${name}`);
    return {
      assetId: `still-${importedImages.length}`,
      revision: 1,
      fingerprint: `sha256:${importedImages.length}`,
      kind,
    };
  };
  const document = createDocument("Stage project");
  document.id = client.id;
  const node = createNode("external", { x: 0, y: 0 }, {
    title: "Stage board",
    localStage: createLocalStage(),
    stillCapture: "data:image/png;base64,aVBoTgc=",
  });
  document.nodes = [node];
  const projection = new CreationProjection(client);
  projection.baseline = await projection.read();
  projection.basis = snapshot;
  await projection.save(document);
  assert.deepEqual(importedImages, ["image:Stage board.png"]);
  // The spent capture leaves the saved document, which aliases the live one.
  assert.equal(node.data.stillCapture, undefined);

  // A reopened session has neither the projection's import cache nor its
  // dedupe: a surviving capture would register a duplicate still here.
  const reopened = new CreationProjection(client);
  reopened.baseline = await reopened.read();
  reopened.basis = client.snapshot;
  await reopened.save(document);
  assert.deepEqual(importedImages, ["image:Stage board.png"]);
});
