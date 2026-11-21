import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";
import { parseStageMotion, type StageMotion } from "./stageMotion.ts";
import type { AssetRef } from "../contracts/generated.ts";

/** Local previsualization format. V1 is migrated here, never in consumers. */
export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}
export interface StageTransform {
  position: Vector3Value;
  rotation: Vector3Value;
  scale: Vector3Value;
}
export interface StageTransformFrame {
  id: string;
  time: number;
  value: StageTransform;
}
export interface StageMotionClip {
  id: string;
  start: number;
  duration: number;
  motion: StageMotion;
}
export type StageAssetRole = "character" | "scene";
export type StageAssetFormat = "glb" | "gltf";
export interface StageObject extends StageTransform {
  id: string;
  kind:
    | "person"
    | "box"
    | "sphere"
    | "gltf"
    | "cylinder"
    | "cone"
    | "pyramid"
    | "torus"
    | "plane"
    | "capsule"
    | "disk"
    | "arc"
    | "halfCylinder";
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  keyframes: StageTransformFrame[];
  motionClips: StageMotionClip[];
  /** Registered asset identity. Omitted only while a local import is unsaved. */
  asset?: AssetRef;
  /** Browser URL used to reconstruct a preview; never sent to the backend. */
  source?: string;
  /** Registered PNG asset for the object-card thumbnail. */
  thumbnailAsset?: AssetRef;
  /** Unsaved PNG bytes; the backend turns these into thumbnailAsset on apply. */
  thumbnailCapture?: string;
  /** Browser URL projected from thumbnailAsset; never sent to the backend. */
  thumbnailSource?: string;
  role?: StageAssetRole;
  format?: StageAssetFormat;
  animationNames?: string[];
  hasAnimation?: boolean;
}
export interface StageCamera {
  position: Vector3Value;
  target: Vector3Value;
  fov: number;
  /** Roll around the view axis in radians; 0 is level. */
  roll?: number;
}
export type StageCameraEndpointKind = "camera" | "viewpoint";
export interface StageCameraEndpoint {
  /** Stable presentation identity derived from the owning camera rig. */
  id: string;
  cameraId: string;
  kind: StageCameraEndpointKind;
  position: Vector3Value;
}
export interface StageCameraVectorFrame {
  id: string;
  time: number;
  value: Vector3Value;
}
export interface StageCameraNumberFrame {
  id: string;
  time: number;
  value: number;
}
export interface StageCameraChannels {
  position: StageCameraVectorFrame[];
  target: StageCameraVectorFrame[];
  up: StageCameraVectorFrame[];
  focalLength: StageCameraNumberFrame[];
}
export interface StageCameraRig {
  id: string;
  name: string;
  aspectRatio?: (typeof STAGE_RATIOS)[number];
  pose: StageCamera;
  /** Independent authoritative channels; keyframes remains a compatibility projection. */
  channels?: StageCameraChannels;
  keyframes: { id: string; time: number; value: StageCamera }[];
}
export interface StageShot {
  id: string;
  cameraId: string;
  start: number;
  duration: number;
}
export type StageEnvironmentPreset = "studio" | "warm-sunset" | "moonlit";
export interface StageEnvironment {
  preset: StageEnvironmentPreset;
  groundColor: string;
  groundVisible: boolean;
  exposure: number;
  backgroundAsset: AssetRef | null;
}
export type StageLightId = "hemisphere" | "key" | "fill";
export interface StageLight {
  id: StageLightId;
  color: string;
  intensity: number;
  position: Vector3Value;
  castShadow: boolean;
}
export const STAGE_RATIOS = [
  "16:9",
  "2.39:1",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
] as const;
export const STAGE_FPS = [24, 25, 30, 50, 60] as const;
const isStageFps = (value: unknown): value is LocalStageDocument["fps"] =>
  STAGE_FPS.some((fps) => fps === value);
function hasExternalGltfResources(value: unknown) {
  if (!value || typeof value !== "object") return true;
  const document = value as {
    buffers?: unknown;
    images?: unknown;
  };
  return [document.buffers, document.images].some(
    (resources) =>
      Array.isArray(resources) &&
      resources.some(
        (resource) =>
          resource &&
          typeof resource === "object" &&
          "uri" in resource &&
          typeof resource.uri === "string" &&
          !resource.uri.startsWith("data:"),
      ),
  );
}
const isGltfDocument = (value: unknown) => {
  const asset = (value as { asset?: unknown })?.asset;
  return (
    !!value &&
    typeof value === "object" &&
    !!asset &&
    typeof asset === "object" &&
    "version" in asset
  );
};
export interface StageAssetProbe {
  format: StageAssetFormat;
  /** Whether the parsed document references external buffers or images. */
  external: boolean;
}
/**
 * Container and self-containment come from the actual bytes, matching the
 * backend probe. Returns "corrupt" when a GLB header is valid but its
 * embedded JSON chunk is missing, unparsable, or not a glTF document, and
 * undefined when the bytes are no stage model at all.
 */
