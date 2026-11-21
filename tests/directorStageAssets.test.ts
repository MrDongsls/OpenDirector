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
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import type { AssetRef } from "../src/contracts/generated.ts";

const asset = {
  assetId: "asset-gltf",
  revision: 2,
  fingerprint: `sha256:${"a".repeat(64)}`,
  kind: "file" as const,
};
const thumbnailAsset = {
  assetId: "asset-thumbnail",
  revision: 1,
  fingerprint: `sha256:${"b".repeat(64)}`,
  kind: "image" as const,
};

test("stage object thumbnails accept nullable projections and retain image asset identity", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const projected = parseLocalStageValue({
    ...stage,
    objects: [{ ...person, thumbnailAsset: null }],
  });
  assert.equal(projected.objects[0]!.thumbnailAsset, undefined);

  const pinned = parseLocalStageValue({
    ...stage,
    objects: [{ ...person, thumbnailAsset }],
  });
  assert.deepEqual(pinned.objects[0]!.thumbnailAsset, thumbnailAsset);
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(pinned))).objects[0]!
      .thumbnailAsset,
    thumbnailAsset,
  );
});

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
    { format: "glb", external: false },
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
    { format: "glb", external: true },
  );
  assert.deepEqual(
    probeStageAsset(gltf({ asset: { version: "2.0" } })),
    { format: "gltf", external: false },
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
});

/** The projection's save path for a director node, isolated from canvas state. */
function directorWrite(node: {
  id: string;
  title?: string;
  localStage?: unknown;
  stills?: { asset?: AssetRef; src?: string; capture?: string }[];
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
      // Distinct per import so fingerprint-based dedupe stays honest.
      fingerprint: `sha256:${String(imported.length).padStart(64, "0")}`,
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
          stills: node.stills,
        },
      },
      "director",
    ),
  };
}

test("director saves materialize object thumbnail captures as image assets", async () => {
  const base = createLocalStage();
  const stage = parseLocalStageValue({
    ...base,
    objects: [
      {
        ...base.objects[0]!,
        thumbnailCapture: "data:image/png;base64,aVBoTkc=",
      },
    ],
  });
  const write = directorWrite({
    id: "director-node",
    title: "Stage board",
    localStage: stage,
  });
  const document = await write.document;
  const data = document.data as unknown as { objects: readonly unknown[] };
  const object = data.objects[0] as {
    thumbnailAsset?: { assetId: string; kind: string };
    thumbnailCapture?: string;
  };
  assert.deepEqual(object.thumbnailAsset, {
    assetId: "imported-1",
    revision: 1,
    fingerprint: `sha256:${"1".padStart(64, "0")}`,
    kind: "image",
  });
  assert.equal(object.thumbnailCapture, undefined);
  assert.deepEqual(write.imported, [
    { name: "Stage board-人物 1-thumbnail.png", kind: "image" },
  ]);
});
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
    stills: [
      { capture: "data:image/png;base64,aVBoTkc=" },
      { capture: "data:image/png;base64,aVBoTkc1" },
    ],
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
  // Captures import in list order so the drawer keeps its sequence.
  assert.deepEqual(
    (document.data.stills as { assetId: string }[]).map(
      (still) => still.assetId,
    ),
    ["imported-2", "imported-3"],
  );
  assert.deepEqual(write.imported, [
    { name: stageUploadTitle("Walker", "glb"), kind: "file" },
    { name: "Stage board.png", kind: "image" },
    { name: "Stage board.png", kind: "image" },
  ]);
});

test("director saves keep pinned stills and import only fresh captures", async () => {
  const still = {
    assetId: "still-1",
    revision: 1,
    fingerprint: `sha256:${"e".repeat(64)}`,
    kind: "image" as const,
  };
  const write = directorWrite({
    id: "director-node",
    title: "Stage board",
    localStage: createLocalStage(),
    stills: [
      { asset: still, src: "blob:preview" },
      { capture: "data:image/png;base64,aVBoTkc=" },
    ],
  });
  const document = await write.document;
  // View-only media URLs stay out of the contract; the pinned identity and
  // the fresh capture keep their drawer order.
  assert.deepEqual(document.data.stills, [
    still,
    { assetId: "imported-1", revision: 1, fingerprint: `sha256:${"1".padStart(64, "0")}`, kind: "image" },
  ]);
  assert.deepEqual(write.imported, [{ name: "Stage board.png", kind: "image" }]);
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

test("byte-identical captures pin one asset, not duplicates", async () => {
  const still = {
    assetId: "still-1",
    revision: 1,
    fingerprint: `sha256:${"e".repeat(64)}`,
    kind: "image" as const,
  };
  const capture = "data:image/png;base64,aVBoTkc=";
  const write = directorWrite({
    id: "director-node",
    title: "Stage board",
    localStage: createLocalStage(),
    stills: [
      { asset: still },
      { capture },
      // A second capture of the same frame produces the same bytes.
      { capture },
    ],
  });
  const document = await write.document;
  assert.deepEqual(document.data.stills, [
    still,
    { assetId: "imported-1", revision: 1, fingerprint: `sha256:${"1".padStart(64, "0")}`, kind: "image" },
  ]);
  assert.deepEqual(write.imported, [{ name: "Stage board.png", kind: "image" }]);
});
