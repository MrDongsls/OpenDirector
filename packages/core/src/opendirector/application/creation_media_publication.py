"""Atomic publication of browser-produced media with a fixed editing basis."""
from math import isclose

from pydantic import TypeAdapter

from opendirector.domain.creation.canvas import CanvasItem
from opendirector.domain.creation.commands import DirectorOutputPlan
from opendirector.domain.creation.project import ProjectSnapshot, asset_references
from opendirector.domain.creation.validation import ContractError
from .creation_canvas import current_asset, asset_ref


DIRECTOR_ASPECTS = {
    '16:9': (16, 9),
    '2.39:1': (2.39, 1),
    '9:16': (9, 16),
    '1:1': (1, 1),
    '4:3': (4, 3),
    '3:4': (3, 4),
}


def _director_plan_duration(doc, plan: DirectorOutputPlan):
    if plan.cameraSource == 'storyboard':
        if plan.cameraId is not None or not doc.data.shots:
            raise ContractError(
                'invalid_input',
                '导演预演的分镜执行计划无效。 The Director storyboard execution plan is invalid.',
                doc.id,
            )
        expected_duration = sum(shot.duration for shot in doc.data.shots)
    else:
        if plan.cameraId is None or not any(camera.id == plan.cameraId for camera in doc.data.cameras):
            raise ContractError(
                'invalid_input',
                '导演预演引用了不存在的机位。 The Director execution plan references an unknown camera.',
                doc.id,
            )
        expected_duration = doc.data.duration
    width_ratio, height_ratio = DIRECTOR_ASPECTS[doc.data.aspectRatio]
    if not isclose(plan.width / plan.height, width_ratio / height_ratio, rel_tol=0.002, abs_tol=0.002):
        raise ContractError(
            'invalid_input',
            '导演预演输出尺寸与舞台比例不一致。 The Director output size does not match the stage aspect ratio.',
            doc.id,
        )
    if not isclose(plan.durationSeconds, expected_duration, abs_tol=1e-6):
        raise ContractError(
            'invalid_input',
            '导演预演执行时长与舞台计划不一致。 The Director execution duration does not match the frozen plan.',
            doc.id,
        )
    return expected_duration


