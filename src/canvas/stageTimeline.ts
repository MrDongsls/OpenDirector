import {
  editStageCameraAt,
  editStageObjectAt,
  parseLocalStageValue,
  type LocalStageDocument,
  type StageCameraChannels,
  type StageMotionClip,
  type StageTransform,
  type Vector3Value,
} from "./stageDocument.ts";
import type { StageMotion } from "./stageMotion.ts";

export type StageTimelineTrackKind =
  | "shots"
  | "camera-channel"
  | "object-channel";
export type StageTimelineChannel =
  | keyof StageCameraChannels
  | "position"
  | "rotation"
  | "scale"
  | "motion";
export type StageTimelinePointKind = "boundary" | "keyframe";

/** Structural label data; the Director Stage UI resolves it through i18n. */
export type StageTimelineTrackLabel =
  | { readonly kind: "shots" }
  | {
      readonly kind: "source";
      readonly name: string;
      readonly channel: StageTimelineChannel;
    };

export interface StageTimelinePoint {
  readonly id: string;
  readonly time: number;
  readonly kind: StageTimelinePointKind;
  readonly value?: unknown;
}

export interface StageTimelineTrack {
  readonly id: string;
  readonly kind: StageTimelineTrackKind;
  readonly label: StageTimelineTrackLabel;
  readonly sourceId?: string;
  readonly channel?: StageTimelineChannel;
  readonly points: readonly StageTimelinePoint[];
}

export interface StageTimelineProjection {
  readonly duration: number;
  readonly fps: LocalStageDocument["fps"];
  readonly tracks: readonly StageTimelineTrack[];
}

export interface StageTimelineSnapOptions {
  readonly tolerance?: number;
  readonly includeFrames?: boolean;
  readonly includeKeyframes?: boolean;
  readonly includeShotBoundaries?: boolean;
}

export type StageTimelineKeyframeTarget =
  | {
      readonly kind: "camera";
      readonly sourceId: string;
      readonly channel: keyof StageCameraChannels;
      readonly pointId: string;
    }
  | {
      readonly kind: "object";
      readonly sourceId: string;
      readonly channel: "position" | "rotation" | "scale";
      readonly pointId: string;
    };

const clone = <T>(value: T): T => structuredClone(value);
const sameVector = (left: Vector3Value, right: Vector3Value) =>
  left.x === right.x && left.y === right.y && left.z === right.z;
const clampTime = (stage: LocalStageDocument, time: number) =>
  Math.max(0, Math.min(stage.duration, Number.isFinite(time) ? time : 0));

const point = (
  id: string,
  time: number,
  kind: StageTimelinePointKind,
  value?: unknown,
): StageTimelinePoint => ({
  id,
  time,
  kind,
  ...(value === undefined ? {} : { value: clone(value) }),
});

