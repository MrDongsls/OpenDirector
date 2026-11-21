import type {
  CanvasPublishMediaInput,
  DirectorOutputPlanInput,
  EditorDocument,
  ProjectSnapshot,
  MediaEditData,
} from "../contracts/generated.ts";
import {
  placeResults,
  type LinkedMediaResult,
} from "../canvas/linkedResults.ts";
import type { CanvasToolTask } from "../canvas/toolCatalog.ts";
import { tNow } from "../i18n/messages.ts";
import {
  assetReference,
  CreationClient,
  CreationCommandError,
  currentAsset,
  objectVersion,
} from "./creationClient.ts";
import { CreationProjection } from "./creationProjection.ts";

import { createDocument, createNode } from "../canvas/model.ts";
import { absolutePosition } from "../canvas/geometry.ts";

type Delivery = {
  id: string;
  key: string;
  payload: CanvasPublishMediaInput;
  versions: ReturnType<typeof objectVersion>[];
  /** Stable slots are written before the first upload, so a failed later
   * upload can resume without changing the already-imported outputs. */
  prepared?: DeliverySlot[];
};

type DeliverySlot = {
  itemId: string;
  title: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  uploadHandle: string;
  asset?: CanvasPublishMediaInput["outputs"][number]["asset"];
};

/** Only command delivery is retained locally; output bytes are owned project assets. */
export class MediaPublication {
  private pending?: Delivery;
  private confirmed?: string;
  private confirmedIds: string[] = [];
  private rejected?: Delivery;
  private active = false;
  private readonly projection: CreationProjection;
  private client: CreationClient;
  private basis: ProjectSnapshot;
  private itemId: string;
  private executionIds = new Map<string, string>();
  constructor(client: CreationClient, basis: ProjectSnapshot, itemId: string) {
    this.client = client;
    this.basis = basis;
    this.itemId = itemId;
    this.projection = new CreationProjection(client);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(this.storageKey()) ?? "null",
      );
      if (saved?.rejected) {
        const { rejected: _rejected, ...delivery } = saved;
        this.rejected = delivery;
      } else this.pending = saved ?? undefined;
    } catch {
      /* optional */
    }
  }
  private storageKey() {
    return `opendirector.media.delivery:${this.client.id}:${this.itemId}`;
  }
  private remember() {
    try {
      if (this.pending)
        sessionStorage.setItem(this.storageKey(), JSON.stringify(this.pending));
      else if (this.rejected)
        sessionStorage.setItem(
          this.storageKey(),
          JSON.stringify({ ...this.rejected, rejected: true }),
        );
      else sessionStorage.removeItem(this.storageKey());
    } catch {
      /* The open session still owns its original delivery. */
    }
  }
  async publish(
    outputs: readonly LinkedMediaResult[],
    task?: CanvasToolTask,
    directorPlan?: DirectorOutputPlanInput,
  ) {
    if (this.active) throw Error(tNow("errors.backend.savingResult"));
    this.active = true;
    try {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          outputs,
          tool: task?.tool,
          parameters: task?.parameters,
          selection: task?.selection,
          directorPlan,
        }),
      );
      const key = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (this.confirmed === key) return this.confirmedIds;
      const resolvingPrevious = !!this.pending && this.pending.key !== key;
      if (
        resolvingPrevious &&
        this.pending?.prepared &&
        this.pending.payload.outputs.length < this.pending.prepared.length
      )
        throw Error(tNow("errors.backend.mediaPreparationPending"));
      if (!this.pending && this.rejected?.key === key) {
        this.pending = { ...this.rejected, id: crypto.randomUUID() };
        this.remember();
      }
      if (!this.pending) {
        const item = this.basis.canvasItems.find((i) => i.id === this.itemId);
        if (!item) throw Error(tNow("errors.backend.editSourceUnsaved"));
        const source = currentAsset(this.basis, item);
        const executionId = this.executionIds.get(key) ?? crypto.randomUUID();
        this.executionIds.set(key, executionId);
        let document: EditorDocument;
        let sourceEditorId: string | undefined;
        const versions = [
          objectVersion("canvas_item", {
            ...item,
            revision: item.revision,
          }),
        ];
        if (item.kind === "external" && item.binding.role === "editor") {
          const editorId = item.binding.objectRef.id;
          const original = this.basis.editorDocuments.find(
            (d) => d.id === editorId,
          )!;
          if (original.kind !== "director")
            throw Error(tNow("errors.backend.notDirectorStage"));
          document = { ...original, id: executionId, revision: 1 };
          sourceEditorId = original.id;
          versions.push(objectVersion("editor_document", original));
        } else {
          if (!source) throw Error(tNow("errors.backend.noRealMedia"));
          const tool: MediaEditData["tool"] =
            task?.tool ??
            (source.kind === "video"
              ? outputs[0]?.kind === "image"
                ? "video-frame-capture"
                : outputs[0]?.kind === "audio"
                  ? "extract-audio"
                  : "video-trim"
              : source.kind === "audio"
                ? "audio-trim"
                : "composition");
          const selection = task?.selection;
          document = {
            id: executionId,
            projectId: this.client.id,
            revision: 1,
            schemaVersion: 1,
            inputConnections: [],
            kind: "media_edit",
            data: {
              tool,
              sourceItems: [item.id],
              sources: [assetReference(source)],
              parameters: { ...task?.parameters },
              selection: selection
                ? {
                    source: assetReference(source),
                    width: selection.width,
                    height: selection.height,
                    boxes: selection.boxes ?? [],
                    mask: selection.maskDataUrl
                      ? await this.projection.importResource({
                          kind: "image",
                          title: tNow("errors.backend.selectionFile"),
                          src: selection.maskDataUrl,
                        })
                      : null,
                  }
                : null,
            },
          };
        }
        const layout = {
          ...createDocument(),
          nodes: this.client.snapshot.canvasItems
            .filter((i) => i.visible)
            .map((i) => ({
              ...createNode(i.kind, i.position),
              id: i.id,
              width: i.width,
              height: i.height,
              parentId: i.parentId ?? undefined,
            })),
        };
        const origin = layout.nodes.find((n) => n.id === item.id);
        const start = origin
          ? absolutePosition(origin, layout.nodes)
          : item.position;
        const placed = placeResults(layout, outputs, {
          x: start.x + item.width + 100,
          y: start.y,
        });
        this.pending = {
          id: crypto.randomUUID(),
          key,
          versions,
          prepared: outputs.map((output, index) => {
            const placement = placed[index]!;
            return {
              itemId: crypto.randomUUID(),
              title: output.title,
              position: placement.position,
              width: placement.width,
              height: placement.height,
              uploadHandle: crypto.randomUUID(),
            };
          }),
          payload: {
            itemId: item.id,
            source: source ? assetReference(source) : null,
            ...(sourceEditorId ? { sourceEditorId } : {}),
            document,
            ...(directorPlan ? { directorPlan } : {}),
            outputs: [],
          },
        };
        this.remember();
      }
      let delivery = this.pending;
      if (!delivery) throw Error(tNow("errors.backend.savingResult"));
      const prepared = delivery.prepared;
      if (prepared) {
        if (outputs.length !== prepared.length)
          throw Error(tNow("errors.backend.mediaPreparationPending"));
        for (
          let index = delivery.payload.outputs.length;
          index < prepared.length;
          index++
        ) {
          const slot = prepared[index]!;
          const output = outputs[index]!;
          const asset = await this.projection.importResource({
            ...output,
            identity: `publication:${delivery.payload.document.id}:${index}`,
            fresh: true,
            uploadHandle: slot.uploadHandle,
          });
          delivery = {
            ...delivery,
            versions: [
              ...delivery.versions,
              objectVersion("asset", {
                id: asset.assetId,
                revision: asset.revision,
              }),
            ],
            payload: {
              ...delivery.payload,
              outputs: [
                ...delivery.payload.outputs,
                {
                  itemId: slot.itemId,
                  asset,
                  title: slot.title,
                  position: slot.position,
                  width: slot.width,
                  height: slot.height,
                },
              ],
            },
          };
          this.pending = delivery;
          this.remember();
        }
      }
      if (
        delivery.prepared &&
        delivery.payload.outputs.length !== delivery.prepared.length
      )
        throw Error(tNow("errors.backend.mediaPreparationPending"));
      await this.client.command(
        "canvas.publishMedia",
        delivery.payload,
        delivery.versions,
        undefined,
        delivery.id,
      );
      this.pending = undefined;
      this.rejected = undefined;
      this.remember();
      this.confirmed = delivery.key;
      this.confirmedIds = delivery.payload.outputs.map((o) => o.itemId);
      if (resolvingPrevious)
        throw Error(tNow("errors.backend.priorResultSaved"));
      return delivery.payload.outputs.map((o) => o.itemId);
    } catch (error) {
      if (error instanceof CreationCommandError) {
        this.rejected = this.pending;
        this.pending = undefined;
        this.remember();
      }
      throw error;
    } finally {
      this.active = false;
    }
  }
}
