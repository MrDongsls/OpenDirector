import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalStage,
  editStageCameraAt,
  editStageObjectAt,
  type LocalStageDocument,
} from "../src/canvas/stageDocument.ts";
import {
  editStageCameraChannelAt,
  editStageObjectMotionAt,
  editStageObjectTransformChannelAt,
  projectStageTimeline,
  removeStageTimelineKeyframe,
  snapStageTimelineTime,
  stageFrameToTime,
  stageTimeToFrame,
} from "../src/canvas/stageTimeline.ts";

function stage(): LocalStageDocument {
  let value = createLocalStage();
  const object = value.objects[0]!;
  value = editStageCameraAt(value, value.activeCameraId, 2, {
    position: { x: 8, y: 3.5, z: 7 },
  });
  value = editStageObjectAt(value, object.id, 4, {
    position: { x: 3, y: 0, z: 0 },
  });
  return {
    ...value,
    shots: [
      { id: "opening", cameraId: value.activeCameraId, start: 0, duration: 2 },
      { id: "close", cameraId: value.activeCameraId, start: 2, duration: 4 },
    ],
    cameraSource: "storyboard",
  };
}

test("projects shots, independent camera channels, and object transform/motion tracks", () => {
  const value = stage();
  const projection = projectStageTimeline(value);
  assert.deepEqual(projection.tracks[0]!.points.map((item) => item.time), [0, 2, 2, 6]);
  assert.deepEqual(projection.tracks[0]!.label, { kind: "shots" });
  assert.deepEqual(
    projection.tracks.find((track) => track.id === "camera:camera-1:position")!.points.map((item) => item.time),
    [0, 2],
  );
  assert.deepEqual(
    projection.tracks.filter((track) => track.sourceId === value.objects[0]!.id).map((track) => track.channel),
    ["position", "rotation", "scale", "motion"],
  );
});

test("maps frame and time at the document boundaries", () => {
  const value = stage();
  assert.equal(stageFrameToTime(value, -3), 0);
  assert.equal(stageFrameToTime(value, 999), 6);
  assert.equal(stageTimeToFrame(value, -1), 0);
  assert.equal(stageTimeToFrame(value, 6), 180);
  assert.equal(stageTimeToFrame(value, 1.01), 30);
  const fractional = { ...value, duration: 6.01 };
  assert.equal(stageFrameToTime(fractional, 181), 6);
  assert.equal(stageFrameToTime(value, Number.NaN), 0);
});

test("snaps to frames, keyframes, and shot boundaries without leaving the stage", () => {
  const value = stage();
  assert.equal(snapStageTimelineTime(value, 1.99), 2);
  assert.equal(snapStageTimelineTime(value, 3.999), 4);
  assert.equal(snapStageTimelineTime(value, -4), 0);
  assert.equal(snapStageTimelineTime(value, 6.1), 6);
  assert.equal(snapStageTimelineTime(value, 1.99, { includeShotBoundaries: false }), 2);
});

test("empty tracks remain explicit and empty documents still snap to frames", () => {
  const value = { ...createLocalStage(), objects: [], shots: [] };
  const projection = projectStageTimeline(value);
  assert.equal(projection.tracks[0]!.points.length, 0);
  assert.equal(projection.tracks.some((track) => track.kind === "object-channel"), false);
  assert.equal(snapStageTimelineTime(value, 1.01), 1);
});

test("editing a camera or object channel preserves unrelated channels and replaces one keyframe", () => {
  const value = stage();
  const cameraId = value.activeCameraId;
  const objectId = value.objects[0]!.id;
  const camera = editStageCameraChannelAt(value, cameraId, "position", 2, { x: 12, y: 3.5, z: 7 });
  const cameraAtSameTime = editStageCameraChannelAt(camera, cameraId, "position", 2, { x: 13, y: 3.5, z: 7 });
  const cameraChannels = cameraAtSameTime.cameras[0]!.channels!;
  assert.equal(cameraChannels.position.length, 2);
  assert.equal(cameraChannels.position.find((frame) => frame.time === 2)!.value.x, 13);
  assert.deepEqual(cameraChannels.target, value.cameras[0]!.channels!.target);
  assert.deepEqual(cameraChannels.focalLength, value.cameras[0]!.channels!.focalLength);

  const object = editStageObjectTransformChannelAt(value, objectId, "position", 4, { x: 9, y: 0, z: 0 });
  assert.deepEqual(object.objects[0]!.keyframes[0]!.value.rotation, value.objects[0]!.keyframes[0]!.value.rotation);
  assert.deepEqual(object.objects[0]!.keyframes[0]!.value.scale, value.objects[0]!.keyframes[0]!.value.scale);
});

test("deleting one projected channel point preserves sibling channels", () => {
  const value = stage();
  const camera = value.cameras[0]!;
  const positionPoint = camera.channels!.position.find((frame) => frame.time === 2)!;
  const afterCamera = removeStageTimelineKeyframe(value, {
    kind: "camera",
    sourceId: camera.id,
    channel: "position",
    pointId: positionPoint.id,
  });
  assert.equal(afterCamera.cameras[0]!.channels!.position.some((frame) => frame.id === positionPoint.id), false);
  assert.deepEqual(afterCamera.cameras[0]!.channels!.target, camera.channels!.target);

  const object = value.objects[0]!;
  const objectPoint = object.keyframes.find((frame) => frame.time === 4)!;
  const afterObject = removeStageTimelineKeyframe(value, {
    kind: "object",
    sourceId: object.id,
    channel: "position",
    pointId: objectPoint.id,
  });
  const remaining = afterObject.objects[0]!.keyframes.find((frame) => frame.id === objectPoint.id)!;
  assert.deepEqual(remaining.value.position, object.position);
  assert.deepEqual(remaining.value.rotation, objectPoint.value.rotation);
  assert.deepEqual(remaining.value.scale, objectPoint.value.scale);
  assert.deepEqual(
    projectStageTimeline(afterObject).tracks.find((track) => track.id === `object:${object.id}:position`)!.points.map((point) => point.time),
    [0],
  );
});

test("motion editing updates the active clip without creating a duplicate", () => {
  const value = stage();
  const objectId = value.objects[0]!.id;
  const motion = { preset: "walk" as const, speed: 2, amount: 0.5 };
  const first = editStageObjectMotionAt(value, objectId, 1, motion);
  const second = editStageObjectMotionAt(first, objectId, 1.5, { ...motion, speed: 3 });
  assert.equal(second.objects[0]!.motionClips.length, 1);
  assert.equal(second.objects[0]!.motionClips[0]!.motion.speed, 3);
});

test("motion insertion stops before the next clip and ignores the document end", () => {
  const value = stage();
  const objectId = value.objects[0]!.id;
  const withLaterClip = {
    ...value,
    objects: value.objects.map((object) => object.id !== objectId ? object : {
      ...object,
      motionClips: [{
        id: "later",
        start: 3,
        duration: 1,
        motion: { preset: "run" as const, speed: 1, amount: 1 },
      }],
    }),
  };
  const inserted = editStageObjectMotionAt(withLaterClip, objectId, 1, {
    preset: "walk",
    speed: 1,
    amount: 1,
  });
  assert.equal(inserted.objects[0]!.motionClips.find((clip) => clip.id !== "later")!.duration, 2);
  assert.equal(editStageObjectMotionAt(value, objectId, value.duration, {
    preset: "walk",
    speed: 1,
    amount: 1,
  }), value);
});
