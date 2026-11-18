import { useEditorCommit, type EditorApplyResult } from "./useEditorCommit";
import { useEffect, useId, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedObject } from "three/addons/utils/SkeletonUtils.js";
import type { CanvasNode, StageStillItem } from "./model";
import type {
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
import { downloadFile, downloadFilename } from "./assets";
import { withMediaDuration } from "./editorMedia";
import { mediaBlobDataUrl } from "./localMediaRuntime";
import type { LinkedMediaResult } from "./linkedResults";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

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
  root: THREE.Group;
  grid: THREE.GridHelper;
  imported: Map<string, ImportedRuntime>;
  /** In-flight or resolved loads keyed by pinned asset id or source URL, so
   * concurrent effect runs share one load and one set of GPU resources. */
  assetCache: Map<string, Promise<LoadedStageAsset>>;
}
const vector = (value: THREE.Vector3): Vector3Value => ({
  x: value.x,
  y: value.y,
  z: value.z,
});
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
  for (const child of runtime.root.children) {
    const data = pose.objects.find(
      (item) => item.id === child.userData.objectId,
    );
    if (data) {
      applyTransform(child, data);
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
}: DirectorStageProps) {
  const { t } = useI18n();
  const [historyState, setHistoryState] = useState(() =>
    createStageHistory(
      node.data.localStage
        ? parseLocalStageValue(node.data.localStage, t)
        : createLocalStage(t),
    ),
  );
  const commit = useEditorCommit(onClose);
  const stage = historyState.present;
  const history = useRef(historyState);
  const [selected, setSelected] = useState<string | null>(
      () => stage.objects[0]?.id ?? null,
    ),
    [error, setError] = useState(""),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [ready, setReady] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const loadedStage = useRef(historyState.present);
  const consoleRef = useRef<HTMLDivElement>(null);
  const consoleId = useId();
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
  const [assetRole, setAssetRole] = useState<StageAssetRole>("character");
  const [leftTab, setLeftTab] = useState<"characters" | "objects" | "cameras" | "background">("characters");
  const [cameraPreview, setCameraPreview] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  /** Split pane source: null runs the storyboard/active sample. */
  const [splitCameraId, setSplitCameraId] = useState<string | null>(null);
  const splitRef = useRef({
    open: false,
    ratio: 0.5,
    cameraId: null as string | null,
  });
  splitRef.current = { open: splitView, ratio: splitRatio, cameraId: splitCameraId };
  const [aspectMask, setAspectMask] = useState(false);
  const cameraPreviewRef = useRef(false);
  cameraPreviewRef.current = cameraPreview;
  const [viewfinder, setViewfinder] = useState(false);
  const viewfinderRef = useRef(false);
  viewfinderRef.current = viewfinder;
  const [helpOpen, setHelpOpen] = useState(false);
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
   * committed as a whole by the next apply. */
  const [stills, setStills] = useState<StageStillItem[]>(
    node.data.stills ?? [],
  );
  const [stillSaving, setStillSaving] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedStills, setSelectedStills] = useState<Set<string>>(new Set());
  const [previewStillId, setPreviewStillId] = useState<string | null>(null);
  /** Last state a prepare or apply committed. The unsaved-close guard and
   * the auto-poster rule must compare against this, not the mount-time
   * node props, because prepares commit mid-session. */
  const committedStills = useRef<StageStillItem[]>(node.data.stills ?? []);
  const committedStage = useRef<LocalStageDocument | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  /** "storyboard" or a camera rig id; fixed when the dialog opens. */
  const [exportSource, setExportSource] = useState("");
  const [exportClarity, setExportClarity] = useState(1280);
  const [exportFps, setExportFps] = useState(30);
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
  const object = sampled.objects.find((item) => item.id === selected);
  const cameraValue = sampled.camera;
  const outputSize = stageOutputSize(stage.aspectRatio);
  const exportSize = stageOutputSize(stage.aspectRatio, exportClarity);
  const frameTimes = stageFrameTimes(stage);
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
  const navigate = (direction: "undo" | "redo") => {
    if (renderProgress !== null) return;
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
      }
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
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
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
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000),
      controls = new OrbitControls(camera, renderer.domElement),
      root = new THREE.Group();
    controls.enableDamping = false;
    controls.minDistance = 0.2;
    controls.maxDistance = 200;
    root.name = "stage-objects";
    scene.add(root);
    const grid = new THREE.GridHelper(30, 30, 0x535b76, 0x2b344b);
    scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x202737, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);
    scene.add(new THREE.HemisphereLight(0xe2e7ff, 0x3c3354, 2.6));
    const light = new THREE.DirectionalLight(0xffffff, 3.5);
    light.position.set(5, 10, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0x8d88ff, 1.8);
    fill.position.set(-6, 5, -5);
    scene.add(fill);
    const pipCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000);
    const current: StageRuntime = {
      renderer,
      scene,
      camera,
      controls,
      root,
      grid,
      imported: new Map(),
      assetCache: new Map(),
    };
    runtime.current = current;
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
      return pipCamera;
    };
    const render = () => {
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
        renderer.render(scene, camera);
        renderer.setViewport(splitWidth, 0, width - splitWidth, height);
        renderer.setScissor(splitWidth, 0, width - splitWidth, height);
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
        renderer.render(scene, poseCameraFor());
      } else {
        renderer.render(scene, camera);
      }
      if (cameraPreviewRef.current) {
        const previewCamera = viewfinderRef.current ? camera : poseCameraFor();
        previewCamera.aspect ??= camera.aspect;
        const width = Math.min(320, renderer.domElement.width * 0.25);
        const height = width / (previewCamera.aspect || 16 / 9);
        const x = renderer.domElement.width - width - 12;
        const y = renderer.domElement.height - height - 64;
        renderer.setScissorTest(true);
        renderer.setViewport(x, y, width, height);
        renderer.setScissor(x, y, width, height);
        renderer.render(scene, previewCamera);
        renderer.setScissorTest(false);
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
      controls.dispose();
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", pointerCancel);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      disposeObject(scene);
      for (const pending of runtime.current?.assetCache.values() ?? [])
        void pending.then(
          (loaded) => disposeObject(loaded.scene),
          () => undefined,
        );
      for (const url of ownedAssetUrls.current) URL.revokeObjectURL(url);
      ownedAssetUrls.current.clear();
      light.shadow.dispose();
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
            if (previous.userData.placeholder) disposeObject(previous);
          }
          const group = cloneImportedAsset(item, loaded);
          current.root.add(group);
          current.imported.set(
            item.id,
            createImportedRuntime(group, loaded.animations),
          );
          if (item.role === "character" && !loaded.animations.length)
            setAssetNotice(t("editors.stage.ui.assetNotice"));
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
    current.scene.background = new THREE.Color(stage.background);
    current.grid.visible = stage.grid;
  }, [stage.background, stage.grid, ready]);
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
    runtime.current.controls.enabled = renderProgress === null && !viewfinder;
  }, [renderProgress, ready, viewfinder]);
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
    if (!playing) return;
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
  }, [playing]);

  const addObject = (kind: StageObject["kind"]) => {
    const id = crypto.randomUUID();
    edit((current) => ({
      ...current,
      objects: [
        ...current.objects,
        {
          id,
          kind,
          name: `${t(titles[kind])} ${current.objects.length + 1}`,
          color:
            kind === "person"
              ? "#a09af9"
              : kind === "box"
                ? "#80c9c0"
                : "#e6aa6b",
          position: { x: current.objects.length * 1.3, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          keyframes: [],
          motionClips: [],
        },
      ],
    }));
    setSelected(id);
    // First object in this browser: surface the console controls once so
    // the keyboard and mouse bindings are discoverable before the scene
    // grows. When two-step placement lands, the trigger moves there.
    if (!helpSeen.current) {
      helpSeen.current = true;
      try {
        localStorage.setItem("opendirector.stageHelp.v1", "seen");
      } catch {
        // Private-mode storages throw; the help just shows again.
      }
      setHelpOpen(true);
    }
  }
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
  /** Same sampler and output frame as the MP4 render, at the encoder aspect. */
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
    current.renderer.setPixelRatio(1);
    current.renderer.setSize(size.width, size.height, false);
    current.camera.aspect = size.width / size.height;
    current.camera.updateProjectionMatrix();
    try {
      displayPose(current, sampleStage(stageRef.current, timeRef.current));
      current.renderer.render(current.scene, current.camera);
      return dom.toDataURL("image/png");
    } finally {
      current.renderer.setPixelRatio(ratio);
      current.renderer.setSize(previous.x, previous.y, false);
      current.camera.aspect = aspect;
      current.camera.updateProjectionMatrix();
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
    setSelectedStills((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const deleteSelectedStills = () => {
    setStills((current) =>
      current.filter((item) => !selectedStills.has(item.id)),
    );
    setPreviewStillId((id) => (id && selectedStills.has(id) ? null : id));
    setSelectedStills(new Set());
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
    setExportSource(
      stageRef.current.shots.length
        ? "storyboard"
        : stageRef.current.activeCameraId,
    );
    setExportOpen(true);
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
      edit((current) => ({
        ...current,
        objects: [
          ...current.objects,
          {
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
            position: { x: current.objects.length * 1.3, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            keyframes: [],
            motionClips: [],
          },
        ],
      }));
      setSelected(id);
      setAssetNotice(
        loaded.animations.length
          ? t("editors.stage.ui.assetImported", {
              name,
              animationCount: loaded.animations.length,
            })
          : t("editors.stage.ui.assetImportedStatic", { name }),
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
      // Geometry stays shared with the preview; cloned materials, renderer and shadows are export-owned.
      scene?.traverse((child) => {
        if (child instanceof THREE.DirectionalLight) child.shadow.dispose();
      });
      materials.forEach((material) => material.dispose());
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
        className="cw-stage-console"
        style={
          {
            "--stage-aspect": String(outputSize.width / outputSize.height),
          } as React.CSSProperties
        }
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            requestClose();
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
      {aspectMask && <div className="cw-stage-mask" aria-hidden="true" />}
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
              setSplitRatio(Math.min(0.8, Math.max(0.2, next)));
            }}
            onKeyDown={(event) => {
              // Arrow keys nudge the split for keyboard users.
              if (event.key === "ArrowLeft")
                setSplitRatio((ratio) => Math.max(0.2, ratio - 0.05));
              if (event.key === "ArrowRight")
                setSplitRatio((ratio) => Math.min(0.8, ratio + 0.05));
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
              onClick={() => setSplitView(false)}
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
                  setSelectedStills(
                    event.target.checked
                      ? new Set(stills.map((item) => item.id))
                      : new Set(),
                  )
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
              {t("editors.stage.ui.title", { title: node.data.title })}
            </h2>
            <p>{t("editors.stage.ui.subtitle")}</p>
          </div>
          <div className="cw-stage-toolbar">
          <button
            disabled={!history.current.past.length || renderProgress !== null}
            onClick={() => navigate("undo")}
          >
            {t("editors.stage.ui.undo")}
          </button>
          <button
            disabled={!history.current.future.length || renderProgress !== null}
            onClick={() => navigate("redo")}
          >
            {t("editors.stage.ui.redo")}
          </button>
          <button
            disabled={renderProgress !== null}
            onClick={() => importInput.current?.click()}
          >
            {t("editors.stage.ui.importJson")}
          </button>
          <button
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
            disabled={!ready || stillSaving}
            onClick={() => void captureStill()}
          >
            {stillSaving
              ? t("editors.stage.ui.stillSaving")
              : t("editors.stage.ui.screenshot")}
          </button>
          <button
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {t("editors.stage.ui.shotMaterials")}
            {stills.length ? ` (${stills.length})` : ""}
          </button>
          <button
            disabled={!ready || renderProgress !== null}
            onClick={openExport}
          >
            {t("editors.stage.ui.renderMp4")}
          </button>
          <button onClick={() => setHelpOpen((open) => !open)}>
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
            aria-pressed={viewfinder}
            onClick={() => {
              setViewfinder((current) => {
                const next = !current;
                if (next) {
                  liveFov.current = null;
                  setCameraPreview(true);
                  setAspectMask(true);
                }
                return next;
              });
            }}
          >
            {t("editors.stage.ui.viewfinder")}
          </button>
          <button
            aria-pressed={cameraPreview}
            onClick={() => setCameraPreview((current) => !current)}
          >
            {t("editors.stage.ui.cameraPreview")}
          </button>
          <button
            aria-pressed={aspectMask}
            onClick={() => setAspectMask((current) => !current)}
          >
            {t("editors.stage.ui.aspectMask")}
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
              <div className="cw-stage-add">
                {leftTab === "characters" ? (
                  <button onClick={() => addObject("person")}>
                    + {t(titles.person)}
                  </button>
                ) : (
                  (
                    [
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
                    ] as const
                  ).map((kind) => (
                    <button key={kind} onClick={() => addObject(kind)}>
                      + {t(titles[kind])}
                    </button>
                  ))
                )}
              </div>
              <button
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
              <div className="cw-stage-object-list">
                {stage.objects
                  .filter((item) =>
                    leftTab === "characters"
                      ? item.kind === "person" ||
                        (item.kind === "gltf" && item.role === "character")
                      : item.kind !== "person" &&
                        !(item.kind === "gltf" && item.role === "character"),
                  )
                  .map((item) => (
                    <button
                      key={item.id}
                      aria-pressed={selected === item.id}
                      onClick={() => setSelected(item.id)}
                    >
                      <span style={{ background: item.color }} />
                      {item.name}
                    </button>
                  ))}
              </div>
            </>
          )}
          {leftTab === "cameras" && (
            <>
              <button onClick={addCamera}>{t("editors.stage.ui.addCamera")}</button>
              <div className="cw-stage-object-list">
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
                        setSplitCameraId(rig.id);
                        setSplitView(true);
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
                {t("editors.stage.ui.selectHint")}
              </p>
            </>
          )}
            </aside>
            <aside className="cw-stage-right">
              <h3>
                {object
                  ? t("editors.stage.ui.transform")
                  : t("editors.stage.ui.camera")}
              </h3>
              {object && (
                <>
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
                      <h3>{t("editors.stage.ui.motionClips")}</h3>
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
                </>
              )}
              <h3>
                {t("editors.stage.ui.cameraLabel")}{" "}
                {
                  stage.cameras.find((camera) => camera.id === sampled.cameraId)
                    ?.name
                }
              </h3>
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
        </aside>
        <footer className="cw-stage-bottom">
          <div className="cw-stage-transport">
            <button
              disabled={!ready}
              onClick={() => {
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
            step={0.01}
            value={Math.min(time, stage.duration)}
            onChange={(event) => {
              setPlaying(false);
              setTime(Number(event.target.value));
            }}
          />
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
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t("editors.stage.ui.helpTitle")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Child dialogs own their Escape; letting it bubble would
                // close (or guard-close) the whole stage editor.
                event.stopPropagation();
                event.preventDefault();
                setHelpOpen(false);
              }
            }}
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
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t("editors.stage.ui.exportVideo")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Child dialogs own their Escape; letting it bubble would
                // close (or guard-close) the whole stage editor.
                event.stopPropagation();
                event.preventDefault();
                setExportOpen(false);
              }
            }}
          >
            <form
              className="cw-stage-export"
              onSubmit={(event) => {
                event.preventDefault();
                setExportOpen(false);
                void renderVideo(exportSource, exportClarity, exportFps);
              }}
            >
              <header className="cw-stage-export-head">
                <h4>{t("editors.stage.ui.exportVideo")}</h4>
                <button
                  type="button"
                  aria-label={t("editors.stage.ui.exportCancel")}
                  onClick={() => setExportOpen(false)}
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
                <button type="button" onClick={() => setExportOpen(false)}>
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
            className="cw-stage-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={stillName(stills.indexOf(previewStill))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Child dialogs own their Escape; letting it bubble would
                // close (or guard-close) the whole stage editor.
                event.stopPropagation();
                event.preventDefault();
                setPreviewStillId(null);
              }
            }}
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
          <div className="cw-stage-confirm" role="dialog" aria-modal="true">
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
