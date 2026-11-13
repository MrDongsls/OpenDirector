import { useEditorCommit, type EditorApplyResult } from "./useEditorCommit";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedObject } from "three/addons/utils/SkeletonUtils.js";
import type { CanvasNode } from "./model";
import { ControlSlider } from "./ControlSlider";
import {
  createLocalStage,
  parseLocalStageValue,
  sampleStage,
  editStageObjectAt,
  editStageCameraAt,
  captureStageFrame,
  stageFrameTimes,
  removeStageFrame,
  stageOutputSize,
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
  StageAssetFormat,
  StageAssetRole,
  Vector3Value,
} from "./stageDocument";
import {
  commitStageHistory,
  createStageHistory,
  navigateStageHistory,
  type StageHistory,
} from "./stageHistory";
import { EditorModal } from "./EditorModal";
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
    screenshot?: string,
  ) => EditorApplyResult;
  onClose: () => void;
  onRender: (result: LinkedMediaResult) => boolean | Promise<boolean>;
  onPrepareRender?: (
    stage: LocalStageDocument,
  ) => Promise<(result: LinkedMediaResult) => Promise<boolean>>;
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
  assetCache: Map<string, LoadedStageAsset>;
}
const vector = (value: THREE.Vector3): Vector3Value => ({
  x: value.x,
  y: value.y,
  z: value.z,
});
const axes = ["x", "y", "z"] as const;
const titles: Record<StageObject["kind"], MessageKey> = {
  person: "editors.stage.ui.objectPerson",
  box: "editors.stage.ui.objectBox",
  sphere: "editors.stage.ui.objectSphere",
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
  if (value.kind === "gltf") group.userData.assetSource = value.source;
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
type StageAssetProbe = { format: StageAssetFormat; external: boolean };
/** Container and self-containment come from the actual bytes, matching the backend probe. */
function probeStageAsset(buffer: ArrayBuffer): StageAssetProbe | undefined {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const glbVersion = () => view.getUint32(4, true);
  const declaredLength = () => view.getUint32(8, true);
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
          return {
            format: "glb",
            external: !isGltfDocument(document) || hasExternalGltfResources(document),
          };
        } catch {
          return { format: "glb", external: true };
        }
      }
      offset += 8 + length;
    }
    return { format: "glb", external: true };
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
  return (
    <fieldset className="cw-stage-vector">
      <legend>
        {label}
        {rotation ? t("editors.stage.ui.degreesSuffix") : ""}
      </legend>
      {axes.map((axis) => (
        <label key={axis}>
          {axis.toUpperCase()}
          <input
            aria-label={`${label} ${axis.toUpperCase()}`}
            type="number"
            step={rotation ? 5 : 0.1}
            min={min}
            value={Number(
              (rotation
                ? THREE.MathUtils.radToDeg(value[axis])
                : value[axis]
              ).toFixed(3),
            )}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (Number.isFinite(raw) && (min === undefined || raw >= min))
                onChange({
                  ...value,
                  [axis]: rotation ? THREE.MathUtils.degToRad(raw) : raw,
                });
            }}
          />
        </label>
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
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [assetRole, setAssetRole] = useState<StageAssetRole>("character");
  const [assetNotice, setAssetNotice] = useState("");
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
        !target.closest(".cw-stage-dialog") ||
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
      const width = container.clientWidth;
      if (!width) return;
      const size = stageOutputSize(stageRef.current.aspectRatio);
      renderer.setSize(width, (width * size.height) / size.width, false);
      camera.aspect = size.width / size.height;
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
    const render = () => {
      renderer.render(scene, camera);
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
      for (const loaded of runtime.current?.assetCache.values() ?? [])
        disposeObject(loaded.scene);
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
        if (child.userData.objectKind !== "gltf") disposeObject(child);
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
          let loaded = current.assetCache.get(cacheKey);
          if (!loaded) {
            loaded = await loadStageAsset(item.source);
            current.assetCache.set(cacheKey, loaded);
          }
          if (cancelled || !active.current) return;
          const previous = current.root.children.find(
            (child) => child.userData.objectId === item.id,
          );
          if (previous) current.root.remove(previous);
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
    runtime.current.controls.enabled = renderProgress === null;
  }, [renderProgress, ready]);
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
  const screenshot = () => {
    const current = runtime.current;
    if (!current) throw new Error(t("editors.stage.ui.rendererNotReady"));
    displayPose(current, sampleStage(stageRef.current, timeRef.current));
    current.renderer.render(current.scene, current.camera);
    return current.renderer.domElement.toDataURL("image/png");
  };
  const download = (content: string, name: string, mime: string) => {
    downloadFile(
      content.startsWith("data:")
        ? content
        : new Blob([content], { type: mime }),
      name,
    );
  };
  const snapshot = () => {
    try {
      download(
        screenshot(),
        `${node.data.title || "director-stage"}.png`,
        "image/png",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.screenshotFailed"),
      );
    }
  };
  const importStage = async (file: File) => {
    try {
      const next = parseLocalStageValue(JSON.parse(await file.text()), t);
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
      if (!probed)
        throw new Error(
          t("editors.stage.ui.assetLoadFailed", { name: file.name }),
        );
      if (probed.external)
        throw new Error(t("editors.stage.ui.assetUnsupported"));
      source = URL.createObjectURL(file);
      ownedAssetUrls.current.add(source);
      let loaded: LoadedStageAsset;
      try {
        loaded = await loadStageAsset(source);
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
              (clip, index) => clip.name.trim() || `clip-${index + 1}`,
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

  const renderVideo = async () => {
    if (!runtime.current) return;
    const previewRuntime = runtime.current;
    const controller = new AbortController();
    exporting.current?.abort();
    exporting.current = controller;
    const exportStage = parseLocalStageValue(stageRef.current, t);
    setPlaying(false);
    setError("");
    setRendered(null);
    setInserted(false);
    setRenderProgress(0);
    const scene = previewRuntime.scene.clone(true);
    const root = scene.getObjectByName("stage-objects")!;
    const renderImported = new Map<string, ImportedRuntime>();
    for (const [id, binding] of previewRuntime.imported) {
      const item = exportStage.objects.find((object) => object.id === id);
      const cloned = root.children.find(
        (child) => child.userData.objectId === id,
      );
      // Clone from the pristine cached scene, not the posed runtime clone,
      // so frames outside motion clips render the authored rest pose.
      const source =
        previewRuntime.assetCache.get(
          item?.asset?.assetId ?? item?.source ?? "",
        )?.scene ?? binding.root.children[0];
      if (!item || !cloned || !source) continue;
      const replacement = cloneImportedAsset(item, {
        scene: source,
        animations: binding.clips,
      });
      root.remove(cloned);
      root.add(replacement);
      renderImported.set(id, createImportedRuntime(replacement, binding.clips));
    }
    const materials = new Map<THREE.Material, THREE.Material>();
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
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderPublisher.current = onPrepareRender
        ? await onPrepareRender(exportStage)
        : onRender;
      controller.signal.throwIfAborted();
      renderer = new THREE.WebGLRenderer({ antialias: true });
      const size = stageOutputSize(exportStage.aspectRatio);
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
        duration: exportStage.duration,
        fps: 30,
        signal: controller.signal,
        progress: setRenderProgress,
        draw: (at) => {
          const pose = sampleStage(exportStage, at);
          camera.position.set(
            pose.camera.position.x,
            pose.camera.position.y,
            pose.camera.position.z,
          );
          camera.fov = pose.camera.fov;
          camera.updateProjectionMatrix();
          camera.lookAt(
            pose.camera.target.x,
            pose.camera.target.y,
            pose.camera.target.z,
          );
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
          renderer!.render(scene, camera);
        },
      });
      if (active.current && !controller.signal.aborted) setRendered(blob);
    } catch (reason) {
      if (active.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.exportFailed"),
        );
    } finally {
      // Geometry stays shared with the preview; cloned materials, renderer and shadows are export-owned.
      scene.traverse((child) => {
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
  return (
    <EditorModal
      title={t("editors.stage.ui.title", { title: node.data.title })}
      subtitle={t("editors.stage.ui.subtitle")}
      className="cw-stage-dialog"
      onClose={commit.close}
      onApply={() =>
        commit.apply(() =>
          onApply(
            parseLocalStageValue(stageRef.current, t),
            runtime.current ? screenshot() : undefined,
          ),
        )
      }
      disabled={node.locked || renderProgress !== null || commit.saving}
      error={commit.error || error}
      actions={
        <>
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
            onClick={() =>
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
              )
            }
          >
            {t("editors.stage.ui.exportJson")}
          </button>
          <button disabled={!ready} onClick={snapshot}>
            {t("editors.stage.ui.screenshot")}
          </button>
          <button
            disabled={!ready || renderProgress !== null}
            onClick={() => void renderVideo()}
          >
            {t("editors.stage.ui.renderMp4")}
          </button>
        </>
      }
    >
      <div>
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
                width: outputSize.width,
                height: outputSize.height,
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
        <fieldset className="cw-editor-work" disabled={renderProgress !== null}>
          <div className="cw-stage-layout">
            <aside className="cw-stage-objects">
              <h3>{t("editors.stage.ui.sceneObjects")}</h3>
              <div className="cw-stage-add">
                {(["person", "box", "sphere"] as const).map((kind) => (
                  <button key={kind} onClick={() => addObject(kind)}>
                    + {t(titles[kind])}
                  </button>
                ))}
              </div>
              <label className="cw-domain-field">
                {t("editors.stage.ui.assetRole")}
                <select
                  value={assetRole}
                  onChange={(event) =>
                    setAssetRole(event.target.value as StageAssetRole)
                  }
                >
                  <option value="character">
                    {t("editors.stage.ui.assetCharacter")}
                  </option>
                  <option value="scene">
                    {t("editors.stage.ui.assetScene")}
                  </option>
                </select>
              </label>
              <button onClick={() => assetInput.current?.click()}>
                + {t("editors.stage.ui.importAsset")}
              </button>
              {assetNotice && (
                <p className="cw-domain-note" role="status">
                  {assetNotice}
                </p>
              )}
              <div className="cw-stage-object-list">
                {stage.objects.map((item) => (
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
            </aside>
            <section className="cw-stage-center">
              <div
                className="cw-stage-viewport"
                style={{
                  aspectRatio: `${outputSize.width} / ${outputSize.height}`,
                  width: `min(100%, calc(min(55vh, 480px) * ${outputSize.width / outputSize.height}))`,
                }}
                ref={mount}
                role="img"
                aria-label={t("editors.stage.ui.stageAria")}
              />
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
            </section>
            <aside className="cw-stage-inspector">
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
          </div>
          <p className="cw-domain-note">
            {t("editors.stage.ui.footerHint")}
          </p>
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
      </div>
    </EditorModal>
  );
}
export default DirectorStage;