export function probeStageAsset(
  buffer: ArrayBuffer,
): StageAssetProbe | "corrupt" | undefined {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const glbVersion = () => view.getUint32(4, true);
  const declaredLength = () => view.getUint32(8, true);
  const isGlbMagic =
    bytes.length >= 4 &&
    bytes[0] === 0x67 &&
    bytes[1] === 0x6c &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x46;
  const isGlb =
    bytes.length >= 12 &&
    isGlbMagic &&
    glbVersion() === 2 &&
    declaredLength() >= 12 &&
    declaredLength() <= bytes.length;
  if (isGlbMagic && !isGlb) return undefined;
  if (isGlb) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, true);
      if (view.getUint32(offset + 4, true) === 0x4e4f534a) {
        try {
          const document: unknown = JSON.parse(
            new TextDecoder().decode(
              bytes.subarray(offset + 8, offset + 8 + length),
            ),
          );
          if (!isGltfDocument(document)) return "corrupt";
          return {
            format: "glb",
            external: hasExternalGltfResources(document),
          };
        } catch {
          return "corrupt";
        }
      }
      offset += 8 + length;
    }
    return "corrupt";
  }
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isGltfDocument(document)) return undefined;
    return {
      format: "gltf",
      external: hasExternalGltfResources(document),
    };
  } catch {
    return undefined;
  }
}
export interface LocalStageDocument {
  format: "opendirector-local-stage";
  version: 2;
  background: string;
  grid: boolean;
  duration: number;
  fps: (typeof STAGE_FPS)[number];
  aspectRatio: (typeof STAGE_RATIOS)[number];
  cameras: StageCameraRig[];
  activeCameraId: string;
  cameraSource: "camera" | "storyboard";
  shots: StageShot[];
  objects: StageObject[];
  environment: StageEnvironment;
  lights: StageLight[];
}
export interface StageSampleObject extends StageObject {
  motion?: StageMotion;
  motionTime: number;
}
export interface StageSample {
  camera: StageCamera;
  cameraId: string;
  objects: StageSampleObject[];
}
export const STAGE_ASSET_MAX_BYTES = 100 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const vector = (v: unknown): v is Vector3Value =>
  record(v) && finite(v.x) && finite(v.y) && finite(v.z);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim();
const color = (v: unknown): v is string =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const stageLightIds = ["hemisphere", "key", "fill"] as const;
const defaultStageEnvironment = (): StageEnvironment => ({
  preset: "studio",
  groundColor: "#181818",
  groundVisible: true,
  exposure: 1,
  backgroundAsset: null,
});
const defaultStageLights = (): StageLight[] => [
  { id: "hemisphere", color: "#ffffff", intensity: 2.4, position: { x: 0, y: 1, z: 0 }, castShadow: false },
  { id: "key", color: "#ffffff", intensity: 3.5, position: { x: 5, y: 10, z: 6 }, castShadow: true },
  { id: "fill", color: "#ffffff", intensity: 1.6, position: { x: -6, y: 5, z: -5 }, castShadow: false },
];
const assetRef = (v: unknown): v is AssetRef =>
  record(v) &&
  nonempty(v.assetId) &&
  typeof v.revision === "number" &&
  Number.isInteger(v.revision) &&
  v.revision >= 1 &&
  typeof v.fingerprint === "string" &&
  /^sha256:[0-9a-f]{64}$/.test(v.fingerprint) &&
  v.kind === "file";
const imageAssetRef = (v: unknown): v is AssetRef =>
  record(v) &&
  nonempty(v.assetId) &&
  typeof v.revision === "number" &&
  Number.isInteger(v.revision) &&
  v.revision >= 1 &&
  typeof v.fingerprint === "string" &&
  /^sha256:[0-9a-f]{64}$/.test(v.fingerprint) &&
  v.kind === "image";
const imageDataUrl = (v: unknown): v is string =>
  typeof v === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v);
const sameVector = (a: Vector3Value, b: Vector3Value) =>
  a.x === b.x && a.y === b.y && a.z === b.z;
