import type {
  LocalStageDocument,
  StageLight,
  StageLightId,
  StageEnvironmentPreset,
  Vector3Value,
} from "./stageDocument.ts";
import type { AssetRef } from "../contracts/generated.ts";

export const STAGE_GROUND_NAME = "stage-ground";
export const STAGE_GRID_NAME = "stage-grid";
export const STAGE_LIGHT_NAMES: Readonly<Record<StageLightId, string>> = {
  hemisphere: "stage-light-hemisphere",
  key: "stage-light-key",
  fill: "stage-light-fill",
};

export interface StageEnvironmentPresetValues {
  readonly preset: StageEnvironmentPreset;
  readonly background: string;
  readonly groundColor: string;
  readonly groundVisible: boolean;
  readonly exposure: number;
  readonly lights: Readonly<Record<StageLightId, Omit<StageEnvironmentLightDescriptor, "id">>>;
}

/** Stable values materialized by the background-tab selector through the normal edit path. */
export const STAGE_ENVIRONMENT_PRESETS: readonly StageEnvironmentPresetValues[] = [
  {
    preset: "studio", background: "#0d0d0d", groundColor: "#181818", groundVisible: true, exposure: 1,
    lights: {
      hemisphere: { color: "#ffffff", intensity: 2.4, position: { x: 0, y: 1, z: 0 }, castShadow: false },
      key: { color: "#ffffff", intensity: 3.5, position: { x: 5, y: 10, z: 6 }, castShadow: true },
      fill: { color: "#ffffff", intensity: 1.6, position: { x: -6, y: 5, z: -5 }, castShadow: false },
    },
  },
  {
    preset: "warm-sunset", background: "#2a1b24", groundColor: "#33231f", groundVisible: true, exposure: 1.15,
    lights: {
      hemisphere: { color: "#ffd6b0", intensity: 2.8, position: { x: 0, y: 1, z: 0 }, castShadow: false },
      key: { color: "#ffb36b", intensity: 4, position: { x: 5, y: 10, z: 6 }, castShadow: true },
      fill: { color: "#8ab4ff", intensity: 1.2, position: { x: -6, y: 5, z: -5 }, castShadow: false },
    },
  },
  {
    preset: "moonlit", background: "#0b1426", groundColor: "#111827", groundVisible: true, exposure: 0.8,
    lights: {
      hemisphere: { color: "#9fb8ff", intensity: 1.8, position: { x: 0, y: 1, z: 0 }, castShadow: false },
      key: { color: "#b7d0ff", intensity: 2.4, position: { x: -4, y: 8, z: 4 }, castShadow: true },
      fill: { color: "#5570b8", intensity: 1, position: { x: 5, y: 4, z: -5 }, castShadow: false },
    },
  },
];

export interface StageEnvironmentLightDescriptor {
  readonly id: StageLightId;
  readonly color: string;
  readonly intensity: number;
  readonly position: Vector3Value;
  readonly castShadow: boolean;
}

export interface StageEnvironmentDescriptor {
  readonly backgroundColor: string;
  readonly backgroundAsset: AssetRef | null;
  readonly exposure: number;
  readonly ground: {
    readonly color: string;
    readonly visible: boolean;
  };
  readonly lights: Readonly<Record<StageLightId, StageEnvironmentLightDescriptor>>;
}

/** Projects persisted environment facts into the one scene description used by all render adapters. */
export function projectStageEnvironment(
  stage: Pick<LocalStageDocument, "background" | "environment" | "lights">,
): StageEnvironmentDescriptor {
  return {
    backgroundColor: stage.background,
    backgroundAsset: stage.environment.backgroundAsset,
    exposure: stage.environment.exposure,
    ground: {
      color: stage.environment.groundColor,
      visible: stage.environment.groundVisible,
    },
    lights: {
      hemisphere: projectLight(findLight(stage.lights, "hemisphere")),
      key: projectLight(findLight(stage.lights, "key")),
      fill: projectLight(findLight(stage.lights, "fill")),
    },
  };
}

function findLight(lights: readonly StageLight[], id: StageLightId): StageLight {
  const light = lights.find((candidate) => candidate.id === id);
  if (!light) throw new Error(`Missing stage light role: ${id}`);
  return light;
}

function projectLight(light: StageLight): StageEnvironmentLightDescriptor {
  return {
    id: light.id,
    color: light.color,
    intensity: light.intensity,
    position: { ...light.position },
    castShadow: light.castShadow,
  };
}
