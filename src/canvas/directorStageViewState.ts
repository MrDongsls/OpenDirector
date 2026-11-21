import type { StageAssetRole, StageObject } from "./stageDocument.ts";

export type DirectorStageLeftTab =
  | "characters"
  | "objects"
  | "cameras"
  | "background";

export type DirectorStageTreeGroup = "characters" | "objects" | "cameras";

export type DirectorStageViewFlag =
  | "ground"
  | "grid"
  | "motionPaths"
  | "objectNames"
  | "heightGuides"
  | "aspectMask"
  | "viewIndicator";

export type DirectorStageGizmo = "translate" | "rotate" | "scale";

export type DirectorStagePreviewMode = "static" | "dynamic";

export type DirectorStageFocusedSurface =
  | "console"
  | "viewport"
  | "library"
  | "tree"
  | "inspector"
  | "timeline"
  | "drawer"
  | "dialog";

/** Mutually exclusive interaction modes. Display options live separately so
 * camera preview and split view can retain their current independent behavior. */
export type DirectorStageInteractionMode =
  | { kind: "edit" }
  | { kind: "viewfinder" }
  | { kind: "roam" }
  | {
      kind: "placement";
      objectKind: StageObject["kind"];
      sourceObjectId: string | null;
    }

export interface DirectorStageViewFlags {
  ground: boolean;
  grid: boolean;
  motionPaths: boolean;
  objectNames: boolean;
  heightGuides: boolean;
  aspectMask: boolean;
  viewIndicator: boolean;
}

export type DirectorStageSplitView =
  | { kind: "closed"; ratio: number }
  | { kind: "open"; ratio: number; cameraId: string | null };

export type DirectorStageExportDialog =
  | {
      kind: "closed";
      source: string;
      clarity: number;
      fps: number;
    }
  | {
      kind: "open";
      source: string;
      clarity: number;
      fps: number;
    };

export interface DirectorStageViewState {
  selectedObjectId: string | null;
  focusedSurface: DirectorStageFocusedSurface;
  interactionMode: DirectorStageInteractionMode;
  cameraPreview: boolean;
  /** Ephemeral sampling preference; never part of LocalStageDocument. */
  previewMode: DirectorStagePreviewMode;
  splitView: DirectorStageSplitView;
  viewFlags: DirectorStageViewFlags;
  viewMenuOpen: boolean;
  leftTab: DirectorStageLeftTab;
  assetRole: StageAssetRole;
  treeGroups: Record<DirectorStageTreeGroup, boolean>;
  helpOpen: boolean;
  drawerOpen: boolean;
  selectedStillIds: ReadonlySet<string>;
  previewStillId: string | null;
  exportDialog: DirectorStageExportDialog;
  activeGizmo: DirectorStageGizmo;
}

export type DirectorStageViewAction =
  | { type: "selectObject"; objectId: string | null }
  | { type: "focusSurface"; surface: DirectorStageFocusedSurface }
  | { type: "toggleCameraPreview" }
  | { type: "setCameraPreview"; enabled: boolean }
  | { type: "setPreviewMode"; mode: DirectorStagePreviewMode }
  | { type: "toggleViewfinder" }
  | { type: "toggleRoam" }
  | {
      type: "armPlacement";
      objectKind: StageObject["kind"];
      sourceObjectId: string | null;
    }
  | { type: "cancelPlacement" }
  | { type: "openSplit"; cameraId: string | null; ratio?: number }
  | { type: "closeSplit" }
  | { type: "setSplitRatio"; ratio: number }
  | { type: "setSplitCamera"; cameraId: string | null }
  | { type: "toggleViewFlag"; flag: DirectorStageViewFlag }
  | {
      type: "setViewFlag";
      flag: DirectorStageViewFlag;
      enabled: boolean;
    }
  | { type: "toggleViewMenu" }
  | { type: "setViewMenu"; open: boolean }
  | { type: "setLeftTab"; tab: DirectorStageLeftTab }
  | { type: "setAssetRole"; role: StageAssetRole }
  | { type: "toggleTreeGroup"; group: DirectorStageTreeGroup }
  | {
      type: "setTreeGroup";
      group: DirectorStageTreeGroup;
      expanded: boolean;
    }
  | { type: "toggleHelp" }
  | { type: "setHelp"; open: boolean }
  | { type: "toggleDrawer" }
  | { type: "setDrawer"; open: boolean }
  | { type: "toggleStillSelection"; stillId: string }
  | { type: "setStillSelection"; stillIds: readonly string[] }
  | { type: "clearStillSelection" }
  | { type: "setPreviewStill"; stillId: string | null }
  | {
      type: "openExport";
      source: string;
      clarity: number;
      fps: number;
    }
  | { type: "closeExport" }
  | { type: "setExportSource"; source: string }
  | { type: "setExportClarity"; clarity: number }
  | { type: "setExportFps"; fps: number }
  | { type: "setGizmo"; gizmo: DirectorStageGizmo };