function parseTransform(
  v: unknown,
  t: Translate = defaultTranslate,
): StageTransform {
  if (
    !record(v) ||
    !vector(v.position) ||
    !vector(v.rotation) ||
    !vector(v.scale) ||
    v.scale.x <= 0 ||
    v.scale.y <= 0 ||
    v.scale.z <= 0
  )
    throw new Error(t("editors.stage.error.invalidTransform"));
  return {
    position: { ...v.position },
    rotation: { ...v.rotation },
    scale: { ...v.scale },
  };
}
function parseCamera(
  v: unknown,
  t: Translate = defaultTranslate,
): StageCamera {
  if (
    !record(v) ||
    !vector(v.position) ||
    !vector(v.target) ||
    !finite(v.fov) ||
    v.fov <= 0 ||
    v.fov >= 180 ||
    sameVector(v.position, v.target) ||
    (v.roll !== undefined &&
      (!finite(v.roll) || Math.abs(v.roll) > Math.PI))
  )
    throw new Error(t("editors.stage.error.invalidCamera"));
  return {
    position: { ...v.position },
    target: { ...v.target },
    fov: v.fov,
    ...(v.roll !== undefined && v.roll !== 0 ? { roll: v.roll } : {}),
  };
}
const defaultCameraUp = (): Vector3Value => ({ x: 0, y: 1, z: 0 });
const cameraFocalLength = (camera: StageCamera) => camera.fov;
function cameraChannelsFromKeyframes(
  keyframes: { id: string; time: number; value: StageCamera }[],
): StageCameraChannels {
  return {
    position: keyframes.map(({ id, time, value }) => ({ id, time, value: { ...value.position } })),
    target: keyframes.map(({ id, time, value }) => ({ id, time, value: { ...value.target } })),
    up: keyframes.map(({ id, time }) => ({ id, time, value: defaultCameraUp() })),
    focalLength: keyframes.map(({ id, time, value }) => ({ id, time, value: cameraFocalLength(value) })),
  };
}
function cameraChannelsOf(camera: StageCameraRig): StageCameraChannels {
  return camera.channels ?? cameraChannelsFromKeyframes(camera.keyframes);
}
function parseCameraChannels(
  raw: unknown,
  legacy: { id: string; time: number; value: StageCamera }[],
  duration: number,
  t: Translate,
): StageCameraChannels {
  if (raw === undefined) return cameraChannelsFromKeyframes(legacy);
  if (!record(raw)) throw new Error(t("editors.stage.error.invalidCamera"));
  const position = frames(raw.position, duration, (v) => {
    if (!vector(v)) throw new Error(t("editors.stage.error.invalidCamera"));
    return { ...v };
  }, t);
  const target = frames(raw.target, duration, (v) => {
    if (!vector(v)) throw new Error(t("editors.stage.error.invalidCamera"));
    return { ...v };
  }, t);
  const up = frames(raw.up, duration, (v) => {
    if (!vector(v)) throw new Error(t("editors.stage.error.invalidCamera"));
    return { ...v };
  }, t);
  const focalLength = frames(raw.focalLength, duration, (v) => {
    if (!finite(v) || v <= 0) throw new Error(t("editors.stage.error.invalidCamera"));
    return v;
  }, t);
  return { position, target, up, focalLength };
}
function channelAt<T>(base: T, frames: { time: number; value: T }[], time: number, mix: (a: T, b: T, amount: number) => T): T {
  if (!frames.length) return base;
  const left = [...frames].reverse().find((f) => f.time <= time) ?? frames[0]!;
  const right = frames.find((f) => f.time >= time) ?? frames.at(-1)!;
  return mix(left.value, right.value, left.time === right.time ? 0 : (time - left.time) / (right.time - left.time));
}
function cameraKeyframesFromChannels(
  pose: StageCamera,
  channels: StageCameraChannels,
): { id: string; time: number; value: StageCamera }[] {
  const times = [...new Set([
    ...channels.position.map((f) => f.time),
    ...channels.target.map((f) => f.time),
    ...channels.up.map((f) => f.time),
    ...channels.focalLength.map((f) => f.time),
  ])].sort((a, b) => a - b);
  return times.map((time, index) => ({
    id: channels.position.find((f) => f.time === time)?.id ?? `camera-channel-${index}`,
    time,
    value: {
      position: channelAt(pose.position, channels.position, time, mixVector),
      target: channelAt(pose.target, channels.target, time, mixVector),
      fov: channelAt(pose.fov, channels.focalLength, time, lerp),
      ...(pose.roll ? { roll: pose.roll } : {}),
    },
  }));
}
function withCameraChannels(
  camera: StageCameraRig,
  channels: StageCameraChannels,
): StageCameraRig {
  return {
    ...camera,
    channels,
    // Keep the legacy projection synchronized for existing UI and API readers
    // while the independent channels become authoritative.
    keyframes: cameraKeyframesFromChannels(camera.pose, channels),
  };
}
export function defaultStageCamera(): StageCamera {
  return {
    position: { x: 5, y: 3.5, z: 7 },
    target: { x: 0, y: 1, z: 0 },
    fov: 45,
  };
}
export function createLocalStage(
  t: Translate = defaultTranslate,
): LocalStageDocument {
  return {
    format: "opendirector-local-stage",
    version: 2,
    background: "#151923",
    grid: true,
    duration: 6,
    fps: 30,
    aspectRatio: "16:9",
    cameras: [
      {
        id: "camera-1",
        name: t("editors.stage.defaultCameraName"),
        aspectRatio: "16:9",
        pose: defaultStageCamera(),
        channels: cameraChannelsFromKeyframes([]),
        keyframes: [],
      },
    ],
    activeCameraId: "camera-1",
    cameraSource: "camera",
    shots: [],
    objects: [
      {
        id: crypto.randomUUID(),
        kind: "person",
        name: t("editors.stage.defaultPersonName"),
        color: "#a09af9",
        visible: true,
        locked: false,
        opacity: 1,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        keyframes: [],
        motionClips: [],
      },
    ],
    environment: defaultStageEnvironment(),
    lights: defaultStageLights(),
  };
}
function frames<T>(
  raw: unknown,
  duration: number,
  parse: (v: unknown) => T,
  t: Translate = defaultTranslate,
): { id: string; time: number; value: T }[] {
  if (!Array.isArray(raw))
    throw new Error(t("editors.stage.error.invalidKeyframes"));
  const ids = new Set<string>(),
    times = new Set<number>();
  return raw
    .map((v) => {
      if (
        !record(v) ||
        !nonempty(v.id) ||
        ids.has(v.id) ||
        !finite(v.time) ||
        v.time < 0 ||
        v.time > duration ||
        times.has(v.time)
      )
        throw new Error(t("editors.stage.error.invalidKeyframeTime"));
      ids.add(v.id);
      times.add(v.time);
      return { id: v.id, time: v.time, value: parse(v.value) };
    })
    .sort((a, b) => a.time - b.time);
}
function intervals<T extends { id: string; start: number; duration: number }>(
  items: T[],
  duration: number,
  label: string,
  t: Translate = defaultTranslate,
): T[] {
  const ids = new Set<string>();
  const sorted = items.sort((a, b) => a.start - b.start);
  for (const [i, v] of sorted.entries()) {
    if (
      !nonempty(v.id) ||
      ids.has(v.id) ||
      !finite(v.start) ||
      !finite(v.duration) ||
      v.start < 0 ||
      v.duration <= 0 ||
      v.start + v.duration > duration + 1e-8
    )
      throw new Error(t("editors.stage.error.intervalInvalid", { label }));
    if (i && sorted[i - 1]!.start + sorted[i - 1]!.duration > v.start + 1e-8)
      throw new Error(t("editors.stage.error.intervalOverlap", { label }));
    ids.add(v.id);
  }
  return sorted;
}
function migrateV1(
  v: Record<string, unknown>,
  t: Translate = defaultTranslate,
): Record<string, unknown> {
  if (
    !Array.isArray(v.objects) ||
    !Array.isArray(v.keyframes) ||
    !finite(v.duration)
  )
    throw new Error(t("editors.stage.error.invalidLegacy"));
  const objectIds = new Set(
    v.objects.map((o) => (record(o) ? o.id : undefined)),
  );
  const legacy = frames(
    v.keyframes.map((f) => (record(f) ? { ...f, value: f } : f)),
    v.duration,
    (f) => {
      if (!record(f) || !Array.isArray(f.objects))
        throw new Error(t("editors.stage.error.invalidLegacyKeyframe"));
      const ids = new Set();
      return {
        camera: parseCamera(f.camera, t),
        objects: f.objects.map((o) => {
          if (!record(o) || !objectIds.has(o.id) || ids.has(o.id))
            throw new Error(t("editors.stage.error.missingObject"));
          ids.add(o.id);
          return { id: o.id, transform: parseTransform(o.transform, t) };
        }),
      };
    },
    t,
  );
  return {
    ...v,
    version: 2,
    aspectRatio: "16:9",
    fps: 30,
    activeCameraId: "camera-1",
    cameraSource: "camera",
    shots: [],
    environment: defaultStageEnvironment(),
    lights: defaultStageLights(),
    cameras: [
      {
        id: "camera-1",
        name: t("editors.stage.defaultCameraName"),
        pose: parseCamera(v.camera, t),
        keyframes: legacy.map((f) => ({
          id: f.id,
          time: f.time,
          value: f.value.camera,
        })),
      },
    ],
    objects: v.objects.map((o) => {
      if (!record(o))
        throw new Error(t("editors.stage.error.invalidLegacyObject"));
      if (o.motion !== undefined && o.kind !== "person")
        throw new Error(t("editors.stage.error.jointMotionPerson"));
      return {
        ...o,
        keyframes: legacy.map((f) => ({
          id: f.id,
          time: f.time,
          value:
            f.value.objects.find((item) => item.id === o.id)?.transform ??
            parseTransform(o, t),
        })),
        motionClips:
          o.motion === undefined
            ? []
            : [
                {
                  id: `legacy-${String(o.id)}`,
                  start: 0,
                  duration: v.duration,
                  motion: o.motion,
                },
              ],
      };
    }),
  };
}
export function parseLocalStageValue(
  input: unknown,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  let v = input;
  if (record(v) && v.format === "opendirector-local-stage" && v.version === 1)
    v = migrateV1(v, t);
  if (
    record(v) &&
    v.format === "opendirector-local-stage" &&
    v.version === 2 &&
    v.fps === undefined
  )
    v = { ...v, fps: 30 };
  if (record(v) && v.format === "opendirector-local-stage" && v.version === 2) {
    v = {
      ...v,
      environment: record(v.environment)
        ? { ...defaultStageEnvironment(), ...v.environment }
        : defaultStageEnvironment(),
      lights: v.lights ?? defaultStageLights(),
    };
  }
  if (
    !record(v) ||
    v.format !== "opendirector-local-stage" ||
    v.version !== 2 ||
    !color(v.background) ||
    typeof v.grid !== "boolean" ||
    !finite(v.duration) ||
    v.duration <= 0 ||
    !isStageFps(v.fps) ||
    !Array.isArray(v.objects) ||
    !Array.isArray(v.cameras) ||
    !Array.isArray(v.shots) ||
    !STAGE_RATIOS.includes(
      v.aspectRatio as LocalStageDocument["aspectRatio"],
    ) ||
    !["camera", "storyboard"].includes(String(v.cameraSource))
  )
    throw new Error(t("editors.stage.error.invalidDocument"));
  const environment = record(v.environment) &&
    ["studio", "warm-sunset", "moonlit"].includes(String(v.environment.preset)) &&
    color(v.environment.groundColor) &&
    typeof v.environment.groundVisible === "boolean" &&
    finite(v.environment.exposure) &&
    v.environment.exposure >= 0 && v.environment.exposure <= 4 &&
    (v.environment.backgroundAsset === null || imageAssetRef(v.environment.backgroundAsset))
    ? {
        preset: v.environment.preset as StageEnvironmentPreset,
        groundColor: v.environment.groundColor,
        groundVisible: v.environment.groundVisible,
        exposure: v.environment.exposure,
        backgroundAsset: v.environment.backgroundAsset as AssetRef | null,
      }
      : (() => { throw new Error(t("editors.stage.error.invalidDocument")); })();
  if (!Array.isArray(v.lights) || v.lights.length !== 3)
    throw new Error(t("editors.stage.error.invalidDocument"));
  const lightIds = new Set<string>();
  const lights: StageLight[] = v.lights.map((raw) => {
    if (!record(raw) || !stageLightIds.includes(raw.id as StageLightId) || lightIds.has(String(raw.id)) ||
        !color(raw.color) || !finite(raw.intensity) || raw.intensity < 0 || raw.intensity > 10 ||
        !vector(raw.position) || typeof raw.castShadow !== "boolean" ||
        (raw.id === "hemisphere" && raw.castShadow))
      throw new Error(t("editors.stage.error.invalidDocument"));
    lightIds.add(String(raw.id));
    return {
      id: raw.id as StageLightId,
      color: raw.color,
      intensity: raw.intensity,
      position: { ...raw.position },
      castShadow: raw.castShadow,
    };
  });
  if (lightIds.size !== 3) throw new Error(t("editors.stage.error.invalidDocument"));
  const duration = v.duration,
    ids = new Set<string>(),
    cameraIds = new Set<string>();
  const objects: StageObject[] = v.objects.map((o) => {
    const rawObject = record(o) ? o : undefined;
    const imported = rawObject?.kind === "gltf";
    const importedAsset =
      imported && assetRef(rawObject?.asset) ? rawObject.asset : undefined;
    const importedSource =
      imported && typeof rawObject?.source === "string" && rawObject.source.trim()
        ? rawObject.source
        : undefined;
    const thumbnailAsset =
      rawObject && imageAssetRef(rawObject.thumbnailAsset)
        ? rawObject.thumbnailAsset
        : undefined;
    const thumbnailCapture = imageDataUrl(rawObject?.thumbnailCapture)
      ? rawObject.thumbnailCapture
      : undefined;
    const thumbnailSource = nonempty(rawObject?.thumbnailSource)
      ? rawObject.thumbnailSource
      : undefined;
    const animationNames =
      imported && Array.isArray(rawObject?.animationNames)
        ? rawObject.animationNames.filter((name): name is string => nonempty(name))
        : [];
    if (
      !record(o) ||
      !nonempty(o.id) ||
      ids.has(o.id) ||
      ![
            "person",
            "box",
            "sphere",
            "gltf",
            "cylinder",
            "cone",
            "pyramid",
            "torus",
            "plane",
            "capsule",
            "disk",
            "arc",
            "halfCylinder",
          ].includes(String(o.kind)) ||
      typeof o.name !== "string" ||
      !color(o.color) ||
      (o.visible !== undefined && typeof o.visible !== "boolean") ||
      (o.locked !== undefined && typeof o.locked !== "boolean") ||
      (o.opacity !== undefined && (!finite(o.opacity) || o.opacity < 0 || o.opacity > 1)) ||
      !Array.isArray(o.motionClips) ||
      (rawObject?.thumbnailAsset != null && !thumbnailAsset) ||
      (rawObject?.thumbnailCapture != null && !thumbnailCapture) ||
      (rawObject?.thumbnailSource != null && !thumbnailSource) ||
      (imported &&
        ((!importedAsset && !importedSource) ||
          !["character", "scene"].includes(String(rawObject?.role)) ||
          !["glb", "gltf"].includes(String(rawObject?.format)) ||
          !Array.isArray(rawObject?.animationNames) ||
          animationNames.length !== rawObject?.animationNames.length ||
          typeof rawObject?.hasAnimation !== "boolean" ||
          rawObject.hasAnimation !== Boolean(animationNames.length)))
    )
      throw new Error(t("editors.stage.error.invalidObject"));
    ids.add(o.id);
    if (o.kind !== "person" && o.kind !== "gltf" && o.motionClips.length)
      throw new Error(t("editors.stage.error.jointMotionPerson"));
    if (imported && o.role === "scene" && o.motionClips.length)
      throw new Error(t("editors.stage.error.importedSceneMotion"));
    if (imported && !o.hasAnimation && o.motionClips.length)
      throw new Error(t("editors.stage.error.importedMotionUnavailable"));
    return {
      id: o.id,
      kind: o.kind as StageObject["kind"],
      name: o.name,
      color: o.color,
      visible: o.visible ?? true,
      locked: o.locked ?? false,
      opacity: o.opacity ?? 1,
      ...parseTransform(o, t),
      keyframes: frames(o.keyframes, duration, (v) => parseTransform(v, t), t),
      motionClips: intervals(
        o.motionClips.map((c) => {
          if (!record(c))
            throw new Error(t("editors.stage.error.invalidMotionClip"));
          return {
            id: c.id as string,
            start: c.start as number,
            duration: c.duration as number,
            motion: parseStageMotion(c.motion),
          };
        }),
        duration,
        t("editors.stage.label.motionClip"),
        t,
      ),
      ...(importedAsset ? { asset: { ...importedAsset } } : {}),
      ...(importedSource ? { source: importedSource } : {}),
      ...(thumbnailAsset ? { thumbnailAsset: { ...thumbnailAsset } } : {}),
      ...(thumbnailCapture ? { thumbnailCapture } : {}),
      ...(thumbnailSource ? { thumbnailSource } : {}),
      ...(imported
        ? {
            role: o.role as StageAssetRole,
            format: o.format as StageAssetFormat,
            animationNames: [...animationNames],
            hasAnimation: o.hasAnimation as boolean,
          }
        : {}),
    };
  });
  const cameras: StageCameraRig[] = v.cameras.map((c) => {
    if (
      !record(c) ||
      !nonempty(c.id) ||
      cameraIds.has(c.id) ||
      typeof c.name !== "string"
    )
      throw new Error(t("editors.stage.error.invalidCameraId"));
    cameraIds.add(c.id);
    const pose = parseCamera(c.pose, t);
    const keyframes = frames(c.keyframes, duration, (v) => parseCamera(v, t), t);
    const channels = parseCameraChannels(c.channels, keyframes, duration, t);
    const aspectRatio = c.aspectRatio ?? v.aspectRatio;
    if (!STAGE_RATIOS.includes(aspectRatio as LocalStageDocument["aspectRatio"]))
      throw new Error(t("editors.stage.error.invalidCamera"));
    return {
      id: c.id,
      name: c.name,
      aspectRatio: aspectRatio as LocalStageDocument["aspectRatio"],
      pose,
      channels,
      keyframes: c.channels === undefined ? keyframes : cameraKeyframesFromChannels(pose, channels),
    };
  });
  if (!cameras.length || !cameraIds.has(v.activeCameraId as string))
    throw new Error(t("editors.stage.error.cameraRequired"));
  const shots = intervals(
    v.shots.map((s) => {
      if (!record(s) || !cameraIds.has(s.cameraId as string))
        throw new Error(t("editors.stage.error.shotCamera"));
      return {
        id: s.id as string,
        cameraId: s.cameraId as string,
        start: s.start as number,
        duration: s.duration as number,
      };
    }),
    duration,
    t("editors.stage.label.shot"),
    t,
  );
  return {
    format: "opendirector-local-stage",
    version: 2,
    background: v.background,
    grid: v.grid,
    duration,
    fps: v.fps,
    aspectRatio: v.aspectRatio as LocalStageDocument["aspectRatio"],
    activeCameraId: v.activeCameraId as string,
    cameraSource: v.cameraSource as LocalStageDocument["cameraSource"],
    objects,
    cameras,
    shots,
    environment,
    lights,
  };
}
/** Gesture values round-trip through the renderer's spherical camera math,
 * so an unchanged pose can still differ by float noise; an edit comparison
 * must treat that as unchanged while parseCamera keeps exact validation. */
