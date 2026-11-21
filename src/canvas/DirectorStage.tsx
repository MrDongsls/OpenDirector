import { useEditorCommit, type EditorApplyResult } from "./useEditorCommit";
import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  TransformControls,
  TransformControlsGizmo,
} from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedObject } from "three/addons/utils/SkeletonUtils.js";
import type { CanvasNode, StageStillItem } from "./model";
import type {
  Asset,
  AssetRef,
  DirectorOutputPlanInput,
} from "../contracts/generated.ts";
import { ControlSlider } from "./ControlSlider";
import {
  createLocalStage,
  parseLocalStageValue,
  probeStageAsset,
  sampleStage,
  sampleStageCamera,
  editStageObjectAt,
  editStageObjectPlacement,
  editStageCameraAt,
  captureStageFrame,
  stageFrameTimes,
  removeStageFrame,
  stageOutputSize,
  stageExportPlan,
  unregisteredStageAssets,
  sameLocalStage,
  defaultStageCamera,
  STAGE_RATIOS,
  STAGE_ASSET_MAX_BYTES,
} from "./stageDocument";
import type {
  LocalStageDocument,
  StageCamera,
  StageCameraChannels,
  StageSample,
  StageSampleObject,
  StageMotionClip,
  StageShot,
  StageObject,
  StageTransform,
  StageAssetRole,
  Vector3Value,
} from "./stageDocument";
import {
  createDirectorStageViewState,
  directorStageViewReducer,
} from "./directorStageViewState";
import type {
  DirectorStageLeftTab,
  DirectorStageInteractionMode,
  DirectorStageViewAction,
} from "./directorStageViewState";
import {
  commitStageHistory,
  createStageHistory,
  navigateStageHistory,
  type StageHistory,
} from "./stageHistory";
import "./director-stage.css";
import {
  STAGE_MOTIONS,
  sampleJointPose,
  selectStageAnimation,
  type StageMotion,
} from "./stageMotion";
import { encodeMp4 } from "./mp4Export";
import {
  projectStageEnvironment,
  STAGE_GROUND_NAME,
  STAGE_GRID_NAME,
  STAGE_LIGHT_NAMES,
  STAGE_ENVIRONMENT_PRESETS,
  type StageEnvironmentDescriptor,
} from "./stageEnvironment.ts";
import { downloadFile, downloadFilename } from "./assets";
import { assetReference } from "../backend/creationClient.ts";
import { withMediaDuration } from "./editorMedia";
import { mediaBlobDataUrl } from "./localMediaRuntime";
import type { LinkedMediaResult } from "./linkedResults";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import {
  projectStageTimeline,
  snapStageTimelineTime,
  type StageTimelineChannel,
  type StageTimelineTrack,
  editStageCameraChannelAt,
  editStageObjectTransformChannelAt,
  removeStageTimelineKeyframe,
  type StageTimelineKeyframeTarget,
} from "./stageTimeline.ts";

export interface DirectorStageProps {
  node: CanvasNode;
  onApply: (
    stage: LocalStageDocument,
    stills?: StageStillItem[],
  ) => EditorApplyResult;
  onClose: () => void;
  onRender: (result: LinkedMediaResult) => boolean | Promise<boolean>;
  onPrepareRender?: (
    stage: LocalStageDocument,
    stills?: StageStillItem[],
    directorPlan?: DirectorOutputPlanInput,
  ) => Promise<(result: LinkedMediaResult) => Promise<boolean>>;
  /** Whether a pinned asset is registered in the currently open project;
   * stage JSON imports reject objects pinning assets it reports as absent. */
  isRegisteredAsset?: (asset: AssetRef) => boolean;
  backgroundAssets?: readonly Asset[];
  resolveAssetUrl?: (asset: AssetRef) => Promise<string>;
}
interface LoadedStageAsset {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}
interface RestPose {
  object: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}
interface ImportedRuntime {
  root: THREE.Group;
  clips: THREE.AnimationClip[];
  mixer?: THREE.AnimationMixer;
  activeClip?: THREE.AnimationClip;
  restPose: RestPose[];
}
interface StageRuntime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  translate: TransformControls;
  rotate: TransformControls;
  scale: TransformControls;
  root: THREE.Group;
  grid: THREE.GridHelper;
  /** Viewport-local helper group (motion paths, height guides). */
  helpers: THREE.Group;
  imported: Map<string, ImportedRuntime>;
  /** In-flight or resolved loads keyed by pinned asset id or source URL, so
   * concurrent effect runs share one load and one set of GPU resources. */
  assetCache: Map<string, Promise<LoadedStageAsset>>;
}

const STAGE_GROUND_LEVEL = 0;
const STAGE_UNDERGROUND_GROUND_OPACITY = 0.45;

function hasBelowGroundObject(root: THREE.Group, bounds: THREE.Box3): boolean {
  for (const child of root.children) {
    if (!child.visible) continue;
    bounds.setFromObject(child);
    if (!bounds.isEmpty() && bounds.min.y < STAGE_GROUND_LEVEL - 0.001)
      return true;
  }
  return false;
}

/**
 * The ground is opaque during normal output, but the director viewport needs
 * to reveal a subject that intersects it. A translucent ground veil keeps the
 * below-ground part visible without changing the saved transform or camera
 * render.
 */
function setStageGroundReveal(ground: THREE.Mesh, reveal: boolean) {
  if (!(ground.material instanceof THREE.MeshStandardMaterial)) return;
  const material = ground.material;
  const opacity = reveal ? STAGE_UNDERGROUND_GROUND_OPACITY : 1;
  const transparent = reveal;
  const depthWrite = !reveal;
  if (
    material.transparent === transparent &&
    material.opacity === opacity &&
    material.depthWrite === depthWrite
  )
    return;
  material.transparent = transparent;
  material.opacity = opacity;
  material.depthWrite = depthWrite;
  material.needsUpdate = true;
}

function applyStageEnvironment(
  scene: THREE.Scene,
  descriptor: StageEnvironmentDescriptor,
  groundVisible = descriptor.ground.visible,
  renderer?: THREE.WebGLRenderer,
) {
  scene.background = new THREE.Color(descriptor.backgroundColor);
  if (renderer) {
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = descriptor.exposure;
  }
  const ground = scene.getObjectByName(STAGE_GROUND_NAME);
  if (ground instanceof THREE.Mesh && ground.material instanceof THREE.MeshStandardMaterial) {
    ground.material.color.set(descriptor.ground.color);
    ground.visible = groundVisible;
  }
  for (const light of Object.values(descriptor.lights)) {
    const object = scene.getObjectByName(STAGE_LIGHT_NAMES[light.id]);
    if (!(object instanceof THREE.Light)) continue;
    object.color.set(light.color);
    object.intensity = light.intensity;
    object.position.set(light.position.x, light.position.y, light.position.z);
    object.castShadow = light.castShadow;
  }
}
async function applyStageBackground(
  scene: THREE.Scene,
  descriptor: StageEnvironmentDescriptor,
  resolveAssetUrl?: (asset: AssetRef) => Promise<string>,
  isCurrent: () => boolean = () => true,
) {
  scene.background = new THREE.Color(descriptor.backgroundColor);
  if (!descriptor.backgroundAsset || !resolveAssetUrl) return false;
  try {
    const url = await resolveAssetUrl(descriptor.backgroundAsset);
    const texture = await new THREE.TextureLoader().loadAsync(url);
    if (!isCurrent()) {
      texture.dispose();
      return false;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.userData.stageBackgroundAssetId = descriptor.backgroundAsset.assetId;
    scene.background = texture;
    return true;
  } catch {
    return false;
  }
}
const vector = (value: THREE.Vector3 | THREE.Euler): Vector3Value => ({
  x: value.x,
  y: value.y,
  z: value.z,
});
const THUMBNAIL_RENDER_SIZE = { width: 256, height: 192 } as const;
const THUMBNAIL_CROP_SIZE = { width: 192, height: 112 } as const;
const THUMBNAIL_ZERO_TRANSFORM: StageTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function cropStageThumbnail(renderer: THREE.WebGLRenderer): string {
  const source = renderer.domElement;
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_CROP_SIZE.width;
  canvas.height = THUMBNAIL_CROP_SIZE.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Stage thumbnail canvas is unavailable");
  const cropX = Math.max(
    0,
    Math.floor((source.width - THUMBNAIL_CROP_SIZE.width) / 2),
  );
  const cropY = Math.max(
    0,
    Math.floor((source.height - THUMBNAIL_CROP_SIZE.height) / 2),
  );
  context.drawImage(
    source,
    cropX,
    cropY,
    THUMBNAIL_CROP_SIZE.width,
    THUMBNAIL_CROP_SIZE.height,
    0,
    0,
    THUMBNAIL_CROP_SIZE.width,
    THUMBNAIL_CROP_SIZE.height,
  );
  return canvas.toDataURL("image/png");
}

function renderStageObjectModelThumbnail(
  model: THREE.Group,
  modelSharesAssetResources: boolean,
): string | null {
  let renderer: THREE.WebGLRenderer | null = null;
  let ground: THREE.Mesh | null = null;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(
      THUMBNAIL_RENDER_SIZE.width,
      THUMBNAIL_RENDER_SIZE.height,
      false,
    );
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#171717");
    scene.add(new THREE.HemisphereLight("#d9e5ff", "#222222", 1.6));
    const keyLight = new THREE.DirectionalLight("#ffffff", 3.2);
    keyLight.position.set(3, 5, 4);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight("#7190c8", 1.1);
    fillLight.position.set(-3, 2, -2);
    scene.add(fillLight);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshStandardMaterial({ color: "#242424", roughness: 0.92 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    scene.add(model);
    scene.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.5);
    const camera = new THREE.PerspectiveCamera(
      32,
      THUMBNAIL_RENDER_SIZE.width / THUMBNAIL_RENDER_SIZE.height,
      0.01,
      100,
    );
    const distance = extent / (2 * Math.tan(THREE.MathUtils.degToRad(32) / 2));
    camera.position.set(
      center.x + distance * 0.85,
      center.y + extent * 0.25,
      center.z + distance * 1.15,
    );
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return cropStageThumbnail(renderer);
  } catch {
    return null;
  } finally {
    if (ground) {
      ground.geometry.dispose();
      if (ground.material instanceof THREE.Material) ground.material.dispose();
    }
    if (!modelSharesAssetResources) disposeObject(model);
    renderer?.forceContextLoss();
    renderer?.dispose();
  }
}

function renderStageObjectThumbnailNow(
  value: StageObject,
  loaded?: LoadedStageAsset,
): string | null {
  const normalized: StageObject = {
    ...value,
    ...THUMBNAIL_ZERO_TRANSFORM,
  };
  if (loaded) {
    normalized.source = value.source;
    return renderStageObjectModelThumbnail(
      cloneImportedAsset(normalized, loaded),
      true,
    );
  }
  return renderStageObjectModelThumbnail(buildObject(normalized), false);
}

function StageObjectPreview({
  object,
}: {
  object: Pick<
    StageObject,
    "kind" | "color" | "thumbnailCapture" | "thumbnailSource"
  >;
}) {
  const thumbnail = object.thumbnailCapture ?? object.thumbnailSource;
  return (
    <span
      className="cw-stage-object-preview"
      data-stage-object-kind={object.kind}
      data-thumbnail-state={thumbnail ? "ready" : "empty"}
      aria-hidden="true"
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" />
      ) : (
        <span className="cw-stage-object-preview-empty" />
      )}
    </span>
  );
}

function materializeStageThumbnails(
  stage: LocalStageDocument,
): LocalStageDocument {
  let changed = false;
  const objects = stage.objects.map((object) => {
    if (
      object.thumbnailCapture ||
      object.thumbnailSource ||
      object.kind === "gltf"
    )
      return object;
    const thumbnailCapture = renderStageObjectThumbnailNow(object);
    if (!thumbnailCapture) return object;
    changed = true;
    return { ...object, thumbnailCapture };
  });
  return changed ? { ...stage, objects } : stage;
}

type CameraPresetId =
  | "frontMedium" | "frontClose" | "frontWide" | "sideTrack" | "sideClose"
  | "backMedium" | "overheadWide" | "highAngle" | "lowAngle" | "lowWide"
  | "overShoulder" | "bird" | "dutch";
const CAMERA_PRESETS: Record<CameraPresetId, { offset: Vector3Value; fov: number; roll?: number }> = {
  frontMedium: { offset: { x: 0, y: 0.6, z: 6 }, fov: 45 },
  frontClose: { offset: { x: 0, y: 0.5, z: 2.6 }, fov: 40 },
  frontWide: { offset: { x: 0, y: 2.2, z: 11 }, fov: 50 },
  sideTrack: { offset: { x: 6, y: 0.6, z: 0.6 }, fov: 45 },
  sideClose: { offset: { x: 2.6, y: 0.4, z: 0.4 }, fov: 40 },
  backMedium: { offset: { x: 0, y: 0.9, z: -6 }, fov: 45 },
  overheadWide: { offset: { x: 0, y: 10, z: 3.5 }, fov: 50 },
  highAngle: { offset: { x: 3.5, y: 3.5, z: 3.5 }, fov: 45 },
  lowAngle: { offset: { x: 0, y: -0.5, z: 4 }, fov: 40 },
  lowWide: { offset: { x: 0, y: -0.6, z: 7 }, fov: 75 },
  overShoulder: { offset: { x: 1.1, y: 0.35, z: 2.1 }, fov: 42 },
  bird: { offset: { x: 0, y: 13, z: 0.01 }, fov: 45 },
  dutch: { offset: { x: 0, y: 0.8, z: 5.5 }, fov: 45, roll: 0.32 },
};
const axes = ["x", "y", "z"] as const;
const titles: Record<StageObject["kind"], MessageKey> = {
  person: "editors.stage.ui.objectPerson",
  box: "editors.stage.ui.objectBox",
  sphere: "editors.stage.ui.objectSphere",
  cylinder: "editors.stage.ui.objectCylinder",
  cone: "editors.stage.ui.objectCone",
  pyramid: "editors.stage.ui.objectPyramid",
  torus: "editors.stage.ui.objectTorus",
  plane: "editors.stage.ui.objectPlane",
  capsule: "editors.stage.ui.objectCapsule",
  disk: "editors.stage.ui.objectDisk",
  arc: "editors.stage.ui.objectArc",
  halfCylinder: "editors.stage.ui.objectHalfCylinder",
  gltf: "editors.stage.ui.objectGltf",
};
const BUILTIN_CHARACTER_KINDS = ["person"] as const;
const BUILTIN_OBJECT_KINDS = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "pyramid",
  "torus",
  "plane",
  "capsule",
  "disk",
  "arc",
  "halfCylinder",
] as const;

function defaultStageObjectColor(kind: StageObject["kind"]): string {
  if (kind === "person") return "#d0d0d0";
  if (kind === "gltf") return "#b8c5ff";
  return kind === "box" ? "#c4c4c4" : "#b8b8b8";
}

function createStageObjectTemplate(
  kind: StageObject["kind"],
  name: string,
  id: string,
): StageObject {
  return {
    id,
    kind,
    name,
    color: defaultStageObjectColor(kind),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    locked: false,
    opacity: 1,
    keyframes: [],
    motionClips: [],
  };
}
function applyTransform(object: THREE.Object3D, value: StageTransform) {
  object.position.set(value.position.x, value.position.y, value.position.z);
  object.rotation.set(value.rotation.x, value.rotation.y, value.rotation.z);
  object.scale.set(value.scale.x, value.scale.y, value.scale.z);
}
function buildObject(value: StageObject): THREE.Group {
  const group = new THREE.Group();
  group.userData.objectId = value.id;
  group.userData.objectKind = value.kind;
  if (value.kind === "gltf") {
    group.userData.assetSource = value.source;
    // The translucent box owns exclusive GPU resources, unlike loaded
    // clones that share them with the cached scene.
    group.userData.placeholder = true;
  }
  const material = new THREE.MeshStandardMaterial({
    color: value.color,
    roughness: 0.58,
    metalness: 0.08,
  });
  const add = (
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  if (value.kind === "box") add(new THREE.BoxGeometry(1, 1, 1), 0, 0.5, 0);
  else if (value.kind === "sphere")
    add(new THREE.SphereGeometry(0.6, 32, 24), 0, 0.6, 0);
  else if (value.kind === "cylinder")
    add(new THREE.CylinderGeometry(0.5, 0.5, 1.4, 32), 0, 0.7, 0);
  else if (value.kind === "cone")
    add(new THREE.ConeGeometry(0.6, 1.4, 32), 0, 0.7, 0);
  else if (value.kind === "pyramid")
    add(new THREE.ConeGeometry(0.7, 1.2, 4), 0, 0.6, 0);
  else if (value.kind === "torus")
    add(new THREE.TorusGeometry(0.55, 0.2, 20, 40), 0, 0.75, 0);
  else if (value.kind === "plane") {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.receiveShadow = true;
    group.add(mesh);
  } else if (value.kind === "capsule")
    add(new THREE.CapsuleGeometry(0.35, 0.9, 8, 16), 0, 0.8, 0);
  else if (value.kind === "disk")
    add(new THREE.CylinderGeometry(0.8, 0.8, 0.12, 40), 0, 0.06, 0);
  else if (value.kind === "arc")
    add(new THREE.TorusGeometry(0.7, 0.16, 16, 40, Math.PI), 0, 0.16, 0);
  else if (value.kind === "halfCylinder")
    add(
      new THREE.CylinderGeometry(0.6, 0.6, 1.2, 32, 1, false, 0, Math.PI),
      0,
      0.6,
      0,
    );
  else if (value.kind === "gltf") {
    material.transparent = true;
    material.opacity = 0.35;
    add(new THREE.BoxGeometry(1, 1, 1), 0, 0.5, 0);
  } else {
    const bone = (
      parent: THREE.Object3D,
      name: string,
      x: number,
      y: number,
      z = 0,
    ) => {
      const joint = new THREE.Bone();
      joint.name = name;
      joint.position.set(x, y, z);
      parent.add(joint);
      return joint;
    };
    const mesh = (
      parent: THREE.Object3D,
      geometry: THREE.BufferGeometry,
      y: number,
    ) => {
      const part = new THREE.Mesh(geometry, material);
      part.position.y = y;
      part.castShadow = true;
      part.receiveShadow = true;
      parent.add(part);
    };
    const hips = bone(group, "hips", 0, 0.9);
    mesh(hips, new THREE.CylinderGeometry(0.23, 0.19, 0.55, 16), 0.28);
    mesh(hips, new THREE.SphereGeometry(0.22, 24, 16), 0.8);
    for (const [side, sign] of [
      ["left", -1],
      ["right", 1],
    ] as const) {
      const hip = bone(hips, `${side}Hip`, sign * 0.13, 0);
      mesh(hip, new THREE.CapsuleGeometry(0.085, 0.25, 6, 12), -0.21);
      const knee = bone(hip, `${side}Knee`, 0, -0.42);
      mesh(knee, new THREE.CapsuleGeometry(0.075, 0.28, 6, 12), -0.22);
      const shoulder = bone(hips, `${side}Shoulder`, sign * 0.3, 0.5);
      mesh(shoulder, new THREE.CapsuleGeometry(0.065, 0.2, 6, 12), -0.16);
      const elbow = bone(shoulder, `${side}Elbow`, 0, -0.32);
      mesh(elbow, new THREE.CapsuleGeometry(0.055, 0.2, 6, 12), -0.15);
    }
  }
  applyTransform(group, value);
  return group;
}
function cloneImportedAsset(
  value: StageObject,
  loaded: LoadedStageAsset,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.objectId = value.id;
  group.userData.objectKind = value.kind;
  group.userData.assetSource = value.source;
  group.add(cloneSkinnedObject(loaded.scene));
  applyTransform(group, value);
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}
async function loadStageAsset(source: string): Promise<LoadedStageAsset> {
  const loaded = await new GLTFLoader().loadAsync(source);
  return { scene: loaded.scene, animations: loaded.animations };
}
function createImportedRuntime(
  group: THREE.Group,
  clips: THREE.AnimationClip[],
): ImportedRuntime {
  const restPose: RestPose[] = [];
  for (const child of group.children)
    child.traverse((object) => {
      restPose.push({
        object,
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
      });
    });
  return {
    root: group,
    clips,
    mixer: clips.length ? new THREE.AnimationMixer(group) : undefined,
    restPose,
  };
}
function applyImportedAnimation(
  imported: Map<string, ImportedRuntime>,
  value: StageSampleObject,
) {
  if (value.kind !== "gltf") return;
  const binding = imported.get(value.id);
  if (!binding?.mixer) return;
  const clip = value.motion
    ? selectStageAnimation(binding.clips, value.motion.preset)
    : undefined;
  if (binding.activeClip !== clip) {
    binding.mixer.stopAllAction();
    if (clip) binding.mixer.clipAction(clip).reset().play();
    // Leaving a clip must return the skeleton to its authored rest pose;
    // stopAllAction alone leaves bones at the last sampled pose.
    else
      for (const part of binding.restPose) {
        part.object.position.copy(part.position);
        part.object.quaternion.copy(part.quaternion);
        part.object.scale.copy(part.scale);
      }
    binding.activeClip = clip;
  }
  binding.mixer.setTime(
    clip && value.motion ? value.motionTime * value.motion.speed : 0,
  );
}
function poseJoints(group: THREE.Object3D, value: StageSampleObject) {
  if (value.kind !== "person") return;
  const pose = sampleJointPose(value.motion, value.motionTime);
  const hips = group.getObjectByName("hips");
  if (hips) hips.position.y = 0.9 + pose.hipsY;
  for (const side of ["left", "right"] as const) {
    const hip = group.getObjectByName(`${side}Hip`),
      knee = group.getObjectByName(`${side}Knee`);
    const shoulder = group.getObjectByName(`${side}Shoulder`),
      elbow = group.getObjectByName(`${side}Elbow`);
    if (hip) hip.rotation.x = pose[`${side}Hip`];
    if (knee) knee.rotation.x = pose[`${side}Knee`];
    if (shoulder)
      shoulder.rotation.set(
        pose[`${side}ShoulderX`],
        0,
        side === "right" ? pose.rightShoulderZ : 0,
      );
    if (elbow) elbow.rotation.x = pose[`${side}Elbow`];
  }
}
function disposeObject(object: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (Array.isArray(child.material)
        ? child.material
        : [child.material]
      ).forEach((material) => materials.add(material));
    }
  });
  materials.forEach((material) => material.dispose());
}
/** Removes the translate gizmo's center view-plane handle. Unlike the plane
 * quads (showXY/showYZ/showXZ hide their visuals and pickers together), the
 * controls offer no toggle for the center: the "XYZ" picker mesh must be
 * dropped from the group itself so only the axis arrows stay grabbable, and
 * its visible octahedron marker goes with it so nothing dead-looking remains.
 * Only the translate handle groups are iterated; the rotate groups have no
 * exact-"XYZ" child anyway, and the scale groups never show on this
 * fixed-mode instance. */
