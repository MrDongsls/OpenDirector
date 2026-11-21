"""Director stage service boundary: identity survives create, save, undo, redo and reload."""
from uuid import uuid4

import pytest
from pydantic import ValidationError

from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.editors import DirectorData
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects


@pytest.fixture
def project(tmp_path):
    store = CreationProjects(LocalProjects(tmp_path))
    project_id = uuid4()
    assert send(store, project_id, 'project.create', name='Unified').status == 'applied'
    session = str(uuid4())
    store.open(project_id, session)
    return store, project_id, session


def send(store, project_id, kind, *, session=None, versions=(), **payload):
    command = parse_command(dict(commandId=uuid4(), projectId=project_id, type=kind,
                                expectedVersions=versions, payload=payload))
    return store.execute(command, session=session)


def ver(kind, obj):
    return dict(objectType=kind, id=obj.id, revision=obj.revision)


CAMERA = dict(position=dict(x=5, y=3.5, z=7), target=dict(x=0, y=1, z=0), fov=45)
TRANSFORM = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))


def director_document(project_id, document_id, *, camera_name='Camera 1',
                      camera_keyframes=(), object_keyframes=()):
    """The committed shape the canvas projection sends for a fresh local stage."""
    return dict(id=document_id, projectId=project_id, revision=1, kind='director', inputConnections=[], data=dict(
        background='#151923', grid=True, duration=6, aspectRatio='16:9',
        activeCameraId='camera-1', cameraSource='camera', shots=[],
        cameras=[dict(id='camera-1', name=camera_name, pose=dict(CAMERA), keyframes=list(camera_keyframes))],
        objects=[dict(id='actor', kind='person', name='Actor', color='#a09af9', motionClips=[],
                      keyframes=list(object_keyframes), **TRANSFORM)]))


def test_director_stage_fps_defaults_and_round_trips_through_the_contract():
    document = director_document(uuid4(), uuid4())
    data = DirectorData.model_validate(document['data'])
    assert data.fps == 30
    explicit = DirectorData.model_validate({**document['data'], 'fps': 60})
    assert explicit.fps == 60
    assert explicit.model_dump(mode='json')['fps'] == 60


@pytest.mark.parametrize('fps', [0, 23, 24.0, 29, 61, True])
def test_director_stage_rejects_fps_outside_the_server_contract(fps):
    with pytest.raises(ValidationError):
        DirectorData.model_validate({
            **director_document(uuid4(), uuid4())['data'],
            'fps': fps,
        })


def test_director_stage_object_state_defaults_round_trips_and_rejects_invalid_values():
    data = director_document(uuid4(), uuid4())['data']
    object_data = data['objects'][0]
    validated = DirectorData.model_validate(data)
    assert validated.objects[0].visible is True
    assert validated.objects[0].locked is False
    assert validated.objects[0].opacity == 1
    explicit = DirectorData.model_validate({**data, 'objects': [{**object_data, 'visible': False, 'locked': True, 'opacity': 0.35}]})
    assert explicit.objects[0].visible is False
    assert explicit.objects[0].locked is True
    assert explicit.objects[0].opacity == 0.35
    dumped = explicit.model_dump(mode='json')['objects'][0]
    assert dumped['visible'] is False and dumped['locked'] is True and dumped['opacity'] == 0.35
    for key, value in (('visible', 1), ('locked', 0), ('opacity', -0.1), ('opacity', 1.1), ('opacity', True)):
        with pytest.raises(ValidationError):
            DirectorData.model_validate({**data, 'objects': [{**object_data, key: value}]})