def publish_media(service, data, payload):
    item = service._editable(data, payload.itemId)
    snapshot = ProjectSnapshot.model_validate(data)
    owner = next(i for i in snapshot.canvasItems if i.id == payload.itemId)
    doc = payload.document
    if doc.projectId != snapshot.project.id or doc.revision != 1 or any(d.id == doc.id for d in snapshot.editorDocuments):
        raise ContractError('invalid_input', '编辑执行快照必须使用新的工程内身份。', doc.id)
    if doc.inputConnections:
        raise ContractError('invalid_input', '编辑输出不能伪造装配关系。', doc.id)
    if doc.kind == 'director':
        if owner.kind != 'external' or owner.binding.role != 'editor' or owner.binding.objectRef.id != payload.sourceEditorId:
            raise ContractError('reference_invalid', '导演预演来源已变化。', owner.id)
        original = next(d for d in snapshot.editorDocuments if d.id == payload.sourceEditorId)
        if original.kind != 'director' or original.data != doc.data or payload.source is not None:
            raise ContractError('revision_conflict', '预演输出与已确认的舞台版本不一致。', owner.id)
        # Videos render the whole preview; images flow the pinned stills.
        allowed, sources = {'video', 'image'}, []
        director_duration = None
        if payload.directorPlan is not None:
            director_duration = _director_plan_duration(doc, payload.directorPlan)
        elif any(output.asset.kind == 'video' for output in payload.outputs):
            raise ContractError(
                'invalid_input',
                '导演视频发布缺少冻结的输出计划。 Director video publication requires a frozen output plan.',
                doc.id,
            )
    else:
        actual = current_asset(snapshot, owner)
        if not actual or payload.source != asset_ref(actual) or doc.data.sourceItems != (owner.id,) or doc.data.sources != (payload.source,):
            raise ContractError('reference_invalid', '本地编辑的来源素材已变化。', owner.id)
        if payload.sourceEditorId is not None:
            raise ContractError('invalid_input', '媒体编辑须使用本次固定的素材输入。', owner.id)
        tool = doc.data.tool
        # Local operations preserve source type, except explicit frame/audio extraction.
        if tool == 'video-frame-capture':
            expected, allowed = 'video', {'image'}
        elif tool == 'extract-audio':
            expected, allowed = 'video', {'audio'}
            if not actual.metadata.hasAudio:
                raise ContractError('invalid_input', '来源视频没有可提取的音轨。', actual.id)
        elif tool in {'video-depth-capture', 'video-extend', 'video-partial-reshoot', 'video-trim', 'video-crop', 'video-edit', 'video-upscale', 'video-frame-interpolation', 'video-subtitle-erasure', 'video-matting', 'video-translation'}:
            expected, allowed = 'video', {'video'}
        elif tool in {'audio-trim', 'audio-separation'}:
            expected, allowed = ('video' if tool == 'audio-separation' and actual.kind == 'video' else 'audio'), {'audio'}
        else:
            expected, allowed = 'image', {'image', 'video'} if tool == 'dynamic-poster' else {'image'}
        if actual.kind != expected:
            raise ContractError('invalid_input', '编辑操作与来源媒体类型不匹配。', actual.id)
        sources = list(asset_references(doc))
    used = {r.assetId for r in asset_references(snapshot)}
    historical = {r.assetId for record in service.projects.history(snapshot.project.id) for r in asset_references(record.snapshot)}
    for ref in sources:
        service._available(service.assets._reference(snapshot, ref))
    for output in payload.outputs:
        asset = service.assets._reference(snapshot, output.asset)
        if asset.kind not in allowed or asset.provenance.source != 'upload' or asset.id in used | historical:
            raise ContractError('role_restricted', '输出必须是尚未发布且类型匹配的真实素材。', asset.id)
        service._available(asset)
        # A storyboard export concatenates its shot list and a camera export
        # runs the selected camera through the document. The actual bytes must
        # match the frozen plan before the asset becomes a rendered result.
        if doc.kind == 'director' and asset.kind == 'video':
            plan = payload.directorPlan
            if plan is None or director_duration is None:
                raise ContractError(
                    'invalid_input',
                    '导演视频发布缺少冻结的输出计划。 Director video publication requires a frozen output plan.',
                    asset.id,
                )
            if (asset.metadata.width, asset.metadata.height) != (plan.width, plan.height):
                raise ContractError(
                    'invalid_input',
                    '预演视频实际尺寸与执行计划不一致。 The preview video dimensions do not match the execution plan.',
                    asset.id,
                )
            if asset.metadata.frameRate is None or not isclose(asset.metadata.frameRate, plan.frameRate, rel_tol=0, abs_tol=0.01):
                raise ContractError(
                    'invalid_input',
                    '预演视频实际帧率与执行计划不一致。 The preview video frame rate does not match the execution plan.',
                    asset.id,
                )
            if asset.metadata.durationSeconds is None or not (
                0 < asset.metadata.durationSeconds and
                director_duration - .15 <= asset.metadata.durationSeconds <= director_duration + .15
            ):
                raise ContractError(
                    'invalid_input',
                    '预演视频实际时长与执行计划不一致。 The preview video duration does not match the execution plan.',
                    asset.id,
                )
        # An image output must be the very bytes of a still this document
        # pinned; a re-import keeps the asset identity fresh but the
        # content fingerprint identical.
        if doc.kind == 'director' and asset.kind == 'image' and all(still.fingerprint != asset.fingerprint for still in doc.data.stills):
            raise ContractError('invalid_input', '图片输出必须是舞台已入库的定格。 Image outputs must be a still this stage pinned.', asset.id)
        if any(i['id'] == str(output.itemId) for i in data['canvasItems']):
            raise ContractError('invalid_input', '输出节点身份已存在。', output.itemId)
        record = service._get(data, 'asset', asset.id)
        record['provenance'] = dict(source='rendered' if doc.kind == 'director' else 'edited', sourceItemId=str(owner.id),
            editorDocumentId=str(doc.id), editorRevision=1, sources=[r.model_dump(mode='json') for r in dict((r.assetId, r) for r in sources).values()])
        result = TypeAdapter(CanvasItem).validate_python(dict(id=output.itemId, projectId=snapshot.project.id, kind=asset.kind,
            title=output.title, position=output.position, width=output.width, height=output.height, binding=dict(role='material', objectRef=output.asset)))
        data['canvasItems'].append(result.model_dump(mode='json'))
    # The frozen document belongs to this execution, never to the next draft.
    data['editorDocuments'].append(doc.model_dump(mode='json'))