const closeVector = (a: Vector3Value, b: Vector3Value) =>
  Math.abs(a.x - b.x) < 1e-9 &&
  Math.abs(a.y - b.y) < 1e-9 &&
  Math.abs(a.z - b.z) < 1e-9;
const sameTransform = (a: StageTransform, b: StageTransform) =>
  closeVector(a.position, b.position) &&
  closeVector(a.rotation, b.rotation) &&
  closeVector(a.scale, b.scale);
const sameCamera = (a: StageCamera, b: StageCamera) =>
  closeVector(a.position, b.position) &&
  closeVector(a.target, b.target) &&
  Math.abs(a.fov - b.fov) < 1e-9 &&
  (a.roll ?? 0) === (b.roll ?? 0);
const sameCameraChannels = (a: StageCameraChannels, b: StageCameraChannels) =>
  sameFrames(a.position, b.position, sameVector) &&
  sameFrames(a.target, b.target, sameVector) &&
  sameFrames(a.up, b.up, sameVector) &&
  sameFrames(a.focalLength, b.focalLength, (x, y) => Math.abs(x - y) < 1e-9);
const sameAsset = (a: AssetRef | undefined, b: AssetRef | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.assetId === b.assetId &&
    a.revision === b.revision &&
    a.fingerprint === b.fingerprint &&
    a.kind === b.kind);