def test_director_stage_environment_and_lights_default_round_trip_and_reject_invalid_values():
    data = director_document(uuid4(), uuid4())['data']
    validated = DirectorData.model_validate(data)
    assert validated.environment.preset == 'studio'
    assert validated.environment.groundColor == '#181818'
    assert validated.environment.groundVisible is True
    assert validated.environment.exposure == 1.0
    assert validated.environment.backgroundAsset is None
    assert [(light.id, light.intensity, light.position.x, light.position.y, light.position.z)
            for light in validated.lights] == [
                ('hemisphere', 2.4, 0, 1, 0),
                ('key', 3.5, 5, 10, 6),
                ('fill', 1.6, -6, 5, -5),
            ]
    explicit = DirectorData.model_validate({
        **data,
        'environment': dict(preset='studio', groundColor='#202020', groundVisible=False, exposure=2.25,
                            backgroundAsset=dict(assetId=str(uuid4()), revision=1,
                                                 fingerprint='sha256:' + 'a' * 64, kind='image')),
        'lights': [dict(light.model_dump(mode='json'), **({'intensity': 4.2} if light.id == 'key' else {}))
                   for light in validated.lights],
    })
    dumped = explicit.model_dump(mode='json')
    assert dumped['environment']['groundColor'] == '#202020'
    assert dumped['environment']['exposure'] == 2.25
    assert dumped['environment']['backgroundAsset']['kind'] == 'image'
    assert dumped['lights'][1]['intensity'] == 4.2
    for preset in ('studio', 'warm-sunset', 'moonlit'):
        accepted = DirectorData.model_validate({
            **data,
            'environment': {'preset': preset, 'groundColor': '#181818', 'groundVisible': True},
        })
        assert accepted.environment.preset == preset
    for invalid in (
        {'environment': {'preset': 'sunset', 'groundColor': '#181818', 'groundVisible': True}},
        {'environment': {'preset': 'studio', 'groundColor': '#fff', 'groundVisible': True}},
        {'environment': {'preset': 'studio', 'groundColor': '#181818', 'groundVisible': True, 'exposure': -0.1}},
        {'environment': {'preset': 'studio', 'groundColor': '#181818', 'groundVisible': True, 'exposure': 4.1}},
        {'environment': {'preset': 'studio', 'groundColor': '#181818', 'groundVisible': True, 'exposure': True}},
        {'environment': {'preset': 'studio', 'groundColor': '#181818', 'groundVisible': True,
                         'backgroundAsset': dict(assetId=str(uuid4()), revision=1,
                                                 fingerprint='sha256:' + 'a' * 64, kind='file')}},
        {'lights': [light.model_dump(mode='json') for light in validated.lights[:2]]},
        {'lights': [dict(light.model_dump(mode='json'), **({'id': 'sun'} if light.id == 'key' else {}))
                    for light in validated.lights]},
        {'lights': [dict(light.model_dump(mode='json'), **({'intensity': 11} if light.id == 'key' else {}))
                    for light in validated.lights]},
        {'lights': [dict(light.model_dump(mode='json'), **({'color': '#fff'} if light.id == 'key' else {}))
                    for light in validated.lights]},
        {'lights': [dict(light.model_dump(mode='json'), **({'position': {'x': 0, 'y': 0}} if light.id == 'key' else {}))
                    for light in validated.lights]},
    ):
        with pytest.raises(ValidationError):
            DirectorData.model_validate({**data, **invalid})
    with pytest.raises(ValidationError, match='Environment exposure must be between 0 and 4.*场景曝光必须在 0 到 4 之间'):
        DirectorData.model_validate({**data, 'environment': {**validated.environment.model_dump(mode='json'), 'exposure': 4.1}})

