import type { AssetRef } from "../contracts/generated.ts";
import type { CanvasNodeData } from "./model.ts";
import type { StageObject } from "./stageDocument.ts";

/** Stage media that must follow a director node across project boundaries:
 * the pinned still plus every imported model's preview URL and pinned asset. */
export interface StageMediaItem {
  role: "still" | "model";
  kind: "image" | "file";
  title: string;
  /** Session URL holding the bytes, when one is live. */
  url?: string;
  /** Registered identity in the owning project, when saved. */
  asset?: AssetRef;
  /** The stage object a model item re-homes. */
  object?: StageObject;
}

/** Browser-only URLs are the only stage bytes a copy can capture. */
const sessionUrl = (value: unknown): string | undefined =>
  typeof value === "string" && /^(blob|data):/i.test(value) ? value : undefined;

export function stageMediaItems(data: CanvasNodeData): StageMediaItem[] {
  const items: StageMediaItem[] = [];
  if (data.stillAsset)
    items.push({
      role: "still",
      kind: "image",
      title: data.title,
      url: sessionUrl(data.src),
      asset: data.stillAsset,
    });
  for (const object of data.localStage?.objects ?? [])
    if (object.kind === "gltf")
      items.push({
        role: "model",
        kind: "file",
        title: object.name,
        url: sessionUrl(object.source),
        asset: object.asset,
        object,
      });
  return items;
}

/** Installs re-homed stage media. Items the resolver leaves unresolved keep
 * their current value, so each caller decides whether a miss is a draft to
 * carry along or a failure to raise. */
export function applyStageMedia(
  data: CanvasNodeData,
  items: StageMediaItem[],
  registered: (item: StageMediaItem) => { src: string; ref: AssetRef } | undefined,
): void {
  for (const item of items) {
    const result = registered(item);
    if (!result) continue;
    if (item.role === "still") {
      data.stillAsset = result.ref;
      delete data.stillCapture;
    } else if (item.object) {
      item.object.source = result.src;
      item.object.asset = result.ref;
    }
  }
}