const sameFrames = <T>(
  a: { id: string; time: number; value: T }[],
  b: { id: string; time: number; value: T }[],
  same: (a: T, b: T) => boolean,
) =>
  a.length === b.length &&
  a.every(
    (f, i) =>
      f.id === b[i]!.id && f.time === b[i]!.time && same(f.value, b[i]!.value),
  );
export function sameLocalStage(
  a: LocalStageDocument | undefined,
  b: LocalStageDocument | undefined,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.background === b.background &&
      a.grid === b.grid &&
      a.duration === b.duration &&
      a.fps === b.fps &&
      a.aspectRatio === b.aspectRatio &&
      a.activeCameraId === b.activeCameraId &&
      a.cameraSource === b.cameraSource &&
      a.environment.preset === b.environment.preset &&
      a.environment.groundColor === b.environment.groundColor &&
      a.environment.groundVisible === b.environment.groundVisible &&
      a.environment.exposure === b.environment.exposure &&
      sameAsset(a.environment.backgroundAsset ?? undefined, b.environment.backgroundAsset ?? undefined) &&
      a.lights.length === b.lights.length &&
      a.lights.every((light, i) => {
        const other = b.lights[i]!;
        return light.id === other.id && light.color === other.color &&
          light.intensity === other.intensity && light.castShadow === other.castShadow &&
          sameVector(light.position, other.position);
      }) &&
      a.objects.length === b.objects.length &&
      a.objects.every((o, i) => {
        const p = b.objects[i]!;
        return (
          o.id === p.id &&
          o.name === p.name &&
          o.kind === p.kind &&
          o.color === p.color &&
          o.visible === p.visible &&
          o.locked === p.locked &&
          o.opacity === p.opacity &&
          sameAsset(o.asset, p.asset) &&
          o.role === p.role &&
          o.format === p.format &&
          o.hasAnimation === p.hasAnimation &&
          (o.animationNames ?? []).join("\u0000") ===
            (p.animationNames ?? []).join("\u0000") &&
          sameTransform(o, p) &&
          sameFrames(o.keyframes, p.keyframes, sameTransform) &&
          o.motionClips.length === p.motionClips.length &&
          o.motionClips.every((c, j) => {
            const d = p.motionClips[j]!;
            return (
              c.id === d.id &&
              c.start === d.start &&
              c.duration === d.duration &&
              c.motion.preset === d.motion.preset &&
              c.motion.amount === d.motion.amount &&
              c.motion.speed === d.motion.speed
            );
          })
        );
      }) &&
      a.cameras.length === b.cameras.length &&
      a.cameras.every((c, i) => {
        const d = b.cameras[i]!;
        return (
          c.id === d.id &&
          c.name === d.name &&
          (c.aspectRatio ?? a.aspectRatio) === (d.aspectRatio ?? b.aspectRatio) &&
          sameCamera(c.pose, d.pose) &&
          sameCameraChannels(cameraChannelsOf(c), cameraChannelsOf(d)) &&
          sameFrames(c.keyframes, d.keyframes, sameCamera)
        );
      }) &&
      a.shots.length === b.shots.length &&
      a.shots.every((s, i) => {
        const t = b.shots[i]!;
        return (
          s.id === t.id &&
          s.cameraId === t.cameraId &&
          s.start === t.start &&
          s.duration === t.duration
        );
      }))
  );
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixVector = (
  a: Vector3Value,
  b: Vector3Value,
  t: number,
): Vector3Value => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});
function sample<T>(
  base: T,
  frames: { time: number; value: T }[],
  time: number,
  mix: (a: T, b: T, t: number) => T,
): T {
  if (!frames.length) return base;
  const left = [...frames].reverse().find((f) => f.time <= time) ?? frames[0]!,
    right = frames.find((f) => f.time >= time) ?? frames.at(-1)!;
  return mix(
    left.value,
    right.value,
    left.time === right.time
      ? 0
      : (time - left.time) / (right.time - left.time),
  );
}
export function sampleStageCamera(
  stage: LocalStageDocument,
  id: string,
  time: number,
  t: Translate = defaultTranslate,
): StageCamera {
  const c = stage.cameras.find((c) => c.id === id);
  if (!c) throw new Error(t("editors.stage.error.cameraMissing"));
  const channels = cameraChannelsOf(c);
  return {
    position: channelAt(c.pose.position, channels.position, time, mixVector),
    target: channelAt(c.pose.target, channels.target, time, mixVector),
    fov: channelAt(c.pose.fov, channels.focalLength, time, lerp),
    ...(c.pose.roll ? { roll: c.pose.roll } : {}),
  };
}
export function stageCameraEndpointId(
  cameraId: string,
  kind: StageCameraEndpointKind,
): string {
  return `${cameraId}:${kind}`;
}
export function sampleStageCameraEndpoint(
  stage: LocalStageDocument,
  cameraId: string,
  kind: StageCameraEndpointKind,
  time: number,
  t: Translate = defaultTranslate,
): StageCameraEndpoint {
  const pose = sampleStageCamera(stage, cameraId, time, t);
  return {
    id: stageCameraEndpointId(cameraId, kind),
    cameraId,
    kind,
    position: kind === "camera" ? { ...pose.position } : { ...pose.target },
  };
}
export function editStageCameraEndpointAt(
  stage: LocalStageDocument,
  cameraId: string,
  kind: StageCameraEndpointKind,
  time: number,
  position: Vector3Value,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  return editStageCameraAt(
    stage,
    cameraId,
    time,
    kind === "camera" ? { position } : { target: position },
    t,
  );
}
/** Same global timeline and half-open cut boundaries for editor, screenshots and MP4. */
export function sampleStage(
  stage: LocalStageDocument,
  time: number,
): StageSample {
  const at = Math.max(0, Math.min(stage.duration, time));
  const shot =
    stage.cameraSource === "storyboard"
      ? stage.shots.find(
          (s) =>
            at >= s.start &&
            (at < s.start + s.duration ||
              (at === stage.duration && at === s.start + s.duration)),
        )
      : undefined;
  const cameraId = shot?.cameraId ?? stage.activeCameraId;
  return {
    cameraId,
    camera: sampleStageCamera(stage, cameraId, at),
    objects: stage.objects.map((o) => {
      const transform = sample<StageTransform>(
        o,
        o.keyframes,
        at,
        (a, b, t) => ({
          position: mixVector(a.position, b.position, t),
          rotation: mixVector(a.rotation, b.rotation, t),
          scale: mixVector(a.scale, b.scale, t),
        }),
      );
      const clip = o.motionClips.find(
        (c) =>
          at >= c.start &&
          (at < c.start + c.duration ||
            (at === stage.duration && at === c.start + c.duration)),
      );
      return {
        ...o,
        ...transform,
        motion: clip?.motion,
        motionTime: clip ? at - clip.start : 0,
      };
    }),
  };
}
const putFrame = <T>(
  frames: { id: string; time: number; value: T }[],
  time: number,
  value: T,
) =>
  [
    ...frames.filter((f) => f.time !== time),
    {
      id: frames.find((f) => f.time === time)?.id ?? crypto.randomUUID(),
      time,
      value,
    },
  ].sort((a, b) => a.time - b.time);