function removeCenterHandle(controls: TransformControls) {
  const gizmo = controls.getHelper().children.find(
    (child): child is TransformControlsGizmo =>
      child instanceof TransformControlsGizmo,
  );
  if (!gizmo) return;
  const { gizmo: handles, picker } = gizmo;
  for (const group of [handles.translate, picker.translate])
    for (const child of [...group.children])
      if (child.name === "XYZ") group.remove(child);
}
function setCamera(runtime: StageRuntime, value: StageCamera) {
  runtime.camera.position.set(
    value.position.x,
    value.position.y,
    value.position.z,
  );
  runtime.camera.fov = value.fov;
  runtime.camera.updateProjectionMatrix();
  runtime.controls.target.set(value.target.x, value.target.y, value.target.z);
  runtime.controls.update();
}
/** Pose cameras carry roll; apply it after lookAt by rotating on the view axis. */
function applyRoll(camera: THREE.PerspectiveCamera, value: StageCamera) {
  camera.lookAt(value.target.x, value.target.y, value.target.z);
  camera.rotateZ(value.roll ?? 0);
}
function displayPose(runtime: StageRuntime, pose: StageSample) {
  setCamera(runtime, pose.camera);
  // The gizmo owns object transforms while a drag is in flight; an async
  // GLTF-load or undo re-pose must not stomp it.
  if (runtime.translate.dragging || runtime.rotate.dragging) return;
  for (const child of runtime.root.children) {
    const data = pose.objects.find(
      (item) => item.id === child.userData.objectId,
    );
    if (data) {
      applyTransform(child, data);
      child.visible = data.visible;
      child.traverse((descendant) => {
        if (descendant instanceof THREE.Mesh) {
          const material = descendant.material as THREE.MeshStandardMaterial;
          material.transparent = data.opacity < 1 || material.transparent;
          material.opacity = data.opacity;
        }
      });
      poseJoints(child, data);
      applyImportedAnimation(runtime.imported, data);
    }
  }
}
const focalLength = (fov: number) =>
  35 / (16 / 9) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
const fovFromFocal = (focal: number) =>
  THREE.MathUtils.radToDeg(2 * Math.atan(35 / (16 / 9) / (2 * focal)));

function VectorFields({
  label,
  value,
  onChange,
  rotation = false,
  min,
}: {
  label: string;
  value: Vector3Value;
  onChange: (value: Vector3Value) => void;
  rotation?: boolean;
  min?: number;
}) {
  const { t } = useI18n();
  // Sliders trade range for immediacy: the number input stays for exact
  // values outside the drag band.
  const [sliderMin, sliderMax] = rotation
    ? ([-180, 180] as const)
    : min !== undefined
      ? ([min, 4] as const)
      : ([-20, 20] as const);
  const display = (axis: keyof Vector3Value) =>
    Number(
      (rotation ? THREE.MathUtils.radToDeg(value[axis]) : value[axis]).toFixed(
        3,
      ),
    );
  return (
    <fieldset className="cw-stage-vector">
      <legend>
        {label}
        {rotation ? t("editors.stage.ui.degreesSuffix") : ""}
      </legend>
      {axes.map((axis) => (
        <div className="cw-stage-axis" key={axis}>
          <span aria-hidden="true">{axis.toUpperCase()}</span>
          <ControlSlider
            aria-label={`${label} ${axis.toUpperCase()} ${t(
              "editors.stage.ui.sliderSuffix",
            )}`}
            min={sliderMin}
            max={sliderMax}
            step={rotation ? 1 : 0.1}
            value={Math.min(sliderMax, Math.max(sliderMin, display(axis)))}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (Number.isFinite(raw))
                onChange({
                  ...value,
                  [axis]: rotation ? THREE.MathUtils.degToRad(raw) : raw,
                });
            }}
          />
          <input
            aria-label={`${label} ${axis.toUpperCase()}`}
            type="number"
            step={rotation ? 5 : 0.1}
            min={min}
            value={display(axis)}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (Number.isFinite(raw) && (min === undefined || raw >= min))
                onChange({
                  ...value,
                  [axis]: rotation ? THREE.MathUtils.degToRad(raw) : raw,
                });
            }}
          />
        </div>
      ))}
    </fieldset>
  );
}