def test_director_stage_camera_channels_round_trip_and_reject_invalid_values():
    data = director_document(uuid4(), uuid4())['data']
    data['cameras'][0]['channels'] = {
        'position': [dict(id='p', time=2, value=dict(x=8, y=4, z=6))],
        'target': [dict(id='t', time=2, value=dict(x=1, y=2, z=0))],
        'up': [dict(id='u', time=2, value=dict(x=0, y=1, z=0))],
        'focalLength': [dict(id='f', time=2, value=55)],
    }
    validated = DirectorData.model_validate(data)
    assert validated.cameras[0].channels.position[0].value.x == 8
    assert validated.model_dump(mode='json')['cameras'][0]['channels']['focalLength'][0]['value'] == 55
    for channels in (
        {**data['cameras'][0]['channels'], 'focalLength': [dict(id='f', time=2, value=0)]},
        {**data['cameras'][0]['channels'], 'position': [dict(id='p', time=7, value=dict(x=8, y=4, z=6))]},
        {**data['cameras'][0]['channels'], 'target': [dict(id='t', time=2, value=dict(x=1, y=2))]},
    ):
        with pytest.raises(ValidationError):
            DirectorData.model_validate({**data, 'cameras': [{**data['cameras'][0], 'channels': channels}]})

def test_director_stage_identity_survives_save_undo_redo_and_reload(project):
    store, pid, session = project
    document_id, item_id = uuid4(), uuid4()
    receipt = send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=director_document(pid, document_id))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='external',
            title='Director Stage', binding=dict(role='editor', objectRef=dict(id=document_id, kind='director')))))])
    assert receipt.status == 'applied', receipt

    def stage(from_store=None):
        snapshot = (from_store or store).snapshot(pid)
        return (next(i for i in snapshot.canvasItems if i.id == item_id),
                next(d for d in snapshot.editorDocuments if d.id == document_id))

    item, document = stage()
    assert (item.kind, item.binding.role, item.binding.objectRef.kind) == ('external', 'editor', 'director')
    assert item.binding.objectRef.id == document.id
    assert document.kind == 'director' and document.revision == 1
    assert not document.data.cameras[0].keyframes and not document.data.objects[0].keyframes

    reread_item, reread_document = stage()
    assert reread_item == item and reread_document == document

    saved_document = director_document(pid, document_id, camera_name='验收机位',
        camera_keyframes=[dict(id='cam-6', time=6, value=dict(CAMERA, position=dict(x=2, y=3.5, z=7)))],
        object_keyframes=[dict(id='obj-6', time=6, value=dict(TRANSFORM, position=dict(x=2, y=0, z=0)))])
    saved_document['data']['fps'] = 60
    saved = send(store, pid, 'director.apply', session=session,
        versions=[ver('editor_document', document)], document=saved_document)
    assert saved.status == 'applied', saved
    saved_item, edited = stage()
    assert saved_item.id == item.id and edited.id == document.id
    assert edited.revision == 2 and edited.data.cameras[0].name == '验收机位'
    assert edited.data.fps == 60
    assert [f.time for f in edited.data.cameras[0].keyframes] == [6]
    assert [f.time for f in edited.data.objects[0].keyframes] == [6]
    assert edited.data.objects[0].id == document.data.objects[0].id

    assert send(store, pid, 'history.undo', session=session,
        versions=[ver('editor_document', edited)], targetCommandId=saved.commandId).status == 'applied'
    undo_item, undo_document = stage()
    assert (undo_item.id, undo_document.id) == (item.id, document.id)
    assert undo_document.revision == 3 and undo_document.data == document.data
    assert undo_item.binding == item.binding

    assert send(store, pid, 'history.redo', session=session,
        versions=[ver('editor_document', undo_document)], targetCommandId=saved.commandId).status == 'applied'
    redo_item, redo_document = stage()
    assert (redo_item.id, redo_document.id) == (item.id, document.id)
    assert redo_document.revision == 4 and redo_document.data == edited.data
    assert redo_item.binding == item.binding

    reloaded = CreationProjects(LocalProjects(store.local.repository))
    reopen_item, reopen_document = stage(reloaded)
    assert reopen_item == redo_item and reopen_document == redo_document