function authorFrame<T>(
  frames: { id: string; time: number; value: T }[],
  time: number,
  value: T,
  base: T,
) {
  // The first edit later in time must not retroactively replace the opening pose.
  return putFrame(
    !frames.length && time > 0 ? putFrame([], 0, base) : frames,
    time,
    value,
  );
}
export function editStageObjectAt(
  stage: LocalStageDocument,
  id: string,
  time: number,
  patch: Partial<StageObject>,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const pose = sampleStage(stage, time).objects.find((o) => o.id === id);
  if (!pose || pose.locked) return stage;
  const transform = parseTransform({ ...pose, ...patch }, t);
  const {
    position: _position,
    rotation: _rotation,
    scale: _scale,
    ...metadata
  } = patch;
  const changesTransform =
    !!(patch.position || patch.rotation || patch.scale) &&
    !sameTransform(pose, transform);
  return parseLocalStageValue(
    {
      ...stage,
      objects: stage.objects.map((o) =>
        o.id !== id
          ? o
          : {
              ...o,
              ...metadata,
              ...(changesTransform ? transform : {}),
              keyframes: changesTransform
                ? authorFrame(o.keyframes, time, transform, parseTransform(o, t))
                : o.keyframes,
            },
      ),
    },
    t,
  );
}
/** Placement writes the base transform only and never authors keyframes:
 * dragging repositions a static subject instead of animating it. */