export function DirectorStage({
  node,
  onApply,
  onClose,
  onRender,
  onPrepareRender,
  isRegisteredAsset,
  backgroundAssets,
  resolveAssetUrl,
}: DirectorStageProps) {
  const { t } = useI18n();
  const [historyState, setHistoryState] = useState(() =>
    createStageHistory(
      materializeStageThumbnails(
        node.data.localStage
          ? parseLocalStageValue(node.data.localStage, t)
          : createLocalStage(t),
      ),
    ),
  );
  const commit = useEditorCommit(onClose);
  const stage = historyState.present;
  const history = useRef(historyState);
  const [viewState, dispatchView] = useReducer(
    directorStageViewReducer,
    createDirectorStageViewState(stage.objects[0]?.id ?? null),
  );
  const selected = viewState.selectedObjectId;
  const cameraPreview = viewState.cameraPreview;
  const previewMode = viewState.previewMode;
  const splitView = viewState.splitView.kind === "open";
  const splitRatio = viewState.splitView.ratio;
  const splitCameraId =
    viewState.splitView.kind === "open"
      ? viewState.splitView.cameraId
      : null;
  const viewFlags = viewState.viewFlags;
  const viewMenu = viewState.viewMenuOpen;
  const viewfinder = viewState.interactionMode.kind === "viewfinder";
  const walkMode = viewState.interactionMode.kind === "roam";
  const pendingPlacement =
    viewState.interactionMode.kind === "placement"
      ? viewState.interactionMode
      : null;
  const pendingKind = pendingPlacement?.objectKind ?? null;
  const pendingPlacementSourceId = pendingPlacement?.sourceObjectId ?? null;
  const assetRole = viewState.assetRole;
  const leftTab = viewState.leftTab;
  const treeGroups = viewState.treeGroups;
  const helpOpen = viewState.helpOpen;
  const drawerOpen = viewState.drawerOpen;
  const selectedStills = viewState.selectedStillIds;
  const previewStillId = viewState.previewStillId;
  const exportOpen = viewState.exportDialog.kind === "open";
  const exportSource = viewState.exportDialog.source;
  const exportClarity = viewState.exportDialog.clarity;
  const exportFps = viewState.exportDialog.fps;
  const activeGizmo = viewState.activeGizmo;
  const setView = (action: DirectorStageViewAction) => dispatchView(action);
  const setSelected = (objectId: string | null) =>
    setView({ type: "selectObject", objectId });
  const setPendingKind = (
      objectKind: StageObject["kind"] | null,
      sourceObjectId: string | null = null,
    ) =>
    setView(
      objectKind
        ? { type: "armPlacement", objectKind, sourceObjectId }
        : { type: "cancelPlacement" },
    );
  const setSplitRatio = (ratio: number) =>
    setView({ type: "setSplitRatio", ratio });
  const setSplitCameraId = (cameraId: string | null) =>
    setView({ type: "setSplitCamera", cameraId });
  const setViewMenu = (open: boolean) => setView({ type: "setViewMenu", open });
  const setLeftTab = (tab: DirectorStageLeftTab) =>
    setView({ type: "setLeftTab", tab });
  const setAssetRole = (role: StageAssetRole) =>
    setView({ type: "setAssetRole", role });
  const setPreviewStillId = (stillId: string | null) =>
    setView({ type: "setPreviewStill", stillId });
  const setExportSource = (source: string) =>
    setView({ type: "setExportSource", source });
  const setExportClarity = (clarity: number) =>
    setView({ type: "setExportClarity", clarity });
  const setExportFps = (fps: number) => setView({ type: "setExportFps", fps });
  const setDrawerOpen = (open: boolean) => setView({ type: "setDrawer", open });
  const setHelpOpen = (open: boolean) => setView({ type: "setHelp", open });
  const [error, setError] = useState(""),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [ready, setReady] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [selectedTimelinePoint, setSelectedTimelinePoint] = useState<{
    trackId: string;
    pointId: string;
  } | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const loadedStage = useRef(historyState.present);
  const consoleRef = useRef<HTMLDivElement>(null);
  const consoleId = useId();
  const nestedDialogRef = useRef<HTMLDivElement>(null);
  const nestedDialog = helpOpen
    ? "help"
    : exportOpen
      ? "export"
      : previewStillId
        ? "preview"
        : confirmingClose
          ? "confirm"
          : null;
  useEffect(() => {
    if (!nestedDialog) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      const root = nestedDialogRef.current;
      const first = root?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
      );
      (first ?? root)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, [nestedDialog]);
  const trapNestedDialog = (
    event: React.KeyboardEvent<HTMLDivElement>,
    onEscape: () => void,
  ) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const root = nestedDialogRef.current;
    const elements = [
      ...(root?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
      ) ?? []),
    ];
    const first = elements[0];
    const last = elements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === root)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || document.activeElement === root)
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    consoleRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [assetQuery, setAssetQuery] = useState("");
  const [treeQuery, setTreeQuery] = useState("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const pendingKindRef = useRef<StageObject["kind"] | null>(null);
  pendingKindRef.current = pendingKind;
  const pendingPlacementRef = useRef<Extract<
    DirectorStageInteractionMode,
    { kind: "placement" }
  > | null>(null);
  pendingPlacementRef.current = pendingPlacement;
  const viewSettingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewMenuRef = useRef<HTMLDivElement | null>(null);
  const placeRef = useRef<(x: number, z: number) => void>(() => {});
  const splitRef = useRef({
    open: false,
    ratio: 0.5,
    cameraId: null as string | null,
  });
  splitRef.current = { open: splitView, ratio: splitRatio, cameraId: splitCameraId };
  /** Viewport-local helpers. Never dirty the document and never reach the
   * still or the MP4; the document keeps its own grid and aspect. */
  const viewRef = useRef(viewFlags);
  viewRef.current = viewFlags;
  const cameraPreviewRef = useRef(false);
  cameraPreviewRef.current = cameraPreview;
  const viewfinderRef = useRef(false);
  viewfinderRef.current = viewfinder;
  const walkRef = useRef(false);
  walkRef.current = walkMode;
  const prevWalk = useRef(false);
  /** One-time first-add help: survives reloads and sibling editors. */
  const helpSeen = useRef(
    (() => {
      try {
        return localStorage.getItem("opendirector.stageHelp.v1") === "seen";
      } catch {
        return false;
      }
    })(),
  );
  const liveFov = useRef<number | null>(null);
  const liveFovRef = liveFov;
  const [assetNotice, setAssetNotice] = useState("");
  /** Drawer draft over node.data.stills: pinned items plus unsaved captures,
   * committed as a whole by the next prepare or apply operation. */
  const [stills, setStills] = useState<StageStillItem[]>(
    node.data.stills ?? [],
  );
  const [stillSaving, setStillSaving] = useState(false);
  /** Last state a prepare or apply committed. The unsaved-close guard and
   * the auto-poster rule must compare against this, not the mount-time
   * node props, because prepares commit mid-session. */
  const committedStills = useRef<StageStillItem[]>(node.data.stills ?? []);
  const committedStage = useRef<LocalStageDocument | null>(null);
  const [renderedAt, setRenderedAt] = useState<{
    width: number;
    height: number;
    fps: number;
  } | null>(null);
  const renderPublisher = useRef<
    ((result: LinkedMediaResult) => boolean | Promise<boolean>) | null
  >(null);
  const [rendered, setRendered] = useState<Blob | null>(null);
  const exporting = useRef<AbortController | null>(null);
  const mount = useRef<HTMLDivElement>(null),
    runtime = useRef<StageRuntime | null>(null),
    stageRef = useRef(stage),
    timeRef = useRef(time),
    playingRef = useRef(playing),
    importInput = useRef<HTMLInputElement>(null),
    assetInput = useRef<HTMLInputElement>(null),
    ownedAssetUrls = useRef(new Set<string>()),
    active = useRef(true);
  stageRef.current = stage;
  timeRef.current = time;
  playingRef.current = playing;
  const sampled = sampleStage(stage, time);
  const timeline = useMemo(() => projectStageTimeline(stage), [stage]);
  const timelineDuration = Math.max(timeline.duration, Number.EPSILON);
  const stageEnvironment = useMemo(
    () => projectStageEnvironment(stage),
    [stage.background, stage.environment, stage.lights],
  );
  const stageEnvironmentRef = useRef(stageEnvironment);
  stageEnvironmentRef.current = stageEnvironment;
  const object = sampled.objects.find((item) => item.id === selected);
  const cameraValue = sampled.camera;
  const outputSize = stageOutputSize(stage.aspectRatio);
  const exportSize = stageOutputSize(stage.aspectRatio, exportClarity);
  // The frame sits centered at a comfortable size (a 16:9 stage is 900px
  // wide) and the timeline track, transport and storyboard match its width.
  const stageStackWidth = `min(100%, calc(min(60vh, 506px) * ${outputSize.width / outputSize.height}))`;
  const frameTimes = stageFrameTimes(stage);
  const setPlayhead = (value: number) => {
    setPlaying(false);
    setTime(snapStageTimelineTime(stageRef.current, value));
  };
  const timelineChannelLabel = (channel: StageTimelineChannel): string => {
    const keys: Record<StageTimelineChannel, MessageKey> = {
      position: "editors.stage.ui.trackPosition",
      rotation: "editors.stage.ui.trackRotation",
      scale: "editors.stage.ui.trackScale",
      motion: "editors.stage.ui.trackMotion",
      target: "editors.stage.ui.trackTarget",
      up: "editors.stage.ui.trackUp",
      focalLength: "editors.stage.ui.trackFocalLength",
    };
    return t(keys[channel]);
  };
  const timelineTrackLabel = (track: StageTimelineTrack): string =>
    track.label.kind === "shots"
      ? t("editors.stage.ui.trackShots")
      : `${track.label.name} · ${timelineChannelLabel(track.label.channel)}`;
  const selectedTimelineTrack = selectedTimelinePoint
    ? timeline.tracks.find((track) => track.id === selectedTimelinePoint.trackId)
    : undefined;
  const selectedTimelineValue = selectedTimelineTrack && selectedTimelinePoint
    ? selectedTimelineTrack.points.find((point) => point.id === selectedTimelinePoint.pointId)
    : undefined;
  const isVector = (value: unknown): value is Vector3Value =>
    typeof value === "object" && value !== null &&
    "x" in value && typeof value.x === "number" &&
    "y" in value && typeof value.y === "number" &&
    "z" in value && typeof value.z === "number";
  const selectedTimelineVector = selectedTimelineValue && isVector(selectedTimelineValue.value)
    ? selectedTimelineValue.value
    : undefined;
  const activeShot = stage.shots.find(
    (shot) =>
      time >= shot.start &&
      (time < shot.start + shot.duration ||
        (time === stage.duration && time === shot.start + shot.duration)),
  );
  const activeCamera = stage.cameras.find((camera) => camera.id === sampled.cameraId);
  const visibleObjectNames = sampled.objects.filter((item) => item.visible).map((item) => item.name);
  const activeStateText = t("editors.stage.ui.activeState", {
    shot: activeShot ? t("editors.stage.ui.shot", { number: stage.shots.indexOf(activeShot) + 1 }) : t("editors.stage.ui.noShot"),
    camera: activeCamera?.name ?? sampled.cameraId,
    objects: visibleObjectNames.length ? visibleObjectNames.slice(0, 3).join(", ") : t("editors.stage.ui.noObjects"),
  });
  const installHistory = (next: StageHistory) => {
    if (next === history.current) return;
    history.current = next;
    stageRef.current = next.present;
    setHistoryState(next);
    setTime((current) => Math.min(current, next.present.duration));
    setPlaying(false);
    setRendered(null);
    setInserted(false);
    setError("");
    setAssetNotice("");
  };
  const edit = (
    operation: (value: LocalStageDocument) => LocalStageDocument,
  ) => {
    try {
      installHistory(
        commitStageHistory(history.current, operation(stageRef.current)),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.editFailed"),
      );
    }
  };
  const applyEnvironmentPreset = (presetId: (typeof STAGE_ENVIRONMENT_PRESETS)[number]["preset"]) => {
    const preset = STAGE_ENVIRONMENT_PRESETS.find((candidate) => candidate.preset === presetId);
    if (!preset) return;
    edit((current) => ({
      ...current,
      background: preset.background,
      environment: {
        ...current.environment,
        preset: preset.preset,
        groundColor: preset.groundColor,
        groundVisible: preset.groundVisible,
        exposure: preset.exposure,
        backgroundAsset: current.environment.backgroundAsset,
      },
      lights: current.lights.map((light) => ({ ...light, ...preset.lights[light.id] })),
    }));
  };
  const navigate = (direction: "undo" | "redo") => {
    if (renderProgress !== null) return;
    if (
      runtime.current?.translate.dragging ||
      runtime.current?.rotate.dragging
    )
      return;
    installHistory(navigateStageHistory(history.current, direction));
  };
  const editObject = (patch: Partial<StageObject>) => {
    if (selected)
      edit((current) =>
        editStageObjectAt(current, selected, timeRef.current, patch),
      );
  };
  const editCamera = (patch: Partial<StageCamera>) =>
    edit((current) =>
      editStageCameraAt(
        current,
        sampleStage(current, timeRef.current).cameraId,
        timeRef.current,
        patch,
      ),
    );
  const updateClip = (id: string, patch: Partial<StageMotionClip>) => {
    if (object)
      editObject({
        motionClips: object.motionClips.map((clip) =>
          clip.id === id ? { ...clip, ...patch } : clip,
        ),
      });
  };
  const addMotionClip = () => {
    if (
      !object ||
      (object.kind !== "person" &&
        !(
          object.kind === "gltf" &&
          object.role === "character" &&
          object.hasAnimation
        ))
    )
      return;
    const start = timeRef.current;
    const next =
      object.motionClips.find((clip) => clip.start > start)?.start ??
      stage.duration;
    editObject({
      motionClips: [
        ...object.motionClips,
        {
          id: crypto.randomUUID(),
          start,
          duration: Math.min(2, next - start),
          motion: { preset: "walk", speed: 1, amount: 1 },
        },
      ],
    });
  };
  const updateShot = (id: string, patch: Partial<StageShot>) =>
    edit((current) => ({
      ...current,
      shots: current.shots.map((shot) =>
        shot.id === id ? { ...shot, ...patch } : shot,
      ),
    }));
  const addShot = () =>
    edit((current) => {
      const start = timeRef.current;
      const next =
        current.shots.find((shot) => shot.start > start)?.start ??
        current.duration;
      return {
        ...current,
        cameraSource: "storyboard",
        shots: [
          ...current.shots,
          {
            id: crypto.randomUUID(),
            cameraId: current.activeCameraId,
            start,
            duration: Math.min(2, next - start),
          },
        ],
      };
    });
  const addCamera = () =>
    edit((current) => {
      const id = crypto.randomUUID();
      return {
        ...current,
        activeCameraId: id,
        cameraSource: "camera",
        cameras: [
          ...current.cameras,
          {
            id,
            name: t("editors.stage.ui.cameraName", {
              number: current.cameras.length + 1,
            }),
            pose: sampleStage(current, timeRef.current).camera,
            keyframes: [],
          },
        ],
      };
    });
  const removeCamera = () =>
    edit((current) => {
      if (current.cameras.length === 1)
        throw new Error(t("editors.stage.ui.keepCamera"));
      const id = current.activeCameraId;
      if (current.shots.some((shot) => shot.cameraId === id))
        throw new Error(t("editors.stage.ui.cameraInUse"));
      const cameras = current.cameras.filter((camera) => camera.id !== id);
      return { ...current, cameras, activeCameraId: cameras[0]!.id };
    });
  const gestureEdit = useRef(edit);
  gestureEdit.current = edit;
  const shortcut = useRef(navigate);
  shortcut.current = navigate;
  const selectedPose = () => {
    const group = runtime.current?.root.children.find(
      (child) => child.userData.objectId === selected,
    );
    if (!group) return undefined;
    return {
      position: vector(group.position),
      rotation: vector(group.rotation),
      scale: vector(group.scale),
    };
  };
  const poseSelected = (pose: StageTransform) => {
    const current = runtime.current;
    const item = stageRef.current.objects.find(
      (entry) => entry.id === selected,
    );
    const group = current?.root.children.find(
      (child) => child.userData.objectId === selected,
    );
    if (!current || !item || !group) return;
    group.position.set(pose.position.x, pose.position.y, pose.position.z);
    group.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);
    group.scale.set(pose.scale.x, pose.scale.y, pose.scale.z);
    gestureEdit.current((doc) =>
      item.keyframes.length
        ? editStageObjectAt(doc, item.id, timeRef.current, pose)
        : editStageObjectPlacement(doc, item.id, pose),
    );
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest(".cw-stage-console") ||
        target.matches(
          "input:not([type=range]),textarea,select,[contenteditable=true]",
        )
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopPropagation();
        shortcut.current(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A focused range slider owns its arrow keys; so does the page scroll.
      const arrows = event.key.startsWith("Arrow");
      if (
        target instanceof HTMLInputElement &&
        target.type === "range" &&
        arrows
      )
        return;
      if (event.key === "1") {
        setView({ type: "setGizmo", gizmo: "translate" });
        return;
      }
      if (event.key === "2") {
        setView({ type: "setGizmo", gizmo: "rotate" });
        return;
      }
      if (event.key === "3") {
        setView({ type: "setGizmo", gizmo: "scale" });
        return;
      }
      if (event.key.toLowerCase() === "g") {
        const pose = selectedPose();
        if (pose)
          poseSelected({ ...pose, position: { ...pose.position, y: 0 } });
        return;
      }
      if (!arrows) return;
      event.preventDefault();
      const pose = selectedPose();
      if (!pose) return;
      const step = event.shiftKey ? 0.5 : 0.1;
      const delta = {
        ArrowLeft: { x: -step, z: 0 },
        ArrowRight: { x: step, z: 0 },
        ArrowUp: { x: 0, z: -step },
        ArrowDown: { x: 0, z: step },
      }[event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"];
      if (!delta) return;
      poseSelected({
        ...pose,
        position: {
          x: pose.position.x + delta.x,
          y: pose.position.y,
          z: pose.position.z + delta.z,
        },
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    active.current = true;
    const container = mount.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          preserveDrawingBuffer: true,
        });
      } catch (first) {
        // Some drivers refuse multisample buffers or run out of context
        // slots under pressure; a plain context is enough to keep editing.
        console.debug("stage renderer retry without antialias", first);
        renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
        });
      }
    } catch (reason) {
      setError(
        t("editors.stage.ui.webglInit", {
          reason:
            reason instanceof Error ? reason.message : String(reason),
        }),
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);
    const pipCanvas = document.createElement("canvas");
    pipCanvas.className = "cw-stage-pipcanvas";
    pipCanvas.setAttribute("aria-hidden", "true");
    const pipContext = pipCanvas.getContext("2d");
    container.append(pipCanvas);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000),
      controls = new OrbitControls(camera, renderer.domElement),
      root = new THREE.Group();
    controls.enableDamping = false;
    controls.minDistance = 0.2;
    controls.maxDistance = 200;
    root.name = "stage-objects";
    scene.add(root);
    // Created first on purpose: both controls listen on the same canvas and
    // pointerdown listeners run in registration order, so the translate gizmo
    // wins any pointerdown that hits both gizmos.
    const translate = new TransformControls(camera, renderer.domElement);
    translate.showXY = false;
    translate.showYZ = false;
    translate.showXZ = false;
    removeCenterHandle(translate);
    scene.add(translate.getHelper());
    const rotate = new TransformControls(camera, renderer.domElement);
    rotate.setMode("rotate");
    // Rings sized to sit inside the arrow band instead of crossing it.
    rotate.size = 0.65;
    scene.add(rotate.getHelper());
    const scale = new TransformControls(camera, renderer.domElement);
    scale.setMode("scale");
    scale.size = 0.5;
    // A never-attached helper renders undefined internals into the export
    // clone; it joins the scene only when first shown.
    const grid = new THREE.GridHelper(30, 30, 0x5a5a5a, 0x3a3a3a);
    grid.name = STAGE_GRID_NAME;
    scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x202737, roughness: 1 }),
    );
    ground.name = STAGE_GROUND_NAME;
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 2.4);
    hemisphere.name = STAGE_LIGHT_NAMES.hemisphere;
    scene.add(hemisphere);
    const light = new THREE.DirectionalLight(0xffffff, 3.5);
    light.name = STAGE_LIGHT_NAMES.key;
    light.position.set(5, 10, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xffffff, 1.6);
    fill.name = STAGE_LIGHT_NAMES.fill;
    fill.position.set(-6, 5, -5);
    scene.add(fill);
    const pipCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000);
    // Viewport-local helpers live in one named group so captures and the
    // export clone can drop them wholesale; object-name labels stay in the
    // DOM and never touch a render.
    const helpers = new THREE.Group();
    helpers.name = "stage-helpers";
    scene.add(helpers);
    const current: StageRuntime = {
      renderer,
      scene,
      camera,
      controls,
      translate,
      rotate,
      scale,
      root,
      grid,
      helpers,
      imported: new Map(),
      assetCache: new Map(),
    };
    runtime.current = current;
    applyStageEnvironment(scene, stageEnvironmentRef.current, undefined, renderer);
    setCamera(current, sampleStage(stageRef.current, timeRef.current).camera);
    const resize = () => {
      // The viewport fills its panel; the stage aspect shows up in the
      // captured still and the MP4, not in the free-form preview frame.
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const resizeFrame = requestAnimationFrame(resize);
    const renderSize = new THREE.Vector2();
    const objectBounds = new THREE.Box3();
    window.addEventListener("resize", resize);
    // View indicator: live pitch/yaw/FOV readout with a reset to the pose
    // the stage opened with. Plain DOM writes keep React out of the frame.
    const home = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      fov: camera.fov,
    };
    const indicator = document.createElement("div");
    indicator.className = "cw-stage-viewinfo";
    const readout = document.createElement("span");
    const resetView = document.createElement("button");
    resetView.type = "button";
    resetView.textContent = t("editors.stage.ui.resetView");
    resetView.addEventListener("click", () => {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      camera.fov = home.fov;
      camera.updateProjectionMatrix();
      controls.update();
    });
    indicator.append(readout, resetView);
    container.append(indicator);
    const nameLayer = document.createElement("div");
    nameLayer.className = "cw-stage-names";
    container.append(nameLayer);
    const nameTags = new Map<string, HTMLSpanElement>();
    const syncNameTags = () => {
      const objects = stageRef.current.objects;
      for (const object of objects) {
        let tag = nameTags.get(object.id);
        if (!tag) {
          tag = document.createElement("span");
          tag.className = "cw-stage-name";
          nameTags.set(object.id, tag);
          nameLayer.append(tag);
        }
        if (tag.textContent !== object.name) tag.textContent = object.name;
      }
      for (const [id, tag] of nameTags)
        if (!objects.some((object) => object.id === id)) {
          tag.remove();
          nameTags.delete(id);
        }
    };
    const nameAnchor = new THREE.Vector3();
    const projectNameTags = () => {
      const width = renderer.domElement.width,
        height = renderer.domElement.height;
      for (const [id, tag] of nameTags) {
        const child = root.children.find(
          (candidate) => candidate.userData.objectId === id,
        );
        if (!child) {
          tag.style.display = "none";
          continue;
        }
        child.getWorldPosition(nameAnchor);
        const box = new THREE.Box3().setFromObject(child);
        nameAnchor.y = (box.isEmpty() ? 1 : box.max.y) + 0.25;
        nameAnchor.project(camera);
        const inside =
          nameAnchor.z > -1 &&
          nameAnchor.z < 1 &&
          nameAnchor.x > -1 &&
          nameAnchor.x < 1 &&
          nameAnchor.y > -1 &&
          nameAnchor.y < 1;
        tag.style.display = inside ? "" : "none";
        tag.style.left = `${((nameAnchor.x + 1) / 2) * width}px`;
        tag.style.top = `${((1 - nameAnchor.y) / 2) * height}px`;
      }
    };
    let lastReadout = "";
    let gestureCameraId: string | null = null;
    const orbitStart = () => {
      setPlaying(false);
      playingRef.current = false;
      gestureCameraId = sampleStage(stageRef.current, timeRef.current).cameraId;
    };
    const orbitEnd = () => {
      if (!gestureCameraId) return;
      const id = gestureCameraId;
      gestureCameraId = null;
      const pose = {
        position: vector(camera.position),
        target: vector(controls.target),
        fov: camera.fov,
      };
      gestureEdit.current((current) =>
        editStageCameraAt(current, id, timeRef.current, pose),
      );
    };
    controls.addEventListener("start", orbitStart);
    controls.addEventListener("end", orbitEnd);
    let dragTarget: THREE.Object3D | null = null;
    // Both gizmos share one handler; whichever starts a drag disables its
    // sibling so the released pointer cannot also grab the other gizmo.
    const dragChanged =
      (gizmo: TransformControls, siblings: TransformControls[]) =>
      (event: { value: unknown }) => {
        if (event.value) {
          dragTarget = gizmo.object;
          // The same pointerdown also started an orbit gesture; a drag frozen
          // before any camera move must not commit a pose when it ends.
          gestureCameraId = null;
          setPlaying(false);
          playingRef.current = false;
          controls.enabled = false;
          for (const sibling of siblings) sibling.enabled = false;
          return;
        }
        controls.enabled = true;
        for (const sibling of siblings) sibling.enabled = true;
        // detach() never resets dragging, so this end event can still arrive
        // after undo removed the object, or after a GLTF clone replaced the
        // group; only a live subject commits. A keyframe-free subject places
        // through its base transform; a keyframed one poses at the playhead,
        // exactly like a numeric field edit on the same sampler.
        const group = dragTarget;
        dragTarget = null;
        if (!group || gizmo.object !== group) return;
        const item = stageRef.current.objects.find(
          (entry) => entry.id === group.userData.objectId,
        );
        if (!item) return;
        const pose = {
          position: vector(group.position),
          rotation: vector(group.rotation),
          scale: vector(group.scale),
        };
        gestureEdit.current((current) =>
          item.keyframes.length
            ? editStageObjectAt(current, item.id, timeRef.current, pose)
            : editStageObjectPlacement(current, item.id, pose),
        );
      };
    const translateDragChanged = dragChanged(translate, [rotate, scale]);
    const rotateDragChanged = dragChanged(rotate, [translate, scale]);
    const scaleDragChanged = dragChanged(scale, [translate, rotate]);
    translate.addEventListener("dragging-changed", translateDragChanged);
    rotate.addEventListener("dragging-changed", rotateDragChanged);
    scale.addEventListener("dragging-changed", scaleDragChanged);
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    let start: { x: number; y: number; pointerId: number } | null = null;
    const pointerDown = (event: PointerEvent) => {
      start =
        event.isPrimary && event.button === 0
          ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
          : null;
    };
    const pointerUp = (event: PointerEvent) => {
      const down = start;
      start = null;
      if (
        !down ||
        down.pointerId !== event.pointerId ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
      )
        return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      // An armed preset lands where the click meets the ground plane;
      // placement stays disabled while the viewfinder reframes the view.
      if (pendingPlacementRef.current && !viewfinderRef.current) {
        const hit = raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
          new THREE.Vector3(),
        );
        if (hit) placeRef.current(hit.x, hit.z);
        return;
      }
      let found: THREE.Object3D | undefined = raycaster.intersectObjects(
        root.children,
        true,
      )[0]?.object;
      while (found && !found.userData.objectId)
        found = found.parent ?? undefined;
      if (found) setSelected(found.userData.objectId as string);
    };
    const pointerCancel = () => {
      start = null;
    };
    renderer.domElement.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", pointerCancel);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    // Walk mode: WASD/QE stride, Shift sprints, drag looks, Alt+wheel
    // zooms the eye. Native listeners keep React out of the frame loop
    // and the pose stays viewport-local (no gesture commit fires).
    const walkKeys = new Set<string>();
    const strideKeys = new Set(["w", "a", "s", "d", "q", "e", "shift"]);
    const walkDown = (event: KeyboardEvent) => {
      if (!walkRef.current) return;
      const key = event.key.toLowerCase();
      if (strideKeys.has(key)) {
        walkKeys.add(key);
        event.preventDefault();
      }
    };
    const walkUp = (event: KeyboardEvent) =>
      walkKeys.delete(event.key.toLowerCase());
    let lookDrag: { x: number; y: number } | null = null;
    const lookDown = (event: PointerEvent) => {
      if (walkRef.current && event.button === 0 && event.isPrimary)
        lookDrag = { x: event.clientX, y: event.clientY };
    };
    const lookMove = (event: PointerEvent) => {
      if (!lookDrag) return;
      const dx = event.clientX - lookDrag.x,
        dy = event.clientY - lookDrag.y;
      lookDrag = { x: event.clientX, y: event.clientY };
      const euler = new THREE.Euler().setFromQuaternion(
        camera.quaternion,
        "YXZ",
      );
      euler.y -= dx * 0.004;
      euler.x = THREE.MathUtils.clamp(euler.x - dy * 0.004, -1.5, 1.5);
      camera.quaternion.setFromEuler(euler);
    };
    const lookUp = () => {
      lookDrag = null;
    };
    const walkWheel = (event: WheelEvent) => {
      if (!walkRef.current || !event.altKey) return;
      event.preventDefault();
      camera.fov = THREE.MathUtils.clamp(camera.fov - event.deltaY * 0.05, 10, 120);
      camera.updateProjectionMatrix();
    };
    window.addEventListener("keydown", walkDown);
    window.addEventListener("keyup", walkUp);
    renderer.domElement.addEventListener("pointerdown", lookDown);
    window.addEventListener("pointermove", lookMove);
    window.addEventListener("pointerup", lookUp);
    renderer.domElement.addEventListener("wheel", walkWheel, { passive: false });
    const contextLost = (event: Event) => {
      event.preventDefault();
      setPlaying(false);
      setError(t("editors.stage.ui.webglLost"));
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    let frame = 0;
    const poseCameraFor = (cameraId?: string, aspect?: number) => {
      const size = stageOutputSize(stageRef.current.aspectRatio);
      const pose = cameraId
        ? sampleStageCamera(stageRef.current, cameraId, timeRef.current, t)
        : sampleStage(stageRef.current, timeRef.current).camera;
      pipCamera.aspect = aspect ?? size.width / size.height;
      pipCamera.fov = liveFovRef.current ?? pose.fov;
      pipCamera.position.set(pose.position.x, pose.position.y, pose.position.z);
      applyRoll(pipCamera, pose);
      pipCamera.updateProjectionMatrix();
      pipCamera.updateMatrixWorld(true);
      return pipCamera;
    };
    const render = () => {
      pipCanvas.style.display = "none";
      if (walkRef.current && walkKeys.size) {
        const speed = walkKeys.has("shift") ? 0.15 : 0.05;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3()
          .crossVectors(forward, camera.up)
          .normalize();
        if (walkKeys.has("w")) camera.position.addScaledVector(forward, speed);
        if (walkKeys.has("s")) camera.position.addScaledVector(forward, -speed);
        if (walkKeys.has("a")) camera.position.addScaledVector(right, -speed);
        if (walkKeys.has("d")) camera.position.addScaledVector(right, speed);
        if (walkKeys.has("e")) camera.position.y += speed;
        if (walkKeys.has("q")) camera.position.y -= speed;
      }
      // Viewport-local flags apply every frame: the document keeps its own
      // grid default, helpers never reach captures, and DOM labels follow
      // the orbit view only.
      const flags = viewRef.current;
      const environment = projectStageEnvironment(stageRef.current);
      ground.visible = environment.ground.visible && flags.ground;
      grid.visible = stageRef.current.grid && flags.grid;
      helpers.visible = flags.motionPaths || flags.heightGuides;
      const revealUnderground =
        ground.visible && hasBelowGroundObject(root, objectBounds);
      indicator.style.display = flags.viewIndicator ? "" : "none";
      if (flags.objectNames) {
        syncNameTags();
        projectNameTags();
        nameLayer.style.display = "";
      } else nameLayer.style.display = "none";
      const bar = actionBarRef.current;
      if (bar) {
        const child = root.children.find(
          (candidate) => candidate.userData.objectId === selectedRef.current,
        );
        if (child) {
          child.getWorldPosition(nameAnchor);
          const box = new THREE.Box3().setFromObject(child);
          nameAnchor.y = (box.isEmpty() ? 1 : box.max.y) + 0.45;
          nameAnchor.project(camera);
          const onscreen =
            nameAnchor.z > -1 && nameAnchor.z < 1 && nameAnchor.x > -1 &&
            nameAnchor.x < 1 && nameAnchor.y > -1 && nameAnchor.y < 1;
          bar.style.display = onscreen ? "" : "none";
          bar.style.left = `${((nameAnchor.x + 1) / 2) * renderer.domElement.width}px`;
          bar.style.top = `${((1 - nameAnchor.y) / 2) * renderer.domElement.height}px`;
        } else bar.style.display = "none";
      }
      renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
      if (splitRef.current.open) {
        // Split view: the working orbit keeps the left share, the chosen
        // rig (storyboard falls back to the active sample) fills the
        // right pane at the pane's own aspect.
        const { ratio, cameraId } = splitRef.current;
        const width = renderer.domElement.width;
        const height = renderer.domElement.height;
        const splitWidth = Math.round(width * ratio);
        const paneAspect = (width - splitWidth) / height;
        renderer.setScissorTest(true);
        renderer.setViewport(0, 0, splitWidth, height);
        renderer.setScissor(0, 0, splitWidth, height);
        setStageGroundReveal(ground, revealUnderground);
        renderer.render(scene, camera);
        renderer.setViewport(splitWidth, 0, width - splitWidth, height);
        renderer.setScissor(splitWidth, 0, width - splitWidth, height);
        setStageGroundReveal(ground, false);
        renderer.render(
          scene,
          viewfinderRef.current
            ? camera
            : poseCameraFor(cameraId ?? undefined, paneAspect),
        );
        renderer.setScissorTest(false);
        frame = requestAnimationFrame(render);
        return;
      }
      // Viewfinder renders the stage camera as the main view; the preview
      // pass keeps the orbit view so the working frame is never lost.
      if (viewfinderRef.current) {
        setStageGroundReveal(ground, false);
        renderer.render(scene, poseCameraFor());
      } else {
        setStageGroundReveal(ground, revealUnderground);
        renderer.render(scene, camera);
      }
      if (cameraPreviewRef.current && !viewfinderRef.current) {
        setStageGroundReveal(ground, false);
        const previewCamera = poseCameraFor();
        const cssWidth = renderer.domElement.clientWidth || renderer.domElement.width;
        const pixelRatio = renderer.domElement.width / Math.max(cssWidth, 1);
        const inspectorWidth = (cssWidth >= 1100 ? 300 : 260) * pixelRatio;
        const inset = 16 * pixelRatio;
        const width = Math.min(320 * pixelRatio, renderer.domElement.width * 0.25);
        const height = width / (previewCamera.aspect || 16 / 9);
        const x = renderer.domElement.width - inspectorWidth - inset - width;
        const y = renderer.domElement.height - 68 * pixelRatio - height;
        renderer.setScissorTest(true);
        renderer.setViewport(x, y, width, height);
        renderer.setScissor(x, y, width, height);
        // The main orbit pass populated the depth buffer. Clear only the
        // preview rectangle so the camera pass can draw its own scene.
        renderer.clearDepth();
        renderer.render(scene, previewCamera);
        if (pipContext) {
          const sourceX = Math.round(x);
          const sourceY = Math.round(
            renderer.domElement.height - y - height,
          );
          const sourceWidth = Math.round(width);
          const sourceHeight = Math.round(height);
          pipCanvas.width = sourceWidth;
          pipCanvas.height = sourceHeight;
          pipCanvas.style.display = "block";
          pipCanvas.style.right = `${inspectorWidth / pixelRatio + inset / pixelRatio}px`;
          pipCanvas.style.top = "68px";
          pipCanvas.style.width = `${width / pixelRatio}px`;
          pipCanvas.style.height = `${height / pixelRatio}px`;
          pipContext.clearRect(0, 0, sourceWidth, sourceHeight);
          pipContext.drawImage(
            renderer.domElement,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            sourceWidth,
            sourceHeight,
          );
        }
        renderer.setScissorTest(false);
      }
      // The readout tracks where the eye actually looks, which in roam
      // mode diverges from the parked orbit target.
      const offset = walkRef.current
        ? camera.getWorldDirection(new THREE.Vector3())
        : camera.position.clone().sub(controls.target);
      const pitch = THREE.MathUtils.radToDeg(
        THREE.MathUtils.clamp(offset.y / (offset.length() || 1), -1, 1),
      );
      const yaw = THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z));
      const text = `${pitch.toFixed(0)}° / ${yaw.toFixed(0)}° · FOV ${camera.fov.toFixed(0)}°`;
      if (text !== lastReadout) {
        lastReadout = text;
        readout.textContent = text;
      }
      frame = requestAnimationFrame(render);
    };
    render();
    setReady(true);
    return () => {
      active.current = false;
      exporting.current?.abort();
      setReady(false);
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("start", orbitStart);
      controls.removeEventListener("end", orbitEnd);
      translate.removeEventListener("dragging-changed", translateDragChanged);
      rotate.removeEventListener("dragging-changed", rotateDragChanged);
      scale.removeEventListener("dragging-changed", scaleDragChanged);
      indicator.remove();
      controls.dispose();
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", pointerCancel);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("keydown", walkDown);
      window.removeEventListener("keyup", walkUp);
      renderer.domElement.removeEventListener("pointerdown", lookDown);
      window.removeEventListener("pointermove", lookMove);
      window.removeEventListener("pointerup", lookUp);
      renderer.domElement.removeEventListener("wheel", walkWheel);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      pipCanvas.remove();
      translate.detach();
      translate.dispose();
      rotate.detach();
      rotate.dispose();
      scale.detach();
      scale.dispose();
      disposeObject(scene);
      for (const pending of runtime.current?.assetCache.values() ?? [])
        void pending.then(
          (loaded) => disposeObject(loaded.scene),
          () => undefined,
        );
      for (const url of ownedAssetUrls.current) URL.revokeObjectURL(url);
      ownedAssetUrls.current.clear();
      light.shadow.dispose();
      // Release the context slot immediately: browsers keep disposed
      // contexts counted against their cap until garbage collection.
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    const objects = new Map(stage.objects.map((item) => [item.id, item]));
    for (const child of [...current.root.children]) {
      const item = objects.get(child.userData.objectId as string);
      const sourceChanged =
        item?.kind === "gltf" &&
        child.userData.assetSource !== item.source;
      if (!item || child.userData.objectKind !== item.kind || sourceChanged) {
        current.root.remove(child);
        // Loaded imported clones share GPU resources with the cached scene;
        // placeholders own theirs and must be disposed.
        if (child.userData.objectKind !== "gltf" || child.userData.placeholder)
          disposeObject(child);
        current.imported.delete(child.userData.objectId as string);
      }
    }
    for (const item of stage.objects) {
      const existing = current.root.children.find(
        (child) => child.userData.objectId === item.id,
      );
      if (!existing) current.root.add(buildObject(item));
      else if (item.kind !== "gltf")
        existing.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const materials = Array.isArray(child.material)
              ? child.material
              : [child.material];
            materials.forEach((material) => {
              if (material instanceof THREE.MeshStandardMaterial)
                material.color.set(item.color);
            });
          }
        });
    }
  }, [stage.objects, ready]);
  useEffect(() => {
    const current = runtime.current;
    if (!current || !ready) return;
    let cancelled = false;
    const load = async () => {
      for (const item of stage.objects) {
        if (item.kind !== "gltf") continue;
        if (!item.source) {
          if (item.asset) setError(t("editors.stage.ui.assetUnavailable"));
          continue;
        }
        const existing = current.root.children.find(
          (child) => child.userData.objectId === item.id,
        );
        if (
          existing?.userData.assetSource === item.source &&
          current.imported.has(item.id)
        )
          continue;
        try {
          const cacheKey = item.asset?.assetId ?? item.source;
          let pending = current.assetCache.get(cacheKey);
          if (!pending) {
            pending = loadStageAsset(item.source);
            current.assetCache.set(cacheKey, pending);
            // A failed load must not poison the cache; evict it so a later
            // effect run can retry.
            pending.catch(() => {
              if (current.assetCache.get(cacheKey) === pending)
                current.assetCache.delete(cacheKey);
            });
          }
          const loaded = await pending;
          if (cancelled || !active.current) return;
          const previous = current.root.children.find(
            (child) => child.userData.objectId === item.id,
          );
          if (previous) {
            current.root.remove(previous);
            // A mid-drag model swap kills the drag rather than continuing it
            // on a detached group.
            if (
              previous === current.translate.object ||
              previous === current.rotate.object
            ) {
              current.translate.detach();
              current.rotate.detach();
            }
            if (previous.userData.placeholder) disposeObject(previous);
          }
          const group = cloneImportedAsset(item, loaded);
          current.root.add(group);
          current.imported.set(
            item.id,
            createImportedRuntime(group, loaded.animations),
          );
          const needsThumbnail = !item.thumbnailCapture && !item.thumbnailSource;
          const thumbnailCapture = needsThumbnail
            ? renderStageObjectThumbnailNow(item, loaded)
            : null;
          if (thumbnailCapture) {
            edit((currentStage) => {
              const currentObject = currentStage.objects.find(
                (object) => object.id === item.id,
              );
              if (
                !currentObject ||
                currentObject.thumbnailCapture ||
                currentObject.thumbnailSource
              )
                return currentStage;
              return {
                ...currentStage,
                objects: currentStage.objects.map((object) =>
                  object.id === item.id
                    ? { ...object, thumbnailCapture }
                    : object,
                ),
              };
            });
          }
          if (item.role === "character" && !loaded.animations.length)
            setAssetNotice(t("editors.stage.ui.assetNotice"));
          if (needsThumbnail && !thumbnailCapture)
            setAssetNotice(
              t("editors.stage.ui.thumbnailFailed", { name: item.name }),
            );
          displayPose(current, sampleStage(stageRef.current, timeRef.current));
        } catch {
          if (!cancelled && active.current)
            setError(
              t("editors.stage.ui.assetLoadFailed", { name: item.name }),
            );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [stage.objects, ready, t]);
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    applyStageEnvironment(
      current.scene,
      stageEnvironment,
      stageEnvironment.ground.visible && viewRef.current.ground,
      current.renderer,
    );
    current.grid.visible = stage.grid;
  }, [stage, stageEnvironment, ready]);
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && runtime.current === current && stageEnvironmentRef.current === stageEnvironment;
    void applyStageBackground(current.scene, stageEnvironment, resolveAssetUrl, isCurrent).then((available) => {
      if (isCurrent() && stageEnvironment.backgroundAsset && !available)
        setAssetNotice(t("editors.stage.ui.backgroundAssetUnavailable"));
    });
    return () => { cancelled = true; };
  }, [stageEnvironment, ready, resolveAssetUrl, t]);
  // Rebuild the motion paths and height guides whenever the trajectories
  // or the objects change; visibility itself is a per-frame view flag.
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    disposeObject(current.helpers);
    current.helpers.clear();
    const box = new THREE.Box3();
    for (const object of stage.objects) {
      const child = current.root.children.find(
        (candidate) => candidate.userData.objectId === object.id,
      );
      const moving = object.keyframes.some(
        (frame, index) =>
          index > 0 &&
          (frame.value.position.x !== object.keyframes[0]!.value.position.x ||
            frame.value.position.y !== object.keyframes[0]!.value.position.y ||
            frame.value.position.z !== object.keyframes[0]!.value.position.z),
      );
      if (moving) {
        const points: THREE.Vector3[] = [];
        for (let step = 0; step <= 40; step++) {
          const at = (stage.duration * step) / 40;
          const pose = sampleStage(stage, at).objects.find(
            (item) => item.id === object.id,
          );
          if (pose) points.push(new THREE.Vector3(pose.position.x, 0.02, pose.position.z));
        }
        current.helpers.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: 0x8e76d1 }),
          ),
        );
      }
      if (child) {
        box.setFromObject(child);
        if (!box.isEmpty() && box.max.y > 0.05) {
          const base = object.position;
          current.helpers.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(base.x, 0, base.z),
                new THREE.Vector3(base.x, box.max.y, base.z),
              ]),
              new THREE.LineBasicMaterial({ color: 0x535b76 }),
            ),
          );
        }
      }
    }
  }, [stage, ready]);
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const material = child.material as THREE.MeshStandardMaterial;
        let owner: THREE.Object3D | null = child;
        while (owner && !owner.userData.objectId) owner = owner.parent;
        material.emissive.set(
          owner?.userData.objectId === selected ? "#1e1536" : "#000000",
        );
      }
    });
  }, [selected, stage.objects, ready]);
  useEffect(() => {
    if (!runtime.current) return;
    runtime.current.controls.enabled =
      renderProgress === null && !viewfinder && !walkMode;
    // Leaving the walk mode needs a fresh orbit target ahead of the eye.
    if (prevWalk.current && !walkMode && runtime.current) {
      const forward = new THREE.Vector3();
      runtime.current.camera.getWorldDirection(forward);
      runtime.current.controls.target
        .copy(runtime.current.camera.position)
        .addScaledVector(forward, 5);
    }
    prevWalk.current = walkMode;
  }, [renderProgress, ready, viewfinder, walkMode]);
  useEffect(() => {
    const current = runtime.current;
    if (!current || !ready) return;
    const item = stage.objects.find((entry) => entry.id === selected);
    const group = current.root.children.find(
      (child) => child.userData.objectId === selected,
    );
    const attach = (gizmo: TransformControls, visible: boolean) => {
      if (item && !item.locked && group && renderProgress === null && visible) {
        const helper = gizmo.getHelper();
        if (!helper.parent) current.scene.add(helper);
        gizmo.attach(group);
      } else gizmo.detach();
    };
    attach(current.translate, activeGizmo === "translate");
    attach(current.rotate, activeGizmo === "rotate");
    attach(current.scale, activeGizmo === "scale");
  }, [selected, stage.objects, ready, renderProgress, activeGizmo]);
  useEffect(() => {
    if (!runtime.current) return;
    const size = stageOutputSize(stage.aspectRatio);
    runtime.current.camera.aspect = size.width / size.height;
    const width = mount.current?.clientWidth ?? size.width;
    runtime.current.renderer.setSize(
      width,
      (width * size.height) / size.width,
      false,
    );
    displayPose(runtime.current, sampleStage(stage, time));
  }, [stage, time, ready]);
  useEffect(() => {
    if (!playing || previewMode !== "dynamic") return;
    const initial = timeRef.current,
      start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min(
        stageRef.current.duration,
        initial + (now - start) / 1000,
      );
      setTime(next);
      if (next >= stageRef.current.duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, previewMode]);

  const isCharacter = (item: StageObject) =>
    item.kind === "person" || (item.kind === "gltf" && item.role === "character");
  const isProp = (item: StageObject) => !isCharacter(item);
  const builtinKinds =
    leftTab === "characters"
      ? BUILTIN_CHARACTER_KINDS
      : BUILTIN_OBJECT_KINDS;
  const builtinPlacementTemplates = useMemo(() => {
    const templates = new Map<StageObject["kind"], StageObject>();
    for (const kind of builtinKinds) {
      const template = createStageObjectTemplate(
        kind,
        t(titles[kind]),
        `placement:${kind}`,
      );
      const thumbnailCapture = renderStageObjectThumbnailNow(template);
      templates.set(
        kind,
        thumbnailCapture ? { ...template, thumbnailCapture } : template,
      );
    }
    return templates;
  }, [builtinKinds, t]);
  const existingBuiltinCards = new Map<StageObject["kind"], StageObject>();
  for (const item of stage.objects) {
    if (!existingBuiltinCards.has(item.kind) && item.kind !== "gltf")
      existingBuiltinCards.set(item.kind, item);
  }
  const placementCards = [
    ...builtinKinds.map(
      (kind) => existingBuiltinCards.get(kind) ?? builtinPlacementTemplates.get(kind)!,
    ),
    ...stage.objects.filter(
      (item) =>
        item.kind === "gltf" &&
        (leftTab === "characters" ? isCharacter(item) : isProp(item)),
    ),
  ];
  /** Centers the orbit view on a subject. View-only: no camera pose is
   * committed, so focusing never dirties the document. */
  const focusObject = (id: string) => {
    setSelected(id);
    const current = runtime.current;
    const pose = sampleStage(stageRef.current, timeRef.current).objects.find(
      (item) => item.id === id,
    );
    if (!current || !pose) return;
    const target = new THREE.Vector3(
      pose.position.x,
      pose.position.y + 0.9,
      pose.position.z,
    );
    const offset = current.camera.position
      .clone()
      .sub(current.controls.target)
      .normalize()
      .multiplyScalar(5.5);
    current.controls.target.copy(target);
    current.camera.position.copy(target).add(offset);
    current.controls.update();
  };
  const addObject = (
    kind: StageObject["kind"],
    at?: { x: number; z: number },
    template?: StageObject,
  ) => {
    const id = crypto.randomUUID();
    const source = template?.kind === kind ? template : undefined;
    const templateName =
      source?.name.replace(/\s+\d+$/, "") ?? t(titles[kind]);
    const thumbnailObject: StageObject = {
      ...createStageObjectTemplate(kind, templateName, id),
      ...(source
        ? {
            color: source.color,
            rotation: { ...source.rotation },
            scale: { ...source.scale },
            opacity: source.opacity,
            ...(source.asset ? { asset: { ...source.asset } } : {}),
            ...(source.source ? { source: source.source } : {}),
            ...(source.thumbnailAsset
              ? { thumbnailAsset: { ...source.thumbnailAsset } }
              : {}),
            ...(source.thumbnailCapture
              ? { thumbnailCapture: source.thumbnailCapture }
              : {}),
            ...(source.thumbnailSource
              ? { thumbnailSource: source.thumbnailSource }
              : {}),
            ...(source.role ? { role: source.role } : {}),
            ...(source.format ? { format: source.format } : {}),
            ...(source.animationNames
              ? { animationNames: [...source.animationNames] }
              : {}),
            ...(source.hasAnimation !== undefined
              ? { hasAnimation: source.hasAnimation }
              : {}),
          }
        : {}),
    };
    const thumbnailCapture =
      thumbnailObject.thumbnailCapture ??
      (thumbnailObject.thumbnailSource
        ? undefined
        : renderStageObjectThumbnailNow(thumbnailObject));
    edit((current) => ({
      ...current,
      objects: [
        ...current.objects,
        {
          ...thumbnailObject,
          name: `${templateName} ${current.objects.length + 1}`,
          position: at
            ? { x: at.x, y: 0, z: at.z }
            : { x: current.objects.length * 1.3, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          visible: true,
          locked: false,
          opacity: 1,
          keyframes: [],
          motionClips: [],
          ...(thumbnailCapture ? { thumbnailCapture } : {}),
        },
      ],
    }));
    if (!thumbnailCapture)
      setAssetNotice(
        t("editors.stage.ui.thumbnailFailed", { name: thumbnailObject.name }),
      );
    setSelected(id);
  }
  // Completing a placement is also the first-run teachable moment.
  placeRef.current = (x, z) => {
    const placement = pendingPlacementRef.current;
    if (!placement) return;
    const source = placement.sourceObjectId
      ? stageRef.current.objects.find(
          (item) => item.id === placement.sourceObjectId,
        )
      : undefined;
    setPendingKind(null);
    addObject(placement.objectKind, { x, z }, source);
    if (!helpSeen.current) {
      helpSeen.current = true;
      try {
        localStorage.setItem("opendirector.stageHelp.v1", "seen");
      } catch {
        // Private-mode storages throw; the help just shows again.
      }
      setHelpOpen(true);
    }
  };
  const presetCenter = (): Vector3Value => {
    const subject = sampleStage(stageRef.current, timeRef.current).objects.find(
      (entry) => entry.id === selected,
    );
    if (subject)
      return {
        x: subject.position.x,
        y: subject.position.y + (subject.kind === "person" ? 1.3 : 0.5),
        z: subject.position.z,
      };
    return { x: 0, y: 1, z: 0 };
  };
  const applyCameraPreset = (preset: CameraPresetId) => {
    const center = presetCenter();
    const spec = CAMERA_PRESETS[preset];
    gestureEdit.current((doc) =>
      editStageCameraAt(doc, doc.activeCameraId, timeRef.current, {
        position: {
          x: center.x + spec.offset.x,
          y: center.y + spec.offset.y,
          z: center.z + spec.offset.z,
        },
        target: center,
        fov: spec.fov,
        ...(spec.roll ? { roll: spec.roll } : {}),
      }),
    );
  };
  const commitLiveFov = () => {
    const fov = liveFov.current;
    liveFov.current = null;
    if (fov === null) return;
    gestureEdit.current((doc) =>
      editStageCameraAt(doc, doc.activeCameraId, timeRef.current, {
        ...sampleStage(doc, timeRef.current).camera,
        fov,
      }),
    );
  };
  const duplicateObject = () => {
    if (!selected) return;
    const source = stageRef.current.objects.find(
      (item) => item.id === selected,
    );
    if (!source) return;
    const copy: StageObject = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} 2`,
      position: { ...source.position, x: source.position.x + 1.3 },
      keyframes: [],
    };
    edit((current) => ({ ...current, objects: [...current.objects, copy] }));
    setSelected(copy.id);
  };
  const removeObject = () => {
    if (!selected) return;
    edit((current) => ({
      ...current,
      objects: current.objects.filter((item) => item.id !== selected),
    }));
    setSelected(null);
  };
  const captureKeyframe = () =>
    edit((current) => captureStageFrame(current, timeRef.current));
  /** Capture an encoder-sized frame from the current stage sampler. */
  const captureOutputStill = () => {
    const current = runtime.current;
    if (!current) throw new Error(t("editors.stage.ui.rendererNotReady"));
    const size = stageOutputSize(stageRef.current.aspectRatio);
    const dom = current.renderer.domElement;
    // setSize() takes CSS units while the drawing buffer multiplies by the
    // pixel ratio; save CSS units and pin the ratio to 1 so the still is
    // captured at exactly the encoder resolution on high-DPI displays.
    const previous = current.renderer.getSize(new THREE.Vector2());
    const ratio = current.renderer.getPixelRatio();
    const aspect = current.camera.aspect;
    const environment = projectStageEnvironment(
      parseLocalStageValue(stageRef.current, t),
    );
    const previousGroundVisible = current.scene.getObjectByName(STAGE_GROUND_NAME)?.visible;
    const ground = current.scene.getObjectByName(STAGE_GROUND_NAME);
    const previousGroundReveal =
      ground instanceof THREE.Mesh &&
      ground.material instanceof THREE.MeshStandardMaterial &&
      ground.material.transparent &&
      ground.material.opacity === STAGE_UNDERGROUND_GROUND_OPACITY;
    const previousGridVisible = current.grid.visible;
    const previousBackground = current.scene.background;
    current.renderer.setPixelRatio(1);
    current.renderer.setSize(size.width, size.height, false);
    current.camera.aspect = size.width / size.height;
    current.camera.updateProjectionMatrix();
    const helpers = [current.translate, current.rotate].map((gizmo) => ({
      helper: gizmo.getHelper(),
      visible: gizmo.getHelper().visible,
    }));
    for (const { helper } of helpers) helper.visible = false;
    // Viewport helpers (paths, guides) stay out of the captured frame.
    const helpersVisible = current.helpers.visible;
    current.helpers.visible = false;
    try {
      if (ground instanceof THREE.Mesh) setStageGroundReveal(ground, false);
      applyStageEnvironment(current.scene, environment, undefined, current.renderer);
      if (
        environment.backgroundAsset &&
        previousBackground instanceof THREE.Texture &&
        previousBackground.userData.stageBackgroundAssetId === environment.backgroundAsset.assetId
      )
        current.scene.background = previousBackground;
      current.grid.visible = false;
      displayPose(current, sampleStage(stageRef.current, timeRef.current));
      current.renderer.render(current.scene, current.camera);
      return dom.toDataURL("image/png");
    } finally {
      current.renderer.setPixelRatio(ratio);
      current.renderer.setSize(previous.x, previous.y, false);
      current.camera.aspect = aspect;
      current.camera.updateProjectionMatrix();
      const restoredEnvironment = stageEnvironmentRef.current;
      applyStageEnvironment(
        current.scene,
        restoredEnvironment,
        restoredEnvironment.ground.visible && viewRef.current.ground,
        current.renderer,
      );
      void applyStageBackground(
        current.scene,
        restoredEnvironment,
        resolveAssetUrl,
        () => active.current && runtime.current === current && stageEnvironmentRef.current === restoredEnvironment,
      );
      current.grid.visible = previousGridVisible;
      const restoredGround = current.scene.getObjectByName(STAGE_GROUND_NAME);
      if (restoredGround instanceof THREE.Mesh) {
        if (previousGroundVisible !== undefined)
          restoredGround.visible = previousGroundVisible;
        setStageGroundReveal(restoredGround, previousGroundReveal);
      }
      for (const { helper, visible } of helpers) helper.visible = visible;
      current.helpers.visible = helpersVisible;
      current.renderer.render(current.scene, current.camera);
    }
  };
  /** Captures at the encoder resolution through the shared sampler. The
   * saving state stays visible for the whole render-and-read pass so the
   * shoot button can honestly report in-flight work. */
  const captureStill = async () => {
    if (stillSaving) return;
    setStillSaving(true);
    try {
      // Yield two painted frames so the saving label actually shows before
      // the synchronous render-and-read pass blocks the main thread.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!active.current) return;
      const capture = captureOutputStill();
      setStills((current) => [...current, { id: crypto.randomUUID(), capture }]);
      setAssetNotice(t("editors.stage.ui.stillCaptured"));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.screenshotFailed"),
      );
    } finally {
      setStillSaving(false);
    }
  };
  const stillName = (index: number) =>
    t("editors.stage.ui.stillName", {
      number: String(index + 1).padStart(2, "0"),
    });
  const selectedStillItems = stills.filter((item) =>
    selectedStills.has(item.id),
  );
  const toggleStill = (id: string) =>
    setView({ type: "toggleStillSelection", stillId: id });
  const deleteSelectedStills = () => {
    setStills((current) =>
      current.filter((item) => !selectedStills.has(item.id)),
    );
    setView({ type: "clearStillSelection" });
  };
  const downloadSelectedStills = async () => {
    for (const item of selectedStillItems) {
      const name = `${stillName(stills.indexOf(item))}.png`;
      try {
        if (item.capture) download(item.capture, name, "image/png");
        // Pinned items resolve their bytes from the view-only media URL.
        else if (item.src)
          downloadFile(await (await fetch(item.src)).blob(), name);
      } catch {
        setError(t("editors.stage.ui.stillDownloadFailed"));
      }
    }
  };
  const addSelectedStillsToCanvas = async () => {
    let added = 0;
    try {
      // Publishing needs a committed source: always prepare fresh (save the
      // stage and stills draft, establish the linked publication). Reusing an
      // MP4-era publication would freeze a document without captures made
      // since that render, and the fingerprint gate rejects those stills.
      const publisher = onPrepareRender
        ? await onPrepareRender(
            parseLocalStageValue(stageRef.current, t),
            stills,
          )
        : onRender;
      // What just committed is the new baseline for the close guard and the
      // auto-poster rule. Do not advance it when preparation failed.
      committedStills.current = stills;
      committedStage.current = stageRef.current;
      for (const item of selectedStillItems) {
        try {
          const src = item.capture
            ? item.capture
            : item.src
              ? await mediaBlobDataUrl(
                  await (await fetch(item.src)).blob(),
                  AbortSignal.timeout(30_000),
                )
              : undefined;
          if (!src) continue;
          // One publish per still keeps each image an independent canvas
          // node the user can place and edit on its own.
          if (
            await publisher({
              kind: "image",
              src,
              mimeType: "image/png",
              title: `${node.data.title} · ${stillName(stills.indexOf(item))}`,
              media: { width: outputSize.width, height: outputSize.height },
            })
          )
            added += 1;
        } catch (reason) {
          // A failed publish must not block the remaining stills, but the
          // reason stays visible instead of disappearing silently.
          setError(
            reason instanceof Error
              ? reason.message
              : t("editors.stage.ui.addCanvasFailed"),
          );
        }
      }
      setAssetNotice(
        t("editors.stage.ui.stillsAddedToCanvas", { count: added }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.addCanvasFailed"),
      );
    }
  };
  const previewStill =
    stills.find((item) => item.id === previewStillId) ?? null;
  const openExport = () => {
    // Storyboard is the default exactly when an edit list exists; otherwise
    // the active rig leads the per-camera options.
    setView({
      type: "openExport",
      source: stageRef.current.shots.length
        ? "storyboard"
        : stageRef.current.activeCameraId,
      clarity: exportClarity,
      // Seed the dialog from the persisted document once. Submit reads the
      // dialog state so a user's later FPS choice remains authoritative.
      fps: stage.fps,
    });
  };
  /** mm:ss.d clock matching the export dialog of the reference console.
   * Arithmetic on total tenths so a rounded 59.96s renders 01:00.0, never
   * 00:60.0. */
  const formatClock = (seconds: number) => {
    const tenths = Math.max(0, Math.round(seconds * 10));
    const minutes = Math.floor(tenths / 600);
    const rest = tenths - minutes * 600;
    return `${String(minutes).padStart(2, "0")}:${String(Math.floor(rest / 10)).padStart(2, "0")}.${rest % 10}`;
  };
  const download = (content: string, name: string, mime: string) => {
    downloadFile(
      content.startsWith("data:")
        ? content
        : new Blob([content], { type: mime }),
      name,
    );
  };
  const importStage = async (file: File) => {
    try {
      const next = parseLocalStageValue(JSON.parse(await file.text()), t);
      const foreign = isRegisteredAsset
        ? unregisteredStageAssets(next, isRegisteredAsset)
        : [];
      if (foreign.length)
        throw new Error(
          t("editors.stage.ui.importForeignAssets", {
            names: foreign.map((object) => object.name).join(", "),
          }),
        );
      if (active.current) {
        edit(() => next);
        setTime(0);
        setSelected(next.objects[0]?.id ?? null);
      }
    } catch (reason) {
      if (active.current)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.importFailed"),
        );
    }
  };
  const importAsset = async (file: File) => {
    const lowerName = file.name.toLowerCase();
    let source: string | undefined;
    try {
      if (!lowerName.endsWith(".glb") && !lowerName.endsWith(".gltf"))
        throw new Error(t("editors.stage.ui.assetUnsupported"));
      if (file.size > STAGE_ASSET_MAX_BYTES)
        throw new Error(
          t("editors.stage.ui.assetTooLarge", {
            name: file.name,
            size: STAGE_ASSET_MAX_BYTES / 1024 / 1024,
          }),
        );
      const probed = probeStageAsset(await file.arrayBuffer());
      if (probed === "corrupt")
        throw new Error(t("editors.stage.ui.assetCorrupt", { name: file.name }));
      if (!probed)
        throw new Error(
          t("editors.stage.ui.assetLoadFailed", { name: file.name }),
        );
      if (probed.external)
        throw new Error(t("editors.stage.ui.assetUnsupported"));
      const url = URL.createObjectURL(file);
      source = url;
      ownedAssetUrls.current.add(url);
      let loaded: LoadedStageAsset;
      try {
        // Seed the shared cache so the effect run that follows this edit
        // reuses this load instead of parsing the same blob twice.
        const current = runtime.current;
        const pending = loadStageAsset(url);
        if (current) {
          current.assetCache.set(url, pending);
          pending.catch(() => {
            if (current.assetCache.get(url) === pending)
              current.assetCache.delete(url);
          });
        }
        loaded = await pending;
      } catch (reason) {
        console.debug("stage asset import failed", reason);
        throw new Error(
          t("editors.stage.ui.assetLoadFailed", { name: file.name }),
        );
      }
      const id = crypto.randomUUID();
      const name = file.name.replace(/\.(?:glb|gltf)$/i, "") || file.name;
      const importedObject: StageObject = {
        id,
        kind: "gltf",
        name,
        color: "#b8c5ff",
        role: assetRole,
        format: probed.format,
        source,
        animationNames: loaded.animations.map(
          // Fallback must match the backend probe's animation_{index}.
          (clip, index) => clip.name.trim() || `animation_${index}`,
        ),
        hasAnimation: loaded.animations.length > 0,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        visible: true,
        locked: false,
        opacity: 1,
        keyframes: [],
        motionClips: [],
      };
      const thumbnailCapture = renderStageObjectThumbnailNow(
        importedObject,
        loaded,
      );
      edit((current) => ({
        ...current,
        objects: [
          ...current.objects,
          {
            ...importedObject,
            position: { x: current.objects.length * 1.3, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            visible: true,
            locked: false,
            opacity: 1,
            keyframes: [],
            motionClips: [],
            ...(thumbnailCapture ? { thumbnailCapture } : {}),
          },
        ],
      }));
      setSelected(id);
      setAssetNotice(
        thumbnailCapture
          ? loaded.animations.length
            ? t("editors.stage.ui.assetImported", {
                name,
                animationCount: loaded.animations.length,
              })
            : t("editors.stage.ui.assetImportedStatic", { name })
          : t("editors.stage.ui.thumbnailFailed", { name }),
      );
    } catch (reason) {
      if (source) {
        URL.revokeObjectURL(source);
        ownedAssetUrls.current.delete(source);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.assetLoadFailed", { name: file.name }),
      );
    }
  };

  const renderVideo = async (
    source: string,
    clarity: number,
    fps: number,
  ) => {
    if (!runtime.current) return;
    const previewRuntime = runtime.current;
    const controller = new AbortController();
    exporting.current?.abort();
    exporting.current = controller;
    const exportStage = parseLocalStageValue(stageRef.current, t);
    // The dialog's source choice fixes the camera plan without touching the
    // draft: storyboard mode concatenates the shot list into the exported
    // timeline, a camera rig plays through document time.
    const plan = stageExportPlan(exportStage, source, t);
    const size = stageOutputSize(exportStage.aspectRatio, clarity);
    const directorPlan = {
      cameraSource: source === "storyboard" ? "storyboard" : "camera",
      ...(source === "storyboard" ? {} : { cameraId: source }),
      width: size.width,
      height: size.height,
      durationSeconds: plan.duration,
      frameRate: fps,
    } satisfies DirectorOutputPlanInput;
    setPlaying(false);
    setError("");
    setRendered(null);
    setInserted(false);
    setRenderProgress(0);
    let scene: THREE.Scene | undefined;
    const materials = new Map<THREE.Material, THREE.Material>();
    let renderer: THREE.WebGLRenderer | undefined;
    // The export scene must not contain the placement gizmos; restore them
    // even on abort or throw, but only while this preview runtime still lives.
    const helpers = [previewRuntime.translate, previewRuntime.rotate].map(
      (gizmo) => ({
        helper: gizmo.getHelper(),
        inScene: gizmo.getHelper().parent === previewRuntime.scene,
      }),
    );
    for (const { helper } of helpers) previewRuntime.scene.remove(helper);
    try {
      // The render's publication freezes the stage AND the stills draft:
      // captures made before this render are pinned with it, and the
      // committed baselines advance so the close guard stops nagging.
      renderPublisher.current = onPrepareRender
        ? await onPrepareRender(exportStage, stills, directorPlan)
        : onRender;
      committedStills.current = stills;
      committedStage.current = exportStage;
      controller.signal.throwIfAborted();
      // Snapshot the scene only after preparation: a model whose preview
      // load lands while preparing would otherwise export as its placeholder.
      scene = previewRuntime.scene.clone(true);
      applyStageEnvironment(scene, projectStageEnvironment(exportStage));
      // The export must not contain the viewport helpers either.
      scene.getObjectByName("stage-helpers")?.removeFromParent();
      scene.getObjectByName(STAGE_GRID_NAME)?.removeFromParent();
      const root = scene.getObjectByName("stage-objects")!;
      const renderImported = new Map<string, ImportedRuntime>();
      for (const [id, binding] of previewRuntime.imported) {
        const item = exportStage.objects.find((object) => object.id === id);
        const cloned = root.children.find(
          (child) => child.userData.objectId === id,
        );
        // Clone from the pristine cached scene, not the posed runtime clone,
        // so frames outside motion clips render the authored rest pose.
        const cached = previewRuntime.assetCache.get(
          item?.asset?.assetId ?? item?.source ?? "",
        );
        const source =
          (cached ? await cached.catch(() => undefined) : undefined)?.scene ??
          binding.root.children[0];
        if (!item || !cloned || !source) continue;
        const replacement = cloneImportedAsset(item, {
          scene: source,
          animations: binding.clips,
        });
        root.remove(cloned);
        root.add(replacement);
        renderImported.set(id, createImportedRuntime(replacement, binding.clips));
      }
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const clone = (source: THREE.Material) => {
          let material = materials.get(source);
          if (!material) {
            material = source.clone();
            if (material instanceof THREE.MeshStandardMaterial)
              material.emissive.set("#000000");
            materials.set(source, material);
          }
          return material;
        };
        child.material = Array.isArray(child.material)
          ? child.material.map(clone)
          : clone(child.material);
      });
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(size.width, size.height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      applyStageEnvironment(scene, projectStageEnvironment(exportStage), undefined, renderer);
      await applyStageBackground(scene, projectStageEnvironment(exportStage), resolveAssetUrl);
      renderer.shadowMap.enabled = true;
      const camera = new THREE.PerspectiveCamera(
        45,
        size.width / size.height,
        0.05,
        1000,
      );
      const blob = await encodeMp4({
        canvas: renderer.domElement,
        duration: plan.duration,
        fps,
        signal: controller.signal,
        progress: setRenderProgress,
        draw: (at) => {
          const pose = sampleStage(plan.stage, plan.timeAt(at));
          camera.position.set(
            pose.camera.position.x,
            pose.camera.position.y,
            pose.camera.position.z,
          );
          camera.fov = pose.camera.fov;
          camera.updateProjectionMatrix();
          applyRoll(camera, pose.camera);
          for (const child of root.children) {
            const object = pose.objects.find(
              (item) => item.id === child.userData.objectId,
            );
            if (object) {
              applyTransform(child, object);
              child.visible = object.visible;
              child.traverse((descendant) => {
                if (descendant instanceof THREE.Mesh) {
                  const material = descendant.material as THREE.MeshStandardMaterial;
                  material.transparent = object.opacity < 1 || material.transparent;
                  material.opacity = object.opacity;
                }
              });
              poseJoints(child, object);
              applyImportedAnimation(renderImported, object);
            }
          }
          renderer!.render(scene!, camera);
        },
      });
      if (active.current && !controller.signal.aborted) {
        setRendered(blob);
        setRenderedAt({ width: size.width, height: size.height, fps });
      }
    } catch (reason) {
      if (active.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.exportFailed"),
        );
    } finally {
      for (const { helper, inScene } of helpers)
        if (inScene && previewRuntime === runtime.current)
          previewRuntime.scene.add(helper);
      // Geometry stays shared with the preview; cloned materials, renderer and shadows are export-owned.
      scene?.traverse((child) => {
        if (child instanceof THREE.DirectionalLight) child.shadow.dispose();
      });
      materials.forEach((material) => material.dispose());
      renderer?.forceContextLoss();
      renderer?.dispose();
      if (active.current && exporting.current === controller)
        setRenderProgress(null);
    }
  };
  const insertRender = async () => {
    if (!rendered) return;
    const controller = new AbortController();
    exporting.current = controller;
    setRenderProgress(1);
    try {
      const src = await mediaBlobDataUrl(rendered, controller.signal);
      const media = await withMediaDuration(
        { id: "rendered", kind: "video", title: node.data.title, src },
        controller.signal,
      );
      if (active.current && !controller.signal.aborted) {
        setInserted(
          await (renderPublisher.current ?? onRender)({
            kind: "video",
            src,
            mimeType: "video/mp4",
            title: t("editors.stage.ui.motionTitle", {
              title: node.data.title,
            }),
            media: {
              width: media.width,
              height: media.height,
              durationSeconds: media.durationSeconds,
            },
          }),
        );
      }
    } catch (reason) {
      if (active.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.addCanvasFailed"),
        );
    } finally {
      if (active.current) setRenderProgress(null);
    }
  };
  const applyEdits = () =>
    onApply(
      parseLocalStageValue(stageRef.current, t),
      // The drawer draft is the source of truth: captures, deletions and
      // pinned items all commit as one list. A fresh stage with no history
      // of stills pins a poster so the canvas keeps a preview. The baseline
      // is the last committed state, not the mount-time node props, so a
      // mid-session prepare does not resurrect a deleted drawer.
      stills.length || committedStills.current.length
        ? stills
        : runtime.current
          ? [{ id: crypto.randomUUID(), capture: captureOutputStill() }]
          : stills,
    );
  // Drawer edits (captures, deletions) are unsaved work the close guard
  // must catch even when the stage itself is untouched. Both baselines
  // advance on every mid-session prepare, so a committed export stops
  // counting as unsaved.
  const stillsDirty =
    stills.length !== committedStills.current.length ||
    stills.some(
      (item, index) =>
        item.capture !== committedStills.current[index]?.capture ||
        item.asset?.assetId !== committedStills.current[index]?.asset?.assetId,
    );
  const stageBaseline = committedStage.current ?? loadedStage.current;
  const dirty = stillsDirty || !sameLocalStage(stageBaseline, stage);
  const requestClose = () => {
    if (dirty && !commit.saving) setConfirmingClose(true);
    else commit.close();
  };
  const treeNeedle = treeQuery.trim().toLocaleLowerCase();
  const matchesTreeQuery = (name: string) =>
    !treeNeedle || name.toLocaleLowerCase().includes(treeNeedle);
  const sceneTree = (
    <section className="cw-stage-right-tree-panel cw-stage-right-tree">
      <header className="cw-stage-panel-heading">
        <span className="cw-stage-panel-icon" aria-hidden="true">
          ☷
        </span>
        <h3>{t("editors.stage.ui.objectTreeTitle")}</h3>
      </header>
      <label className="cw-stage-tree-search">
        <span className="cw-stage-visually-hidden">
          {t("editors.stage.ui.objectSearchAria")}
        </span>
        <input
          aria-label={t("editors.stage.ui.objectSearchAria")}
          placeholder={t("editors.stage.ui.objectSearchPlaceholder")}
          value={treeQuery}
          onChange={(event) => setTreeQuery(event.target.value)}
        />
      </label>
      <div className="cw-stage-tree-scroll">
        <div className="cw-stage-tree" role="tree">
          {(
            [
              ["characters", isCharacter, stage.objects.filter(isCharacter)],
              ["objects", isProp, stage.objects.filter(isProp)],
            ] as const
          ).map(([group, _match, items]) => (
            <div key={group} role="group">
              <button
                className="cw-stage-tree-head"
                aria-expanded={treeGroups[group]}
                onClick={() => setView({ type: "toggleTreeGroup", group })}
              >
                <span className="cw-stage-tree-chevron" aria-hidden="true">
                  {treeGroups[group] ? "⌄" : "›"}
                </span>
                {t(
                  `editors.stage.ui.tab${group[0]!.toUpperCase()}${group.slice(1)}` as never,
                )}
                {` (${items.length})`}
              </button>
              {treeGroups[group] &&
                items
                  .filter((item) => matchesTreeQuery(item.name))
                  .map((item) => (
                    <div className="cw-stage-tree-row" key={item.id} role="treeitem">
                      <button
                        aria-selected={selected === item.id}
                        onClick={() => setSelected(item.id)}
                      >
                        <span style={{ background: item.color }} />
                        {item.name}
                      </button>
                      <button
                        className="cw-stage-row-action"
                        aria-label={t("editors.stage.ui.focusObject", {
                          name: item.name,
                        })}
                        onClick={() => focusObject(item.id)}
                      >
                        ◎
                      </button>
                    </div>
                  ))}
            </div>
          ))}
          <div role="group">
            <button
              className="cw-stage-tree-head"
              aria-expanded={treeGroups.cameras}
              onClick={() => setView({ type: "toggleTreeGroup", group: "cameras" })}
            >
              <span className="cw-stage-tree-chevron" aria-hidden="true">
                {treeGroups.cameras ? "⌄" : "›"}
              </span>
              {t("editors.stage.ui.tabCameras")}
              {` (${stage.cameras.length})`}
            </button>
            {treeGroups.cameras &&
              stage.cameras
                .filter((rig) => matchesTreeQuery(rig.name))
                .map((rig) => (
                  <div className="cw-stage-tree-row" key={rig.id} role="treeitem">
                    <button
                      aria-selected={stage.activeCameraId === rig.id}
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          activeCameraId: rig.id,
                        }))
                      }
                    >
                      {rig.name}
                    </button>
                  </div>
                ))}
          </div>
        </div>
      </div>
    </section>
  );
  return (
    <div
      className="cw-domain-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={consoleRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={consoleId}
        tabIndex={-1}
        className={`cw-stage-console${viewfinder ? " is-viewfinder" : ""}`}
        data-preview-mode={previewMode}
        style={
          {
            "--stage-aspect": String(outputSize.width / outputSize.height),
          } as React.CSSProperties
        }
        onPointerDown={(event) => {
          if (!viewMenu) return;
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (
            viewMenuRef.current?.contains(target) ||
            viewSettingsButtonRef.current?.contains(target)
          )
            return;
          setViewMenu(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (pendingPlacementRef.current) setPendingKind(null);
            else requestClose();
          }
          if (event.key === "Tab") {
            const elements = [
              ...(consoleRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
              ) ?? []),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (!first || !last) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === consoleRef.current)
            ) {
              event.preventDefault();
              last.focus();
            }
            if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === consoleRef.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
      {/* The 3D frame is the base layer; every panel floats above it. */}
      <div
        className="cw-stage-scene"
        ref={mount}
        role="img"
        aria-label={t("editors.stage.ui.stageAria")}
      />
      <div
        className="cw-stage-gizmo"
        role="group"
        aria-label={t("editors.stage.ui.gizmoModeAria")}
      >
        {(["translate", "rotate", "scale"] as const).map((axis) => (
          <button
            key={axis}
            data-icon={axis === "translate" ? "↔" : axis === "rotate" ? "⟳" : "↗"}
            aria-pressed={activeGizmo === axis}
            title={axis === "translate" ? "W" : axis === "rotate" ? "E" : "R"}
            onClick={() =>
              setView({ type: "setGizmo", gizmo: axis })
            }
          >
            {t(
              axis === "translate"
                ? "editors.stage.ui.gizmoMove"
                : axis === "rotate"
                  ? "editors.stage.ui.gizmoRotate"
                  : "editors.stage.ui.gizmoScale",
            )}
          </button>
        ))}
        <div className="cw-stage-view-settings-anchor">
          <button
            ref={viewSettingsButtonRef}
            type="button"
            data-icon="◉"
            title={t("editors.stage.ui.viewSettings")}
            aria-label={t("editors.stage.ui.viewSettingsRail")}
            aria-expanded={viewMenu}
            onClick={() => setView({ type: "toggleViewMenu" })}
          >
            {t("editors.stage.ui.viewSettings")}
          </button>
          {viewMenu && (
            <div
              ref={viewMenuRef}
              className="cw-stage-viewmenu"
              role="dialog"
              aria-label={t("editors.stage.ui.viewSettings")}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  event.preventDefault();
                  setViewMenu(false);
                }
              }}
            >
              {(
                [
                  ["ground", "viewGround"],
                  ["grid", "viewGrid"],
                  ["motionPaths", "viewMotionPaths"],
                  ["objectNames", "viewObjectNames"],
                  ["heightGuides", "viewHeightGuides"],
                  ["aspectMask", "aspectMask"],
                  ["viewIndicator", "viewIndicator"],
                ] as const
              ).map(([flag, label]) => (
                <label key={flag}>
                  <input
                    type="checkbox"
                    checked={viewFlags[flag]}
                    onChange={(event) =>
                      setView({
                        type: "setViewFlag",
                        flag,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {t(`editors.stage.ui.${label}` as never)}
                </label>
              ))}
            </div>
          )}
        </div>
        {object?.keyframes.length ? (
          <span className="cw-domain-note">
            {t("editors.stage.ui.gizmoAnimatedHint")}
          </span>
        ) : null}
      </div>
      {viewfinder && (
        <div className="cw-stage-fovbar">
          <label>
            {t("editors.stage.ui.viewfinderFov")}
            <input
              type="range"
              min={20}
              max={110}
              step={1}
              defaultValue={
                sampleStage(stageRef.current, timeRef.current).camera.fov
              }
              onInput={(event) => {
                liveFov.current = Number(
                  (event.target as HTMLInputElement).value,
                );
              }}
              onPointerUp={commitLiveFov}
              onKeyUp={commitLiveFov}
            />
          </label>
        </div>
      )}
      {viewFlags.aspectMask && (
        <div className="cw-stage-mask" aria-hidden="true" />
      )}
      {selected && (
        <div className="cw-stage-actionbar" ref={actionBarRef}>
          <button onClick={duplicateObject}>
            {t("editors.stage.ui.duplicateObject")}
          </button>
          <button onClick={removeObject}>
            {t("editors.stage.ui.deleteObject")}
          </button>
        </div>
      )}
      {pendingKind && (
        <div className="cw-stage-placehint" role="status">
          {t("editors.stage.ui.placeHint", {
            name: t(titles[pendingKind]),
          })}
        </div>
      )}
      {cameraPreview && <div className="cw-stage-pipframe" aria-hidden="true" />}
      {splitView && (
        <>
          {/* The divider owns its pointer stream; the renderer below
           * reads the ratio every frame. */}
          <div
            className="cw-stage-split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editors.stage.ui.splitRatioAria")}
            aria-valuenow={Math.round(splitRatio * 100)}
            tabIndex={0}
            style={{ left: `${splitRatio * 100}%` }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const bounds = mount.current?.getBoundingClientRect();
              if (!bounds) return;
              const next =
                (event.clientX - bounds.left) / bounds.width;
              setSplitRatio(next);
            }}
            onKeyDown={(event) => {
              // Arrow keys nudge the split for keyboard users.
              if (event.key === "ArrowLeft")
                setSplitRatio(splitRatio - 0.05);
              if (event.key === "ArrowRight")
                setSplitRatio(splitRatio + 0.05);
            }}
          />
          <div
            className="cw-stage-split-tabs"
            role="tablist"
            style={{ left: `calc(${splitRatio * 100}% + 10px)` }}
          >
            {stage.shots.length ? (
              <button
                role="tab"
                aria-selected={splitCameraId === null}
                onClick={() => setSplitCameraId(null)}
              >
                {t("editors.stage.ui.exportSourceStoryboard")}
              </button>
            ) : null}
            {stage.cameras.map((rig) => (
              <button
                key={rig.id}
                role="tab"
                aria-selected={splitCameraId === rig.id}
                onClick={() => setSplitCameraId(rig.id)}
              >
                {rig.name}
              </button>
            ))}
            <button
              className="cw-stage-row-action"
              onClick={() => setView({ type: "closeSplit" })}
            >
              {t("editors.stage.ui.splitExit")}
            </button>
          </div>
        </>
      )}
      {drawerOpen && (
        <section
          className="cw-stage-drawer"
          aria-label={t("editors.stage.ui.shotMaterials")}
        >
          <header className="cw-stage-drawer-head">
            <h4>{t("editors.stage.ui.shotMaterials")}</h4>
            <span className="cw-stage-drawer-count">{stills.length}</span>
            <button
              aria-label={t("editors.stage.ui.closeDrawer")}
              onClick={() => setDrawerOpen(false)}
            >
              ×
            </button>
          </header>
          <div className="cw-stage-drawer-toolbar">
            <label>
              <input
                type="checkbox"
                disabled={!stills.length}
                checked={
                  !!stills.length && selectedStills.size === stills.length
                }
                onChange={(event) =>
                  setView({
                    type: "setStillSelection",
                    stillIds: event.target.checked
                      ? stills.map((item) => item.id)
                      : [],
                  })
                }
              />
              {t("editors.stage.ui.selectAllStills")}
            </label>
            <span>
              {t("editors.stage.ui.selectedStillsCount", {
                count: selectedStills.size,
              })}
            </span>
          </div>
          <ul className="cw-stage-drawer-list">
            {stills.map((item, index) => {
              const src = item.capture ?? item.src;
              return (
                <li key={item.id}>
                  <div className="cw-stage-drawer-item">
                    <input
                      type="checkbox"
                      checked={selectedStills.has(item.id)}
                      onChange={() => toggleStill(item.id)}
                      aria-label={stillName(index)}
                    />
                    <button
                      className="cw-stage-drawer-preview"
                      onClick={() => setPreviewStillId(item.id)}
                      disabled={!src}
                      aria-label={t("editors.stage.ui.previewStill", {
                        name: stillName(index),
                      })}
                    >
                      {src ? (
                        <img src={src} alt="" />
                      ) : (
                        <span className="cw-stage-drawer-missing">
                          {t("editors.stage.ui.stillMissing")}
                        </span>
                      )}
                      <span className="cw-stage-drawer-caption">
                        <span>{stillName(index)}</span>
                        <span>{stage.aspectRatio}</span>
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
            {!stills.length && (
              <li className="cw-stage-drawer-empty">
                {t("editors.stage.ui.stillEmpty")}
              </li>
            )}
          </ul>
          <footer className="cw-stage-drawer-actions">
            <button
              disabled={!selectedStills.size}
              onClick={deleteSelectedStills}
            >
              {t("editors.stage.ui.deleteSelectedStills")}
            </button>
            <button
              disabled={!selectedStills.size}
              onClick={() => void downloadSelectedStills()}
            >
              {t("editors.stage.ui.downloadSelectedStills")}
            </button>
            <button
              className="cw-stage-drawer-primary"
              disabled={!selectedStills.size}
              onClick={() => void addSelectedStillsToCanvas()}
            >
              {t("editors.stage.ui.addStillsToCanvas")}
            </button>
          </footer>
        </section>
      )}
      <fieldset className="cw-stage-panels" disabled={renderProgress !== null}>
        <header className="cw-stage-topbar">
          <div className="cw-stage-identity">
            <h2 id={consoleId}>
              {t("editors.stage.ui.brand")}
            </h2>
            <p>
              {t("editors.stage.ui.title", { title: node.data.title })}
              {" · "}
              {t("editors.stage.ui.subtitle")}
            </p>
          </div>
          <div
            className="cw-stage-preview-mode"
            role="group"
            aria-label={t("editors.stage.ui.previewMode")}
          >
            <button
              type="button"
              aria-pressed={previewMode === "static"}
              onClick={() => {
                setView({ type: "setPreviewMode", mode: "static" });
                setPlaying(false);
              }}
            >
              {t("editors.stage.ui.previewModeStatic")}
            </button>
            <button
              type="button"
              aria-pressed={previewMode === "dynamic"}
              onClick={() => {
                setView({ type: "setPreviewMode", mode: "dynamic" });
                setPlaying(false);
              }}
            >
              {t("editors.stage.ui.previewModeDynamic")}
            </button>
          </div>
          <div className="cw-stage-toolbar">
          <button
            data-icon="↶"
            title={t("editors.stage.ui.undo")}
            aria-label={t("editors.stage.ui.undo")}
            disabled={!history.current.past.length || renderProgress !== null}
            onClick={() => navigate("undo")}
          >
            {t("editors.stage.ui.undo")}
          </button>
          <button
            data-icon="↷"
            title={t("editors.stage.ui.redo")}
            aria-label={t("editors.stage.ui.redo")}
            disabled={!history.current.future.length || renderProgress !== null}
            onClick={() => navigate("redo")}
          >
            {t("editors.stage.ui.redo")}
          </button>
          <button
            data-icon="⇩"
            title={t("editors.stage.ui.importJson")}
            aria-label={t("editors.stage.ui.importJson")}
            disabled={renderProgress !== null}
            onClick={() => importInput.current?.click()}
          >
            {t("editors.stage.ui.importJson")}
          </button>
          <button
            data-icon="⇧"
            title={t("editors.stage.ui.exportJson")}
            aria-label={t("editors.stage.ui.exportJson")}
            disabled={renderProgress !== null}
            onClick={() => {
              // Exports carry no model bytes: an import that exists only as a
              // browser URL would become an unopenable object, so name it.
              const unsaved = stageRef.current.objects.filter(
                (object) => object.kind === "gltf" && !object.asset,
              );
              if (unsaved.length) {
                setError(
                  t("editors.stage.ui.exportUnsavedImports", {
                    names: unsaved.map((object) => object.name).join(", "),
                  }),
                );
                return;
              }
              download(
                JSON.stringify(
                  {
                    ...stageRef.current,
                    objects: stageRef.current.objects.map(
                      ({ source: _source, ...object }) => object,
                    ),
                  },
                  null,
                  2,
                ),
                `${node.data.title || "director-stage"}.stage.json`,
                "application/json",
              );
            }}
          >
            {t("editors.stage.ui.exportJson")}
          </button>
          <button
            data-icon="◉"
            title={t("editors.stage.ui.screenshot")}
            aria-label={t("editors.stage.ui.screenshot")}
            disabled={!ready || stillSaving}
            onClick={() => void captureStill()}
          >
            {stillSaving
              ? t("editors.stage.ui.stillSaving")
              : t("editors.stage.ui.screenshot")}
          </button>
          <button
            data-icon="▤"
            title={t("editors.stage.ui.shotMaterials")}
            aria-label={t("editors.stage.ui.shotMaterials")}
            aria-expanded={drawerOpen}
            onClick={() => setView({ type: "toggleDrawer" })}
          >
            {t("editors.stage.ui.shotMaterials")}
            {stills.length ? ` (${stills.length})` : ""}
          </button>
          <button
            data-icon="▶"
            title={t("editors.stage.ui.renderMp4")}
            aria-label={t("editors.stage.ui.renderMp4")}
            disabled={!ready || renderProgress !== null}
            onClick={openExport}
          >
            {t("editors.stage.ui.renderMp4")}
          </button>
          <button
            data-icon="?"
            title={t("editors.stage.ui.shortcuts")}
            aria-label={t("editors.stage.ui.shortcuts")}
            onClick={() => setView({ type: "toggleHelp" })}
          >
            {t("editors.stage.ui.shortcuts")}
          </button>
        </div>
          <span
            className={`cw-stage-chip${dirty ? " is-unsaved" : ""}`}
            aria-live="polite"
          >
            {t(dirty ? "editors.stage.ui.unsavedChip" : "editors.stage.ui.savedChip")}
          </span>
          <button
            data-icon="⌗"
            title={t("editors.stage.ui.viewfinder")}
            aria-label={t("editors.stage.ui.viewfinder")}
            aria-pressed={viewfinder}
            onClick={() => {
              if (!viewfinder) liveFov.current = null;
              setView({ type: "toggleViewfinder" });
            }}
          >
            {t("editors.stage.ui.viewfinder")}
          </button>
          <button
            data-icon="◉"
            title={t("editors.stage.ui.cameraPreview")}
            aria-label={t("editors.stage.ui.cameraPreview")}
            aria-pressed={cameraPreview}
            onClick={() => setView({ type: "toggleCameraPreview" })}
          >
            {t("editors.stage.ui.cameraPreview")}
          </button>
          <button
            data-icon="▣"
            title={t("editors.stage.ui.aspectMask")}
            aria-label={t("editors.stage.ui.aspectMask")}
            aria-pressed={viewFlags.aspectMask}
            onClick={() =>
              setView({ type: "toggleViewFlag", flag: "aspectMask" })
            }
          >
            {t("editors.stage.ui.aspectMask")}
          </button>
          <button
            aria-pressed={walkMode}
            onClick={() => setView({ type: "toggleRoam" })}
          >
            {t("editors.stage.ui.walkMode")}
          </button>
          <div className="cw-stage-topactions">
            <button onClick={requestClose}>{t("common.cancel")}</button>
            <button
              className="cw-domain-primary"
              disabled={node.locked || renderProgress !== null || commit.saving}
              onClick={() => commit.apply(applyEdits)}
            >
              {t("editors.modal.apply")}
            </button>
            <button
              onClick={requestClose}
              aria-label={t("editors.modal.closeAria")}
            >
              ×
            </button>
          </div>
        </header>
        {(commit.error || error) && (
          <p className="cw-stage-error" role="alert">
            {commit.error || error}
          </p>
        )}
        {renderProgress !== null && (
          <div className="cw-render-status" role="status">
            <progress value={renderProgress} max={1} />
            <span>
              {t("editors.stage.ui.renderProgress", {
                percent: Math.round(renderProgress * 100),
              })}
            </span>
            <button onClick={() => exporting.current?.abort()}>
              {t("editors.stage.ui.cancelRender")}
            </button>
          </div>
        )}
        {rendered && (
          <div className="cw-render-status" role="status">
            <span>
              {t("editors.stage.ui.renderDone", {
                width: renderedAt?.width ?? outputSize.width,
                height: renderedAt?.height ?? outputSize.height,
                fps: renderedAt?.fps ?? 30,
              })}
            </span>
            <button
              disabled={renderProgress !== null}
              onClick={() =>
                downloadFile(
                  rendered,
                  downloadFilename(
                    `${node.data.title}-${t("editors.stage.ui.previewSuffix")}`,
                    "video/mp4",
                  ),
                )
              }
            >
              {t("editors.stage.ui.downloadMp4")}
            </button>
            <button
              disabled={renderProgress !== null || node.locked || inserted}
              onClick={() => void insertRender()}
            >
              {inserted
                ? t("editors.stage.ui.addedToCanvas")
                : t("editors.stage.ui.addToCanvas")}
            </button>
          </div>
        )}
        <aside className="cw-stage-left">
          <div className="cw-stage-left-head">
            <h3>
              <span aria-hidden="true">◇</span>
              {t("editors.stage.ui.assetLibrary")}
            </h3>
            <span aria-hidden="true">▣</span>
          </div>
          <label className="cw-stage-asset-search">
            <span className="cw-stage-visually-hidden">
              {t("editors.stage.ui.assetSearchAria")}
            </span>
            <input
              type="search"
              value={assetQuery}
              placeholder={t("editors.stage.ui.assetSearchPlaceholder")}
              aria-label={t("editors.stage.ui.assetSearchAria")}
              onChange={(event) => setAssetQuery(event.target.value)}
            />
          </label>
          <div className="cw-stage-tabs" role="tablist">
            {(["characters", "objects", "cameras", "background"] as const).map(
              (tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={leftTab === tab}
                  onClick={() => setLeftTab(tab)}
                >
                  {t(`editors.stage.ui.tab${tab[0]!.toUpperCase()}${tab.slice(1)}` as never)}
                </button>
              ),
            )}
          </div>
          {(leftTab === "characters" || leftTab === "objects") && (
            <>
              <button
                className="cw-stage-import-button"
                onClick={() => {
                  setAssetRole(leftTab === "characters" ? "character" : "scene");
                  assetInput.current?.click();
                }}
              >
                + {t("editors.stage.ui.importAsset")}
              </button>
              {assetNotice && (
                <p className="cw-domain-note" role="status">
                  {assetNotice}
                </p>
              )}
              <div className="cw-stage-object-list cw-stage-object-grid">
                {placementCards
                  .filter((item) =>
                    item.name.toLocaleLowerCase().includes(
                      assetQuery.trim().toLocaleLowerCase(),
                    ),
                  )
                  .map((item) => {
                    const sourceObjectId = stage.objects.some(
                      (candidate) => candidate.id === item.id,
                    )
                      ? item.id
                      : null;
                    const armed =
                      pendingKind === item.kind &&
                      pendingPlacementSourceId === sourceObjectId;
                    return (
                      <button
                        key={`${item.id}:placement`}
                        data-stage-placement-kind={item.kind}
                        aria-pressed={armed}
                        onClick={() =>
                          setPendingKind(
                            armed ? null : item.kind,
                            armed ? null : sourceObjectId,
                          )
                        }
                      >
                        <StageObjectPreview object={item} />
                        <span className="cw-stage-object-card-name">
                          <span
                            className="cw-stage-object-color"
                            style={{ background: item.color }}
                          />
                          {item.name}
                        </span>
                      </button>
                    );
                  })}
              </div>
              <p className="cw-domain-note" role="status">
                {t("editors.stage.ui.assetPlacementHint")}
              </p>
            </>
          )}
          {leftTab === "cameras" && (
            <>
              <button onClick={addCamera}>{t("editors.stage.ui.addCamera")}</button>
              <div className="cw-stage-object-list cw-stage-camera-list">
                {stage.cameras.map((rig) => (
                  <div className="cw-stage-camera-row" key={rig.id}>
                    <button
                      aria-pressed={stage.activeCameraId === rig.id}
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          activeCameraId: rig.id,
                        }))
                      }
                    >
                      {rig.name}
                    </button>
                    <button
                      className="cw-stage-row-action"
                      aria-label={t("editors.stage.ui.splitPreview", {
                        name: rig.name,
                      })}
                      onClick={() => {
                        setView({ type: "openSplit", cameraId: rig.id });
                      }}
                    >
                      ↗
                    </button>
                  </div>
                ))}
              </div>
              <h4>{t("editors.stage.ui.cameraPresets")}</h4>
              <div className="cw-stage-preset-grid">
                {(Object.keys(CAMERA_PRESETS) as CameraPresetId[]).map(
                  (preset) => (
                    <button key={preset} onClick={() => applyCameraPreset(preset)}>
                      {t(`editors.stage.ui.preset.${preset}` as never)}
                    </button>
                  ),
                )}
              </div>
              <h4>{t("editors.stage.ui.cameraMoves")}</h4>
              <p className="cw-domain-note">
                {t("editors.stage.ui.cameraHint")}
              </p>
            </>
          )}
          {leftTab === "background" && (
            <>
              <label className="cw-domain-field">
                {t("editors.stage.ui.environmentPreset")}
                <select
                  aria-label={t("editors.stage.ui.environmentPreset")}
                  value={stage.environment.preset}
                  onChange={(event) => applyEnvironmentPreset(event.target.value as (typeof STAGE_ENVIRONMENT_PRESETS)[number]["preset"])}
                >
                  {STAGE_ENVIRONMENT_PRESETS.map((preset) => (
                    <option key={preset.preset} value={preset.preset}>
                      {t(`editors.stage.ui.environmentPreset.${preset.preset}` as never)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.background")}
                <input
                  type="color"
                  value={stage.background}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      background: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.backgroundAsset")}
                <select
                  aria-label={t("editors.stage.ui.backgroundAsset")}
                  value={stage.environment.backgroundAsset?.assetId ?? ""}
                  onChange={(event) => {
                    const selected = backgroundAssets?.find((asset) => asset.id === event.target.value);
                    edit((current) => ({
                      ...current,
                      environment: {
                        ...current.environment,
                        backgroundAsset: selected ? assetReference(selected) : null,
                      },
                    }));
                  }}
                >
                  <option value="">{t("editors.stage.ui.backgroundAssetFallback")}</option>
                  {(backgroundAssets ?? []).map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.name}</option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.groundColor")}
                <input
                  aria-label={t("editors.stage.ui.groundColor")}
                  type="color"
                  value={stage.environment.groundColor}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      environment: {
                        ...current.environment,
                        groundColor: event.target.value,
                      },
                    }))
                  }
                />
              </label>
              <label className="cw-domain-checkbox">
                <input
                  aria-label={t("editors.stage.ui.groundVisible")}
                  type="checkbox"
                  checked={stage.environment.groundVisible}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      environment: {
                        ...current.environment,
                        groundVisible: event.target.checked,
                      },
                    }))
                  }
                />
                {t("editors.stage.ui.groundVisible")}
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.exposure")}
                <input
                  aria-label={t("editors.stage.ui.exposure")}
                  type="number"
                  min="0"
                  max="4"
                  step="0.1"
                  value={stage.environment.exposure}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value >= 0 && value <= 4)
                      edit((current) => ({
                        ...current,
                        environment: { ...current.environment, exposure: value },
                      }));
                  }}
                />
              </label>
              <h4>{t("editors.stage.ui.lights")}</h4>
              {stage.lights.map((light) => {
                const roleLabel = t(
                  `editors.stage.ui.light.${light.id}` as never,
                );
                const updateLight = (
                  patch: Partial<typeof light>,
                ) =>
                  edit((current) => ({
                    ...current,
                    lights: current.lights.map((candidate) =>
                      candidate.id === light.id
                        ? { ...candidate, ...patch }
                        : candidate,
                    ),
                  }));
                const updateLightPosition = (
                  axis: keyof Vector3Value,
                  value: number,
                ) =>
                  updateLight({
                    position: { ...light.position, [axis]: value },
                  });
                return (
                  <fieldset className="cw-domain-field" key={light.id}>
                    <legend>{roleLabel}</legend>
                    <label>
                      {t("editors.stage.ui.lightColor", { role: roleLabel })}
                      <input
                        aria-label={t("editors.stage.ui.lightColor", {
                          role: roleLabel,
                        })}
                        type="color"
                        value={light.color}
                        onChange={(event) =>
                          updateLight({ color: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      {t("editors.stage.ui.lightIntensity", {
                        role: roleLabel,
                      })}
                      <input
                        aria-label={t("editors.stage.ui.lightIntensity", {
                          role: roleLabel,
                        })}
                        type="number"
                        min="0"
                        step="0.1"
                        value={light.intensity}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value) && value >= 0)
                            updateLight({ intensity: value });
                        }}
                      />
                    </label>
                    <span>{t("editors.stage.ui.lightPosition", { role: roleLabel })}</span>
                    <div>
                      {(["x", "y", "z"] as const).map((axis) => (
                        <label key={axis}>
                          {axis.toUpperCase()}
                          <input
                            aria-label={t("editors.stage.ui.lightPositionAxis", {
                              role: roleLabel,
                              axis: axis.toUpperCase(),
                            })}
                            type="number"
                            step="0.1"
                            value={light.position[axis]}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (Number.isFinite(value))
                                updateLightPosition(axis, value);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="cw-domain-checkbox">
                      <input
                        aria-label={t("editors.stage.ui.lightCastShadow", {
                          role: roleLabel,
                        })}
                        type="checkbox"
                        checked={light.castShadow}
                        onChange={(event) =>
                          updateLight({ castShadow: event.target.checked })
                        }
                      />
                      {t("editors.stage.ui.lightCastShadow", {
                        role: roleLabel,
                      })}
                    </label>
                  </fieldset>
                );
              })}
              <label className="cw-domain-checkbox">
                <input
                  type="checkbox"
                  checked={stage.grid}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      grid: event.target.checked,
                    }))
                  }
                />
                {t("editors.stage.ui.grid")}
              </label>
              <p className="cw-domain-note">
                {t("editors.stage.ui.orbitHint")}
                <br />
                {t("editors.stage.ui.shortcutHint")}
                <br />
                {t("editors.stage.ui.selectHint")}
              </p>
            </>
          )}
        </aside>
        <aside className="cw-stage-right">
              {sceneTree}
              <section className="cw-stage-inspector">
                <header className="cw-stage-panel-heading">
                  <span className="cw-stage-panel-icon" aria-hidden="true">
                    ☷
                  </span>
                  <h3>{t("editors.stage.ui.properties")}</h3>
                </header>
                <div className="cw-stage-inspector-scroll">
              {object && (
                <section className="cw-stage-inspector-section">
                  <h4>{t("editors.stage.ui.transform")}</h4>
                  <label className="cw-domain-field">
                    {t("editors.stage.ui.name")}
                    <input
                      value={object.name}
                      onChange={(event) =>
                        editObject({ name: event.target.value })
                      }
                    />
                  </label>
                  {object.kind !== "gltf" && (
                    <label className="cw-domain-field">
                      {t("editors.stage.ui.material")}
                      <input
                        type="color"
                        value={object.color}
                        onChange={(event) =>
                          editObject({ color: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {object.kind === "gltf" && (
                    <p className="cw-domain-note" role="status">
                      {object.role === "character"
                        ? t("editors.stage.ui.assetCharacter")
                        : t("editors.stage.ui.assetScene")}
                      {" · "}
                      {object.hasAnimation
                        ? t("editors.stage.ui.assetImported", {
                            name: object.name,
                            animationCount: object.animationNames?.length ?? 0,
                          })
                        : t("editors.stage.ui.assetImportedStatic", {
                            name: object.name,
                          })}
                    </p>
                  )}
                  {(object.kind === "person" ||
                    (object.kind === "gltf" &&
                      object.role === "character" &&
                      object.hasAnimation)) && (
                    <section className="cw-stage-clips">
                      <h4>{t("editors.stage.ui.motionClips")}</h4>
                      <button onClick={addMotionClip}>
                        {t("editors.stage.ui.addMotion")}
                      </button>
                      <p className="cw-domain-note">
                        {t("editors.stage.ui.motionHint")}
                      </p>
                      {object.motionClips.map((clip, index) => (
                        <div className="cw-stage-clip" key={clip.id}>
                          <label>
                            {t("editors.stage.ui.motion", {
                              number: index + 1,
                            })}
                            <select
                              aria-label={t("editors.stage.ui.motionAria", {
                                number: index + 1,
                              })}
                              value={clip.motion.preset}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  motion: {
                                    ...clip.motion,
                                    preset: event.target
                                      .value as keyof typeof STAGE_MOTIONS,
                                  },
                                })
                              }
                            >
                              {Object.entries(STAGE_MOTIONS).map(
                                ([id, label]) => (
                                  <option key={id} value={id}>
                                    {t(label)}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label>
                            {t("editors.stage.ui.startSeconds")}
                            <input
                              aria-label={t(
                                "editors.stage.ui.motionStartAria",
                                { number: index + 1 },
                              )}
                              type="number"
                              min={0}
                              step={0.1}
                              value={clip.start}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  start: Number(event.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.durationSeconds")}
                            <input
                              aria-label={t(
                                "editors.stage.ui.motionDurationAria",
                                { number: index + 1 },
                              )}
                              type="number"
                              min={0.1}
                              step={0.1}
                              value={clip.duration}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  duration: Number(event.target.value),
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.speed")}
                            <input
                              aria-label={t(
                                "editors.stage.ui.motionSpeedAria",
                                { number: index + 1 },
                              )}
                              type="number"
                              min={0.1}
                              step={0.1}
                              value={clip.motion.speed}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  motion: {
                                    ...clip.motion,
                                    speed: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.amplitude")}
                            <input
                              aria-label={t(
                                "editors.stage.ui.motionAmplitudeAria",
                                { number: index + 1 },
                              )}
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={clip.motion.amount}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  motion: {
                                    ...clip.motion,
                                    amount: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          <button
                            onClick={() => {
                              setPlaying(false);
                              setTime(clip.start);
                            }}
                          >
                             {t("editors.stage.ui.locate")}
                          </button>
                          <button
                            onClick={() =>
                              editObject({
                                motionClips: object.motionClips.filter(
                                  (item) => item.id !== clip.id,
                                ),
                              })
                            }
                          >
                            {t("editors.stage.ui.deleteMotion", {
                        number: index + 1,
                      })}
                          </button>
                        </div>
                      ))}
                    </section>
                  )}
                  <VectorFields
                    label={t("editors.stage.ui.position")}
                    value={object.position}
                    onChange={(position) => editObject({ position })}
                  />
                  <VectorFields
                    label={t("editors.stage.ui.rotation")}
                    value={object.rotation}
                    rotation
                    onChange={(rotation) => editObject({ rotation })}
                  />
                  <VectorFields
                    label={t("editors.stage.ui.scale")}
                    value={object.scale}
                    min={0.01}
                    onChange={(scale) => editObject({ scale })}
                  />
                  <button onClick={removeObject}>
                    {t("editors.stage.ui.deleteObject")}
                  </button>
                </section>
              )}
              <section className="cw-stage-inspector-section">
              <h4>
                {t("editors.stage.ui.cameraLabel")}{" "}
                {
                  stage.cameras.find((camera) => camera.id === sampled.cameraId)
                    ?.name
                }
              </h4>
              <label className="cw-domain-field">
                {t("editors.stage.ui.editCamera")}
                <select
                  aria-label={t("editors.stage.ui.editCamera")}
                  value={sampled.cameraId}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      activeCameraId: event.target.value,
                      cameraSource: "camera",
                    }))
                  }
                >
                  {stage.cameras.map((camera) => (
                    <option value={camera.id} key={camera.id}>
                      {camera.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.cameraNameAria")}
                <input
                  aria-label={t("editors.stage.ui.cameraNameAria")}
                  value={
                    stage.cameras.find(
                      (camera) => camera.id === sampled.cameraId,
                    )?.name ?? ""
                  }
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      cameras: current.cameras.map((camera) =>
                        camera.id === sampled.cameraId
                          ? { ...camera, name: event.target.value }
                          : camera,
                      ),
                    }))
                  }
                />
              </label>
              <div className="cw-stage-camera-actions">
                <button onClick={addCamera}>
                  {t("editors.stage.ui.copyCamera")}
                </button>
                <button
                  disabled={
                    stage.cameras.length === 1 ||
                    stage.cameraSource === "storyboard"
                  }
                  onClick={removeCamera}
                >
                  {t("editors.stage.ui.deleteCamera")}
                </button>
              </div>
              <label className="cw-domain-field">
                {t("editors.stage.ui.outputAspect")}
                <select
                  aria-label={t("editors.stage.ui.outputAspectAria")}
                  value={stage.aspectRatio}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      aspectRatio: event.target
                        .value as LocalStageDocument["aspectRatio"],
                    }))
                  }
                >
                  {STAGE_RATIOS.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.source")}
                <select
                  aria-label={t("editors.stage.ui.sourceAria")}
                  value={stage.cameraSource}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      cameraSource: event.target
                        .value as LocalStageDocument["cameraSource"],
                    }))
                  }
                >
                  <option value="camera">
                    {t("editors.stage.ui.currentCamera")}
                  </option>
                  <option value="storyboard">
                    {t("editors.stage.ui.storyboardCut")}
                  </option>
                </select>
              </label>
              <VectorFields
                label={t("editors.stage.ui.cameraShort")}
                value={cameraValue.position}
                onChange={(position) => editCamera({ position })}
              />
              <VectorFields
                label={t("editors.stage.ui.target")}
                value={cameraValue.target}
                onChange={(target) => editCamera({ target })}
              />
              <label className="cw-domain-field">
                {t("editors.stage.ui.focal")}
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={Number(focalLength(cameraValue.fov).toFixed(1))}
                  onChange={(event) => {
                    const focal = Number(event.target.value);
                    if (focal > 0) editCamera({ fov: fovFromFocal(focal) });
                  }}
                />
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.verticalFov", {
                   value: cameraValue.fov.toFixed(1),
                 })}
                <input
                  type="range"
                  min={10}
                  max={120}
                  step={0.1}
                  value={cameraValue.fov}
                  onChange={(event) =>
                    editCamera({ fov: Number(event.target.value) })
                  }
                />
              </label>
              <button
                onClick={() => {
                  setSelected(null);
                  editCamera(defaultStageCamera());
                }}
              >
                {t("editors.stage.ui.resetCamera")}
              </button>
              </section>
            </div>
          </section>
        </aside>
        {previewMode === "dynamic" && (
          <footer className="cw-stage-bottom">
          <div className="cw-stage-transport">
            <button
              disabled={!ready}
              onClick={() => {
                setView({ type: "setPreviewMode", mode: "dynamic" });
                if (time >= stage.duration) setTime(0);
                setPlaying((current) => !current);
              }}
            >
              {playing
                ? t("editors.stage.ui.pause")
                : t("editors.stage.ui.playAction")}
            </button>
            <output>
              {t("editors.stage.ui.time", {
                time: time.toFixed(2),
                duration: stage.duration.toFixed(2),
              })}
            </output>
            <label>
              {t("editors.stage.ui.totalDuration")}
              <input
                aria-label={t("editors.stage.ui.stageDurationAria")}
                type="number"
                min={0.1}
                step={0.5}
                value={stage.duration}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    duration: Number(event.target.value),
                  }))
                }
              />
            </label>
            <button onClick={captureKeyframe} disabled={!ready}>
              {t("editors.stage.ui.recordKeyframe")}
            </button>
          </div>
          <ControlSlider
            aria-label={t("editors.stage.ui.playheadAria")}
            min={0}
            max={stage.duration}
            step={1 / stage.fps}
            value={Math.min(time, stage.duration)}
            onChange={(event) => {
              setPlayhead(Number(event.target.value));
            }}
          />
          <section
            className="cw-stage-track-surface"
            aria-label={t("editors.stage.ui.timelineAria")}
            data-testid="director-stage-timeline"
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              setPlayhead(
                ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) *
                  timeline.duration,
              );
            }}
          >
            <div className="cw-stage-track-ruler" aria-hidden="true">
              <span>{t("editors.stage.ui.timelineTime", { time: "0.0" })}</span>
              <span>
                {t("editors.stage.ui.timelineTime", {
                  time: timeline.duration.toFixed(1),
                })}
              </span>
            </div>
            {timeline.tracks.map((track) => {
              const boundaries = track.points.filter(
                (point) => point.kind === "boundary",
              );
              return (
                <div className="cw-stage-track-row" key={track.id}>
                  <span className="cw-stage-track-label">
                    {timelineTrackLabel(track)}
                  </span>
                  <div
                    className="cw-stage-track-lane"
                    role="presentation"
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setPlayhead(
                        ((event.clientX - bounds.left) /
                          Math.max(bounds.width, 1)) *
                          timeline.duration,
                      );
                    }}
                  >
                    {boundaries.length > 1 &&
                      Array.from({ length: Math.floor(boundaries.length / 2) }).map(
                        (_, index) => {
                          const start = boundaries[index * 2]!.time;
                          const end = boundaries[index * 2 + 1]!.time;
                          return (
                            <span
                              className="cw-stage-track-interval"
                              key={`${track.id}:interval:${start}`}
                              style={{
                                left: `${(start / timelineDuration) * 100}%`,
                                width: `${((end - start) / timelineDuration) * 100}%`,
                              }}
                              aria-hidden="true"
                            />
                          );
                        },
                      )}
                    {track.points.map((point) => (
                      <button
                        className={`cw-stage-track-point is-${point.kind}`}
                        key={point.id}
                        type="button"
                        style={{ left: `${(point.time / timelineDuration) * 100}%` }}
                        aria-label={t("editors.stage.ui.timelinePointAria", {
                          label: timelineTrackLabel(track),
                          time: point.time.toFixed(2),
                        })}
                        aria-pressed={selectedTimelinePoint?.trackId === track.id && selectedTimelinePoint?.pointId === point.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedTimelinePoint({ trackId: track.id, pointId: point.id });
                          setPlayhead(point.time);
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            <span
              className="cw-stage-track-playhead"
              style={{ left: `${(time / Math.max(timeline.duration, 0.001)) * 100}%` }}
              aria-hidden="true"
            />
          </section>
          <output className="cw-stage-active-state" data-testid="director-stage-active-state">
            {activeStateText}
          </output>
          {selectedTimelineTrack && selectedTimelineValue?.kind === "keyframe" &&
            selectedTimelineTrack.sourceId && selectedTimelineTrack.channel && (
            <form
              className="cw-stage-keyframe-editor"
              key={selectedTimelineValue.id}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const vector = isVector(selectedTimelineValue.value)
                  ? {
                      x: Number(form.get("x")),
                      y: Number(form.get("y")),
                      z: Number(form.get("z")),
                    }
                  : Number(form.get("value"));
                const track = selectedTimelineTrack;
                edit((current) => {
                  if (track.kind === "camera-channel") {
                    return editStageCameraChannelAt(
                      current,
                      track.sourceId!,
                      track.channel as keyof StageCameraChannels,
                      selectedTimelineValue.time,
                      vector,
                    );
                  }
                  if (
                    track.channel !== "position" &&
                    track.channel !== "rotation" &&
                    track.channel !== "scale"
                  ) return current;
                  return editStageObjectTransformChannelAt(
                    current,
                    track.sourceId!,
                    track.channel,
                    selectedTimelineValue.time,
                    vector as Vector3Value,
                  );
                });
              }}
            >
              <span>{timelineTrackLabel(selectedTimelineTrack)} · {selectedTimelineValue.time.toFixed(2)}s</span>
              {selectedTimelineVector ? (
                (["x", "y", "z"] as const).map((axis) => (
                  <label key={axis}>
                    {axis}
                    <input name={axis} type="number" step="0.01" defaultValue={selectedTimelineVector[axis]} />
                  </label>
                ))
              ) : (
                <label>
                  {t("editors.stage.ui.keyframeValue")}
                  <input name="value" type="number" step="0.01" defaultValue={String(selectedTimelineValue.value ?? "")} />
                </label>
              )}
              <button type="submit">{t("editors.stage.ui.editKeyframe")}</button>
              <button
                type="button"
                onClick={() => {
                  const target: StageTimelineKeyframeTarget = selectedTimelineTrack.kind === "camera-channel"
                    ? { kind: "camera", sourceId: selectedTimelineTrack.sourceId!, channel: selectedTimelineTrack.channel as keyof StageCameraChannels, pointId: selectedTimelineValue.id }
                    : { kind: "object", sourceId: selectedTimelineTrack.sourceId!, channel: selectedTimelineTrack.channel as "position" | "rotation" | "scale", pointId: selectedTimelineValue.id };
                  edit((current) => removeStageTimelineKeyframe(current, target));
                  setSelectedTimelinePoint(null);
                }}
              >
                {t("editors.stage.ui.deleteSelectedKeyframe")}
              </button>
            </form>
          )}
          <div className="cw-stage-keyframes">
            {frameTimes.map((frame) => (
              <div key={frame}>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setTime(frame);
                  }}
                >
                  {frame.toFixed(2)}s
                </button>
                <button
                  aria-label={t("editors.stage.ui.deleteKeyframe", {
                    frame,
                  })}
                  onClick={() =>
                    edit((current) => removeStageFrame(current, frame))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {!frameTimes.length && (
              <p>
                {t("editors.stage.ui.keyframeHint")}
              </p>
            )}
          </div>
          <section className="cw-stage-storyboard">
            <h3>{t("editors.stage.ui.storyboard")}</h3>
            <button onClick={addShot}>
              {t("editors.stage.ui.addShot")}
            </button>
            <p className="cw-domain-note">
              {t("editors.stage.ui.shotHint")}
            </p>
            {stage.shots.map((shot, index) => (
              <div className="cw-stage-shot" key={shot.id}>
                <label>
                  {t("editors.stage.ui.shot", { number: index + 1 })}
                  <select
                    aria-label={t("editors.stage.ui.shotCameraAria", {
                      number: index + 1,
                    })}
                    value={shot.cameraId}
                    onChange={(event) =>
                      updateShot(shot.id, { cameraId: event.target.value })
                    }
                  >
                    {stage.cameras.map((camera) => (
                      <option key={camera.id} value={camera.id}>
                        {camera.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("editors.stage.ui.startSeconds")}
                  <input
                    aria-label={t("editors.stage.ui.shotStartAria", {
                      number: index + 1,
                    })}
                    type="number"
                    min={0}
                    step={0.1}
                    value={shot.start}
                    onChange={(event) =>
                      updateShot(shot.id, {
                        start: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  {t("editors.stage.ui.durationSeconds")}
                  <input
                    aria-label={t("editors.stage.ui.shotDurationAria", {
                      number: index + 1,
                    })}
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={shot.duration}
                    onChange={(event) =>
                      updateShot(shot.id, {
                        duration: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setTime(shot.start);
                    edit((current) => ({
                      ...current,
                      cameraSource: "storyboard",
                    }));
                  }}
                >
                  {t("editors.stage.ui.locate")}
                </button>
                <button
                  onClick={() =>
                    edit((current) => ({
                      ...current,
                      shots: current.shots.filter(
                        (item) => item.id !== shot.id,
                      ),
                    }))
                  }
                >
                  {t("editors.stage.ui.deleteShot", {
                    number: index + 1,
                  })}
                </button>
              </div>
            ))}
          </section>
          </footer>
        )}
          <input
            className="cw-domain-file-input"
            ref={importInput}
            type="file"
            accept="application/json,.json"
            aria-label={t("editors.stage.ui.importAria")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importStage(file);
              event.target.value = "";
            }}
          />
          <input
            className="cw-domain-file-input"
            ref={assetInput}
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            aria-label={t("editors.stage.ui.importAsset")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importAsset(file);
              event.target.value = "";
            }}
          />
        </fieldset>
        {helpOpen && (
          <div
            ref={nestedDialogRef}
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={t("editors.stage.ui.helpTitle")}
            onKeyDown={(event) =>
              trapNestedDialog(event, () => setHelpOpen(false))
            }
          >
            <section className="cw-stage-help">
              <header className="cw-stage-export-head">
                <h4>{t("editors.stage.ui.helpTitle")}</h4>
                <button
                  type="button"
                  autoFocus
                  aria-label={t("editors.stage.ui.closeHelp")}
                  onClick={() => setHelpOpen(false)}
                >
                  ×
                </button>
              </header>
              <h5>{t("editors.stage.ui.helpViewNav")}</h5>
              <ul>
                <li>{t("editors.stage.ui.helpOrbit")}</li>
                <li>{t("editors.stage.ui.helpPan")}</li>
                <li>{t("editors.stage.ui.helpZoom")}</li>
              </ul>
              <h5>{t("editors.stage.ui.helpEditor")}</h5>
              <ul>
                <li>{t("editors.stage.ui.helpEscape")}</li>
                <li>{t("editors.stage.ui.helpTab")}</li>
              </ul>
            </section>
          </div>
        )}
        {exportOpen && (
          <div
            ref={nestedDialogRef}
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={t("editors.stage.ui.exportVideo")}
            onKeyDown={(event) =>
              trapNestedDialog(event, () => setView({ type: "closeExport" }))
            }
          >
            <form
              className="cw-stage-export"
              onSubmit={(event) => {
                event.preventDefault();
                setView({ type: "closeExport" });
                void renderVideo(exportSource, exportClarity, exportFps);
              }}
            >
              <header className="cw-stage-export-head">
                <h4>{t("editors.stage.ui.exportVideo")}</h4>
                <button
                  type="button"
                  aria-label={t("editors.stage.ui.exportCancel")}
                  onClick={() => setView({ type: "closeExport" })}
                >
                  ×
                </button>
              </header>
              <p className="cw-domain-note">
                {t("editors.stage.ui.exportSubtitle")}
              </p>
              <label className="cw-stage-export-field">
                {t("editors.stage.ui.exportSourceLabel")}
                <select
                  autoFocus
                  value={exportSource}
                  onChange={(event) => setExportSource(event.target.value)}
                >
                  {stage.shots.length ? (
                    <option value="storyboard">
                      {t("editors.stage.ui.exportSourceStoryboard")}
                    </option>
                  ) : null}
                  {stage.cameras.map((camera) => (
                    <option key={camera.id} value={camera.id}>
                      {camera.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="cw-stage-export-grid">
                <span>
                  {t("editors.stage.ui.exportAspectLabel")}:{" "}
                  {stage.aspectRatio} · {exportSize.width} × {exportSize.height}
                </span>
                <span>
                  {t("editors.stage.ui.exportDurationLabel")}:{" "}
                  {formatClock(
                    exportSource === "storyboard"
                      ? stage.shots.reduce(
                          (total, shot) => total + shot.duration,
                          0,
                        )
                      : stage.duration,
                  )}
                </span>
              </div>
              <label className="cw-stage-export-field">
                {t("editors.stage.ui.exportClarityLabel")}
                <select
                  value={exportClarity}
                  onChange={(event) =>
                    setExportClarity(Number(event.target.value))
                  }
                >
                  <option value={1280}>
                    {t("editors.stage.ui.exportClarityStandard")}
                  </option>
                  <option value={1920}>
                    {t("editors.stage.ui.exportClarityHigh")}
                  </option>
                </select>
              </label>
              <label className="cw-stage-export-field">
                {t("editors.stage.ui.exportFpsLabel")}
                <select
                  value={exportFps}
                  onChange={(event) =>
                    setExportFps(Number(event.target.value))
                  }
                >
                  {[24, 25, 30, 50, 60].map((fps) => (
                    <option
                      key={fps}
                      value={fps}
                    >
                      {t("editors.stage.ui.exportFpsOption", { fps })}
                    </option>
                  ))}
                </select>
              </label>
              <p className="cw-domain-note">
                {exportSource === "storyboard"
                  ? t("editors.stage.ui.exportNoteStoryboard")
                  : t("editors.stage.ui.exportNoteCamera", {
                      name:
                        stage.cameras.find(
                          (camera) => camera.id === exportSource,
                        )?.name ?? "",
                    })}
                <br />
                {t("editors.stage.ui.exportNoteClean")}
              </p>
              <footer className="cw-stage-export-actions">
                <button
                  type="button"
                  onClick={() => setView({ type: "closeExport" })}
                >
                  {t("editors.stage.ui.exportCancel")}
                </button>
                <button
                  type="submit"
                  className="cw-stage-drawer-primary"
                  disabled={
                    !exportSource ||
                    (exportSource === "storyboard" && !stage.shots.length)
                  }
                >
                  {t("editors.stage.ui.exportConfirm")}
                </button>
              </footer>
            </form>
          </div>
        )}
        {previewStill && (
          <div
            ref={nestedDialogRef}
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={stillName(stills.indexOf(previewStill))}
            onKeyDown={(event) =>
              trapNestedDialog(event, () => setPreviewStillId(null))
            }
          >
            <figure>
              <img
                src={previewStill.capture ?? previewStill.src}
                alt={stillName(stills.indexOf(previewStill))}
              />
              <figcaption>
                <span>
                  {stillName(stills.indexOf(previewStill))} ·{" "}
                  {stage.aspectRatio}
                </span>
                <button
                  autoFocus
                  onClick={() => setPreviewStillId(null)}
                >
                  {t("editors.stage.ui.closePreview")}
                </button>
              </figcaption>
            </figure>
          </div>
        )}
        {confirmingClose && (
          <div
            ref={nestedDialogRef}
            className="cw-stage-confirm"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            onKeyDown={(event) =>
              trapNestedDialog(event, () => setConfirmingClose(false))
            }
          >
            <div>
              <h3>{t("editors.stage.ui.unsavedTitle")}</h3>
              <button onClick={() => setConfirmingClose(false)}>
                {t("editors.stage.ui.keepEditing")}
              </button>
              <button onClick={commit.close}>
                {t("editors.stage.ui.discardClose")}
              </button>
              <button
                className="cw-domain-primary"
                disabled={commit.saving}
                onClick={() => {
                  setConfirmingClose(false);
                  commit.apply(applyEdits);
                }}
              >
                {t("editors.stage.ui.saveClose")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
export default DirectorStage;