def test_director_apply_is_director_only_atomic_and_idempotent(project):
    store, pid, session = project
    document_id, item_id = uuid4(), uuid4()
    created = send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=director_document(pid, document_id))),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='external',
            title='Director Stage', binding=dict(role='editor', objectRef=dict(id=document_id, kind='director')))))])
    assert created.status == 'applied'
    document = next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id)
    changed = director_document(pid, document_id, camera_name='Shared apply')
    command_id = uuid4()
    command = parse_command(dict(commandId=command_id, projectId=pid, type='director.apply',
        expectedVersions=[ver('editor_document', document)], payload=dict(document=changed)))
    first = store.execute(command, session=session)
    second = store.execute(command, session=session)
    assert first == second and first.status == 'applied'
    current = next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id)
    assert current.data.cameras[0].name == 'Shared apply'
    conflicting_document = director_document(pid, document_id, camera_name='Different')
    conflicting_document['revision'] = current.revision
    conflict = parse_command(dict(commandId=command_id, projectId=pid, type='director.apply',
        expectedVersions=[ver('editor_document', current)], payload=dict(document=conflicting_document)))
    with pytest.raises(ProjectError):
        store.execute(conflict, session=session)
    with pytest.raises(ValidationError):
        parse_command(dict(commandId=uuid4(), projectId=pid, type='director.apply', payload=dict(
            document={**changed, 'kind': 'timeline'})))

    lock_only = director_document(pid, document_id)
    lock_only['revision'] = current.revision
    lock_only['data']['objects'][0]['locked'] = True
    locked_receipt = send(store, pid, 'director.apply', session=session,
        versions=[ver('editor_document', current)], document=lock_only)
    assert locked_receipt.status == 'applied'
    current = next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id)
    locked = director_document(pid, document_id)
    locked['revision'] = current.revision
    locked['data']['objects'][0]['locked'] = True
    locked['data']['objects'][0]['position'] = {'x': 3, 'y': 0, 'z': 0}
    rejected = send(store, pid, 'director.apply', session=session,
        versions=[ver('editor_document', current)], document=locked)
    assert rejected.status == 'rejected' and rejected.issues[0].code == 'role_restricted'
    unchanged = next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id)
    assert unchanged == current

    editor_save_bypass = director_document(pid, document_id)
    editor_save_bypass['revision'] = current.revision
    editor_save_bypass['data']['objects'][0]['locked'] = True
    editor_save_bypass['data']['objects'][0]['position'] = {'x': 4, 'y': 0, 'z': 0}
    bypass = send(store, pid, 'editor.save', session=session,
        versions=[ver('editor_document', current)], document=editor_save_bypass)
    assert bypass.status == 'rejected' and bypass.issues[0].code == 'role_restricted'
    assert next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id) == current

    unlock = director_document(pid, document_id)
    unlock['revision'] = current.revision
    unlock['data']['objects'][0]['locked'] = False
    unlock['data']['objects'][0]['position'] = current.data.objects[0].position.model_dump(mode='json')
    unlocked = send(store, pid, 'director.apply', session=session,
        versions=[ver('editor_document', current)], document=unlock)
    assert unlocked.status == 'applied'
    current = next(d for d in store.snapshot(pid).editorDocuments if d.id == document_id)
    item = next(i for i in store.snapshot(pid).canvasItems if i.id == item_id)
    batched = director_document(pid, document_id, camera_name='Batch apply')
    batched['revision'] = current.revision
    batch = send(store, pid, 'creation.batch', session=session,
        versions=[ver('editor_document', current), ver('canvas_item', item)], operations=[
            dict(type='director.apply', payload=dict(document=batched)),
            dict(type='canvas.update', payload=dict(itemId=item_id, title='Batch Stage'))])
    assert batch.status == 'applied'
    snapshot = store.snapshot(pid)
    assert next(d for d in snapshot.editorDocuments if d.id == document_id).data.cameras[0].name == 'Batch apply'
    assert next(i for i in snapshot.canvasItems if i.id == item_id).title == 'Batch Stage'
