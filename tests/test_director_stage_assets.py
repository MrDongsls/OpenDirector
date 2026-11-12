"""The Director Stage contract keeps imported model identity in project assets."""
from uuid import uuid4

import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.editors import StageObject
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.creation_uploads import CreationUploads
from opendirector.infrastructure.local_projects import LocalProjects


def asset(kind='file'):
    from opendirector.domain.creation.assets import AssetRef

    return AssetRef(
        assetId=uuid4(),
        revision=1,
        fingerprint='sha256:' + 'a' * 64,
        kind=kind,
    )


def object_data(**changes):
    value = dict(
        id='actor',
        kind='gltf',
        name='Imported actor',
        color='#b8c5ff',
        position=dict(x=0.0, y=0.0, z=0.0),
        rotation=dict(x=0.0, y=0.0, z=0.0),
        scale=dict(x=1.0, y=1.0, z=1.0),
        keyframes=(),
        motionClips=(),
        asset=asset(),
        role='character',
        format='glb',
        animationNames=('Walk',),
        hasAnimation=True,
    )
    value.update(changes)
    return value


def test_imported_stage_object_requires_and_round_trips_file_identity():
    parsed = StageObject(**object_data())
    assert parsed.asset is not None
    assert parsed.asset.kind == 'file'
    assert parsed.animationNames == ('Walk',)
    assert parsed.model_dump(mode='json')['asset']['fingerprint'].startswith('sha256:')


@pytest.mark.parametrize(
    'changes',
    [
        {'asset': None},
        {'asset': asset('image')},
        {'role': None},
        {'format': None},
        {'hasAnimation': False},
        {'animationNames': ('Walk', '')},
        {'animationNames': (' ',)},
        {'role': 'scene', 'motionClips': ({
            'id': 'scene-motion',
            'start': 0.0,
            'duration': 1.0,
            'motion': {'preset': 'idle', 'speed': 1.0, 'amount': 1.0},
        },)},
        {'animationNames': (), 'hasAnimation': False, 'motionClips': ({
            'id': 'missing-animation',
            'start': 0.0,
            'duration': 1.0,
            'motion': {'preset': 'walk', 'speed': 1.0, 'amount': 1.0},
        },)},
    ],
)
def test_imported_stage_object_rejects_incomplete_or_incompatible_metadata(changes):
    with pytest.raises(ValueError):
        StageObject(**object_data(**changes))


CAMERA = dict(position=dict(x=5, y=3.5, z=7), target=dict(x=0, y=1, z=0), fov=50)
TRANSFORM = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))


def stage_document(project_id, document_id, objects):
    return dict(id=document_id, projectId=project_id, revision=1, kind='director', inputConnections=[], data=dict(
        background='#151923', grid=True, duration=6, aspectRatio='16:9',
        activeCameraId='camera-1', cameraSource='camera', shots=[],
        cameras=[dict(id='camera-1', name='Camera', pose=dict(CAMERA), keyframes=[])],
        objects=objects))


def imported_stage_object(asset_value):
    return dict(id='actor', kind='gltf', name='Imported actor', color='#b8c5ff',
                keyframes=(), motionClips=(), asset=asset_value, role='character',
                format='glb', animationNames=('Walk',), hasAnimation=True, **TRANSFORM)


def test_editor_commands_resolve_every_imported_stage_asset_against_project_assets(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, session = uuid4(), str(uuid4())
    assert projects.execute(parse_command(dict(projectId=pid, commandId=uuid4(), type='project.create',
                                               payload=dict(name='Assets')))).status == 'applied'
    projects.open(pid, session)

    def send(kind, command_id=None, versions=(), **payload):
        return projects.execute(parse_command(dict(projectId=pid, commandId=command_id or uuid4(),
                                                   type=kind, expectedVersions=versions, payload=payload)),
                                session=session)

    handle = uuid4()
    writer = CreationUploads(projects).begin(pid, handle, session, 'prop.glb')
    try:
        writer.write(b'glTF-sentinel-bytes')
        info = writer.finish()
    finally:
        writer.abort()
    assert send('asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind).status == 'applied'
    asset = projects.snapshot(pid).assets[-1]

    document_id = uuid4()
    document = stage_document(pid, document_id, [imported_stage_object(asset_ref(asset).model_dump(mode='json'))])
    assert send('editor.create', document=document).status == 'applied'

    forged = dict(assetId=str(uuid4()), revision=1, fingerprint='sha256:' + 'b' * 64, kind='file')
    changed = dict(document, data=dict(document['data'], objects=[imported_stage_object(forged)]))
    saved = send('editor.save', versions=[dict(objectType='editor_document', id=document_id, revision=1)],
                 document=changed)
    assert saved.status == 'rejected'
    current = projects.snapshot(pid).editorDocuments[0]
    assert current.id == document_id and current.data.objects[0].asset.assetId == asset.id

    replay = send('editor.save', command_id=saved.commandId,
                  versions=[dict(objectType='editor_document', id=document_id, revision=1)],
                  document=changed)
    assert replay.status == 'rejected' and replay.commandId == saved.commandId