export function editStageObjectPlacement(
  stage: LocalStageDocument,
  id: string,
  transform: StageTransform,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const value = parseTransform(transform, t);
  if (!stage.objects.some((o) => o.id === id && !o.locked)) return stage;
  return parseLocalStageValue(
    {
      ...stage,
      objects: stage.objects.map((o) => (o.id === id ? { ...o, ...value } : o)),
    },
    t,
  );
}
export function editStageCameraAt(
  stage: LocalStageDocument,
  id: string,
  time: number,
  patch: Partial<StageCamera>,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const current = sampleStageCamera(stage, id, time, t);
  const pose = parseCamera({ ...current, ...patch }, t);
  if (sameCamera(current, pose)) return stage;
  return parseLocalStageValue(
    {
      ...stage,
      cameras: stage.cameras.map((c) =>
        c.id !== id
          ? c
          : withCameraChannels(
              { ...c, pose },
              {
                position: sameVector(current.position, pose.position)
                  ? cameraChannelsOf(c).position
                  : authorFrame(cameraChannelsOf(c).position, time, pose.position, c.pose.position),
                target: sameVector(current.target, pose.target)
                  ? cameraChannelsOf(c).target
                  : authorFrame(cameraChannelsOf(c).target, time, pose.target, c.pose.target),
                up: cameraChannelsOf(c).up,
                focalLength: current.fov === pose.fov
                  ? cameraChannelsOf(c).focalLength
                  : authorFrame(cameraChannelsOf(c).focalLength, time, pose.fov, c.pose.fov),
              },
            ),
      ),
    },
    t,
  );
}
export function captureStageFrame(
  stage: LocalStageDocument,
  time: number,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const pose = sampleStage(stage, time);
  return parseLocalStageValue(
    {
      ...stage,
      objects: stage.objects.map((o) => ({
        ...o,
        keyframes: o.locked
          ? o.keyframes
          : putFrame(
              o.keyframes,
              time,
              parseTransform(pose.objects.find((p) => p.id === o.id)!, t),
            ),
      })),
      cameras: stage.cameras.map((c) =>
        c.id === pose.cameraId
          ? (() => {
              const channels = {
                position: putFrame(cameraChannelsOf(c).position, time, pose.camera.position),
                target: putFrame(cameraChannelsOf(c).target, time, pose.camera.target),
                up: putFrame(cameraChannelsOf(c).up, time, defaultCameraUp()),
                focalLength: putFrame(cameraChannelsOf(c).focalLength, time, pose.camera.fov),
              } satisfies StageCameraChannels;
              return withCameraChannels(c, channels);
            })()
          : c,
      ),
    },
    t,
  );
}
export function stageFrameTimes(stage: LocalStageDocument): number[] {
  return [
    ...new Set([
      ...stage.objects.flatMap((o) => o.keyframes.map((f) => f.time)),
      ...stage.cameras.flatMap((c) => [
        ...cameraChannelsOf(c).position,
        ...cameraChannelsOf(c).target,
        ...cameraChannelsOf(c).up,
        ...cameraChannelsOf(c).focalLength,
      ].map((f) => f.time)),
    ]),
  ].sort((a, b) => a - b);
}
export function removeStageFrame(
  stage: LocalStageDocument,
  time: number,
): LocalStageDocument {
  return {
    ...stage,
    objects: stage.objects.map((o) => ({
      ...o,
      keyframes: o.keyframes.filter((f) => f.time !== time),
    })),
    cameras: stage.cameras.map((c) =>
      withCameraChannels(c, {
        position: cameraChannelsOf(c).position.filter((f) => f.time !== time),
        target: cameraChannelsOf(c).target.filter((f) => f.time !== time),
        up: cameraChannelsOf(c).up.filter((f) => f.time !== time),
        focalLength: cameraChannelsOf(c).focalLength.filter((f) => f.time !== time),
      }),
    ),
  };
}
/** Encoder resolution for a stage ratio. The default long edge matches the
 * standard export quality; high quality doubles nothing but the long edge. */