const DEFAULT_VIEW_FLAGS: DirectorStageViewFlags = {
  ground: true,
  grid: true,
  motionPaths: false,
  objectNames: true,
  heightGuides: false,
  aspectMask: false,
  viewIndicator: true,
};

const DEFAULT_TREE_GROUPS: Record<DirectorStageTreeGroup, boolean> = {
  characters: true,
  objects: true,
  cameras: true,
};

export function createDirectorStageViewState(
  selectedObjectId: string | null,
): DirectorStageViewState {
  return {
    selectedObjectId,
    focusedSurface: "console",
    interactionMode: { kind: "edit" },
    cameraPreview: false,
    previewMode: "static",
    splitView: { kind: "closed", ratio: 0.5 },
    viewFlags: { ...DEFAULT_VIEW_FLAGS },
    viewMenuOpen: false,
    leftTab: "characters",
    assetRole: "character",
    treeGroups: { ...DEFAULT_TREE_GROUPS },
    helpOpen: false,
    drawerOpen: false,
    selectedStillIds: new Set<string>(),
    previewStillId: null,
    exportDialog: { kind: "closed", source: "", clarity: 1280, fps: 30 },
    activeGizmo: "translate",
  };
}

function clampSplitRatio(ratio: number, fallback: number): number {
  if (!Number.isFinite(ratio)) return fallback;
  return Math.min(0.8, Math.max(0.2, ratio));
}