function ordered(points: StageTimelinePoint[]): readonly StageTimelinePoint[] {
  return points.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

function cameraChannels(camera: LocalStageDocument["cameras"][number]): StageCameraChannels {
  if (camera.channels) return camera.channels;
  return {
    position: camera.keyframes.map((frame) => ({ id: frame.id, time: frame.time, value: clone(frame.value.position) })),
    target: camera.keyframes.map((frame) => ({ id: frame.id, time: frame.time, value: clone(frame.value.target) })),
    up: [],
    focalLength: camera.keyframes.map((frame) => ({ id: frame.id, time: frame.time, value: frame.value.fov })),
  };
}

function framePoints(
  frames: readonly { id: string; time: number; value: unknown }[],
): StageTimelinePoint[] {
  return frames.map((frame) => point(frame.id, frame.time, "keyframe", frame.value));
}

function cameraTracks(stage: LocalStageDocument): StageTimelineTrack[] {
  return stage.cameras.flatMap((camera) => {
    const channels = cameraChannels(camera);
    return (Object.keys(channels) as (keyof StageCameraChannels)[]).map((channel) => ({
      id: `camera:${camera.id}:${channel}`,
      kind: "camera-channel" as const,
      label: { kind: "source" as const, name: camera.name, channel },
      sourceId: camera.id,
      channel,
      points: ordered(framePoints(channels[channel] as readonly { id: string; time: number; value: unknown }[])),
    }));
  });
}

function objectTracks(stage: LocalStageDocument): StageTimelineTrack[] {
  return stage.objects.flatMap((object) => {
    const transformChannels = (["position", "rotation", "scale"] as const).map((channel) => ({
      id: `object:${object.id}:${channel}`,
      kind: "object-channel" as const,
      label: { kind: "source" as const, name: object.name, channel },
      sourceId: object.id,
      channel,
      points: ordered(
        framePoints(
          object.keyframes
            .map((frame) => ({
              id: frame.id,
              time: frame.time,
              value: frame.value[channel],
            }))
            .filter((frame) => !sameVector(frame.value, object[channel])),
        ),
      ),
    }));
    const motionPoints = object.motionClips.flatMap((clip) => [
      point(`${clip.id}:start`, clip.start, "boundary", clip.motion),
      point(`${clip.id}:end`, clip.start + clip.duration, "boundary"),
    ]);
    return [...transformChannels, {
      id: `object:${object.id}:motion`,
      kind: "object-channel" as const,
      label: { kind: "source" as const, name: object.name, channel: "motion" as const },
      sourceId: object.id,
      channel: "motion" as const,
      points: ordered(motionPoints),
    }];
  });
}

export function projectStageTimeline(stage: LocalStageDocument): StageTimelineProjection {
  const shotPoints = stage.shots.flatMap((shot) => [
    point(`${shot.id}:start`, shot.start, "boundary", shot.id),
    point(`${shot.id}:end`, shot.start + shot.duration, "boundary", shot.id),
  ]);
  return {
    duration: stage.duration,
    fps: stage.fps,
    tracks: [
      {
        id: "shots",
        kind: "shots",
        label: { kind: "shots" },
        points: ordered(shotPoints),
      },
      ...cameraTracks(stage),
      ...objectTracks(stage),
    ],
  };
}

export function stageFrameToTime(stage: LocalStageDocument, frame: number): number {
  const lastFrame = Math.max(0, Math.round(stage.duration * stage.fps));
  const requested = Number.isFinite(frame) ? Math.round(frame) : 0;
  const bounded = Math.max(0, Math.min(lastFrame, requested));
  return Math.min(stage.duration, bounded / stage.fps);
}

export function stageTimeToFrame(stage: LocalStageDocument, time: number): number {
  return Math.round(clampTime(stage, time) * stage.fps);
}

export function snapStageTimelineTime(
  stage: LocalStageDocument,
  time: number,
  options: StageTimelineSnapOptions = {},
): number {
  const at = clampTime(stage, time);
  const candidates: number[] = [];
  if (options.includeFrames !== false) candidates.push(stageFrameToTime(stage, stageTimeToFrame(stage, at)));
  if (options.includeKeyframes !== false || options.includeShotBoundaries !== false) {
    if (options.includeShotBoundaries !== false) {
      candidates.push(...stage.shots.flatMap((shot) => [shot.start, shot.start + shot.duration]));
    }
    if (options.includeKeyframes !== false) {
      for (const camera of stage.cameras) {
        const channels = cameraChannels(camera);
        const channelFrames = [
          channels.position,
          channels.target,
          channels.up,
          channels.focalLength,
        ];
        candidates.push(...channelFrames.flatMap((frames) => frames.map((frame) => frame.time)));
      }
      for (const object of stage.objects) {
        candidates.push(...object.keyframes.map((frame) => frame.time));
        candidates.push(...object.motionClips.flatMap((clip) => [clip.start, clip.start + clip.duration]));
      }
    }
  }
  const tolerance = options.tolerance ?? 0.5 / stage.fps;
  const nearest = candidates
    .map((candidate) => ({ candidate, distance: Math.abs(candidate - at) }))
    .filter((item) => item.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance || a.candidate - b.candidate)[0];
  return nearest?.candidate ?? at;
}

function putFrame<T extends { id: string; time: number; value: T["value"] }>(
  frames: readonly T[],
  time: number,
  value: T["value"],
): T[] {
  const existing = frames.find((frame) => frame.time === time);
  return [...frames.filter((frame) => frame.time !== time), {
    id: existing?.id ?? crypto.randomUUID(),
    time,
    value: clone(value),
  } as T].sort((a, b) => a.time - b.time);
}

function authorChannel<T extends { id: string; time: number; value: unknown }>(
  frames: readonly T[],
  time: number,
  value: T["value"],
  base: T["value"],
): T[] {
  return putFrame(frames.length || time === 0 ? frames : putFrame([], 0, base), time, value);
}

export function editStageCameraChannelAt(
  stage: LocalStageDocument,
  cameraId: string,
  channel: keyof StageCameraChannels,
  time: number,
  value: Vector3Value | number,
): LocalStageDocument {
  const at = clampTime(stage, time);
  if (channel !== "up") {
    return editStageCameraAt(stage, cameraId, at, {
      ...(channel === "position" ? { position: value as Vector3Value } : {}),
      ...(channel === "target" ? { target: value as Vector3Value } : {}),
      ...(channel === "focalLength" ? { fov: value as number } : {}),
    });
  }
  const camera = stage.cameras.find((item) => item.id === cameraId);
  if (!camera) return stage;
  const channels = cameraChannels(camera);
  const nextChannels = {
    ...channels,
    up: authorChannel(channels.up, at, value as Vector3Value, { x: 0, y: 1, z: 0 }),
  };
  return parseLocalStageValue({
    ...stage,
    cameras: stage.cameras.map((item) => item.id === cameraId ? { ...item, channels: nextChannels } : item),
  });
}

export function editStageObjectTransformChannelAt(
  stage: LocalStageDocument,
  objectId: string,
  channel: "position" | "rotation" | "scale",
  time: number,
  value: Vector3Value,
): LocalStageDocument {
  return editStageObjectAt(stage, objectId, clampTime(stage, time), { [channel]: value } as Partial<StageTransform>);
}

export function editStageObjectMotionAt(
  stage: LocalStageDocument,
  objectId: string,
  time: number,
  motion: StageMotion,
): LocalStageDocument {
  const object = stage.objects.find((item) => item.id === objectId);
  if (
    !object ||
    object.locked ||
    !(object.kind === "person" ||
      (object.kind === "gltf" && object.role === "character" && object.hasAnimation))
  )
    return stage;
  const at = clampTime(stage, time);
  if (at >= stage.duration) return stage;
  const existing = object.motionClips.find((clip) => at >= clip.start && at < clip.start + clip.duration);
  const nextStart = object.motionClips
    .filter((clip) => clip.start > at)
    .map((clip) => clip.start)
    .sort((a, b) => a - b)[0] ?? stage.duration;
  const duration = Math.min(2, nextStart - at);
  if (!existing && duration <= 0) return stage;
  const next: StageMotionClip = existing
    ? { ...existing, motion: clone(motion) }
    : { id: crypto.randomUUID(), start: at, duration, motion: clone(motion) };
  return parseLocalStageValue({
    ...stage,
    objects: stage.objects.map((item) => item.id !== objectId ? item : {
      ...item,
      motionClips: existing
        ? item.motionClips.map((clip) => clip.id === existing.id ? next : clip)
        : [...item.motionClips, next],
    }),
  });
}

/** Remove one projected channel point while retaining sibling channels. */
export function removeStageTimelineKeyframe(
  stage: LocalStageDocument,
  target: StageTimelineKeyframeTarget,
): LocalStageDocument {
  if (target.kind === "camera") {
    return parseLocalStageValue({
      ...stage,
      cameras: stage.cameras.map((camera) => {
        if (camera.id !== target.sourceId) return camera;
        const channels = cameraChannels(camera);
        return {
          ...camera,
          channels: {
            ...channels,
            [target.channel]: channels[target.channel].filter(
              (frame) => frame.id !== target.pointId,
            ),
          },
        };
      }),
    });
  }
  return parseLocalStageValue({
    ...stage,
    objects: stage.objects.map((object) => {
      if (object.id !== target.sourceId) return object;
      const base = object[target.channel];
      return {
        ...object,
        keyframes: object.keyframes.map((frame) =>
          frame.id !== target.pointId
            ? frame
            : { ...frame, value: { ...frame.value, [target.channel]: clone(base) } },
        ),
      };
    }),
  });
}