export function stageOutputSize(
  ratio: LocalStageDocument["aspectRatio"],
  longEdge = 1280,
): {
  width: number;
  height: number;
} {
  const [w, h] = ratio.split(":").map(Number);
  return {
    width: Math.round((longEdge * w!) / Math.max(w!, h!) / 2) * 2,
    height: Math.round((longEdge * h!) / Math.max(w!, h!) / 2) * 2,
  };
}
/** Imported objects pinning assets the current project has not registered.
 * Stage JSON exports carry no model bytes, so such objects can neither
 * preview nor apply; importers reject them explicitly instead of failing
 * at save time. */
export function unregisteredStageAssets(
  stage: LocalStageDocument,
  isRegistered: (asset: AssetRef) => boolean,
): StageObject[] {
  return stage.objects.filter(
    (object) => object.kind === "gltf" && object.asset && !isRegistered(object.asset),
  );
}
/** The camera plan an export run follows. "storyboard" concatenates the
 * shot list into the exported timeline, skipping uncovered gaps; a camera
 * id plays that rig through the whole document. The draft itself stays
 * untouched — the plan is a projection for one render. */
export function stageExportPlan(
  stage: LocalStageDocument,
  source: string,
  t: Translate = defaultTranslate,
): {
  stage: LocalStageDocument;
  duration: number;
  timeAt: (at: number) => number;
} {
  const storyboard = source === "storyboard";
  if (storyboard && !stage.shots.length)
    throw new Error(t("editors.stage.error.exportStoryboardEmpty"));
  const plan = parseLocalStageValue(
    storyboard
      ? { ...stage, cameraSource: "storyboard" as const }
      : {
          ...stage,
          cameraSource: "camera" as const,
          activeCameraId: source,
        },
    t,
  );
  if (!storyboard && !plan.cameras.some((camera) => camera.id === source))
    throw new Error(t("editors.stage.error.cameraMissing"));
  const duration = storyboard
    ? plan.shots.reduce((total, shot) => total + shot.duration, 0)
    : plan.duration;
  const timeAt = (at: number) => {
    if (!storyboard) return at;
    let offset = 0;
    for (const shot of plan.shots) {
      if (at < offset + shot.duration) return shot.start + (at - offset);
      offset += shot.duration;
    }
    const last = plan.shots.at(-1)!;
    return last.start + last.duration;
  };
  return { stage: plan, duration, timeAt };
}