export function directorStageViewReducer(
  state: DirectorStageViewState,
  action: DirectorStageViewAction,
): DirectorStageViewState {
  switch (action.type) {
    case "selectObject":
      return { ...state, selectedObjectId: action.objectId };
    case "focusSurface":
      return { ...state, focusedSurface: action.surface };
    case "toggleCameraPreview":
      return { ...state, cameraPreview: !state.cameraPreview };
    case "setCameraPreview":
      return { ...state, cameraPreview: action.enabled };
    case "setPreviewMode":
      return { ...state, previewMode: action.mode };
    case "toggleViewfinder":
      if (state.interactionMode.kind === "viewfinder") {
        return {
          ...state,
          interactionMode: { kind: "edit" },
        };
      }
      return {
        ...state,
        interactionMode: { kind: "viewfinder" },
        cameraPreview: true,
        viewFlags: { ...state.viewFlags, aspectMask: true },
      };
    case "toggleRoam":
      if (state.interactionMode.kind === "roam") {
        return {
          ...state,
          interactionMode: { kind: "edit" },
        };
      }
      return {
        ...state,
        interactionMode: { kind: "roam" },
        cameraPreview: false,
      };
    case "armPlacement":
      return {
        ...state,
        interactionMode: {
          kind: "placement",
          objectKind: action.objectKind,
          sourceObjectId: action.sourceObjectId,
        },
      };
    case "cancelPlacement":
      if (state.interactionMode.kind !== "placement") return state;
      return { ...state, interactionMode: { kind: "edit" } };
    case "openSplit":
      return {
        ...state,
        splitView: {
          kind: "open",
          cameraId: action.cameraId,
          ratio: clampSplitRatio(
            action.ratio ?? state.splitView.ratio,
            state.splitView.ratio,
          ),
        },
      };
    case "closeSplit":
      return {
        ...state,
        splitView: { kind: "closed", ratio: state.splitView.ratio },
      };
    case "setSplitRatio":
      return {
        ...state,
        splitView: {
          ...state.splitView,
          ratio: clampSplitRatio(action.ratio, state.splitView.ratio),
        },
      };
    case "setSplitCamera":
      if (state.splitView.kind === "closed") return state;
      return {
        ...state,
        splitView: { ...state.splitView, cameraId: action.cameraId },
      };
    case "toggleViewFlag":
      return {
        ...state,
        viewFlags: {
          ...state.viewFlags,
          [action.flag]: !state.viewFlags[action.flag],
        },
      };
    case "setViewFlag":
      return {
        ...state,
        viewFlags: { ...state.viewFlags, [action.flag]: action.enabled },
      };
    case "toggleViewMenu":
      return { ...state, viewMenuOpen: !state.viewMenuOpen };
    case "setViewMenu":
      return { ...state, viewMenuOpen: action.open };
    case "setLeftTab":
      return { ...state, leftTab: action.tab };
    case "setAssetRole":
      return { ...state, assetRole: action.role };
    case "toggleTreeGroup":
      return {
        ...state,
        treeGroups: {
          ...state.treeGroups,
          [action.group]: !state.treeGroups[action.group],
        },
      };
    case "setTreeGroup":
      return {
        ...state,
        treeGroups: { ...state.treeGroups, [action.group]: action.expanded },
      };
    case "toggleHelp":
      return { ...state, helpOpen: !state.helpOpen };
    case "setHelp":
      return { ...state, helpOpen: action.open };
    case "toggleDrawer":
      return { ...state, drawerOpen: !state.drawerOpen };
    case "setDrawer":
      return { ...state, drawerOpen: action.open };
    case "toggleStillSelection": {
      const selectedStillIds = new Set(state.selectedStillIds);
      if (selectedStillIds.has(action.stillId))
        selectedStillIds.delete(action.stillId);
      else selectedStillIds.add(action.stillId);
      return { ...state, selectedStillIds };
    }
    case "setStillSelection":
      return { ...state, selectedStillIds: new Set(action.stillIds) };
    case "clearStillSelection":
      return {
        ...state,
        selectedStillIds: new Set<string>(),
        previewStillId:
          state.previewStillId && state.selectedStillIds.has(state.previewStillId)
            ? null
            : state.previewStillId,
      };
    case "setPreviewStill":
      return { ...state, previewStillId: action.stillId };
    case "openExport":
      return {
        ...state,
        exportDialog: {
          kind: "open",
          source: action.source,
          clarity: action.clarity,
          fps: action.fps,
        },
      };
    case "closeExport":
      if (state.exportDialog.kind === "closed") return state;
      return {
        ...state,
        exportDialog: { ...state.exportDialog, kind: "closed" },
      };
    case "setExportSource":
      if (state.exportDialog.kind === "closed") return state;
      return {
        ...state,
        exportDialog: { ...state.exportDialog, source: action.source },
      };
    case "setExportClarity":
      if (state.exportDialog.kind === "closed") return state;
      return {
        ...state,
        exportDialog: { ...state.exportDialog, clarity: action.clarity },
      };
    case "setExportFps":
      if (state.exportDialog.kind === "closed") return state;
      return {
        ...state,
        exportDialog: { ...state.exportDialog, fps: action.fps },
      };
    case "setGizmo":
      return { ...state, activeGizmo: action.gizmo };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
