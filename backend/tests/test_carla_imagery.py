import io
import json
import sqlite3
import uuid

import pytest
from PIL import Image
from sdv import imagery, carla_backend
from sdv.carla_imagery import CameraCaptures, backfill_recordings


@pytest.fixture
def archive(tmp_path, monkeypatch):
    monkeypatch.setattr(imagery, 'DBPATH', tmp_path / 'images.sqlite')
    monkeypatch.setattr(carla_backend, 'CAMERA_ROOT', tmp_path / 'carla')
    imagery.initialize()
    image = Image.new('RGB', (64, 64))
    image.putdata([(x * 4, y * 4, (x * y) % 256) for y in range(64) for x in range(64)])
    buffer = io.BytesIO()
    image.save(buffer, format='JPEG')
    path = tmp_path / 'frame.jpg'
    path.write_bytes(buffer.getvalue())
    return path


def state(time, remaining=500, lat=1):
    return dict(time=time, remaining=remaining, lat=lat, lng=2)


def test_asynchronous_frames_use_past_telemetry_and_each_station_counts_once(archive):
    info = {}
    captures = CameraCaptures('city', 500, info)
    try:
        captures.observe_state(state(0))
        captures.observe_frame(archive, .2)
        captures.observe_state(state(.15))
        captures.jobs.join()
        assert imagery.list_captures('city')['total'] == 0
        captures.observe_state(state(.2, 475, lat=3))
        captures.observe_state(state(.4, 450, lat=4))
        captures.observe_frame(archive, .3)  # Late delivery: still belongs to station 1.
        captures.observe_frame(archive, .4)
        captures.observe_frame(archive, .45)
        captures.observe_state(state(.5, 450))
    finally:
        captures.close()
    rows = {row['station_index']: row for row in imagery.list_captures('city')['items']}
    assert set(rows) == {1, 2}
    assert rows[1]['sim_time'] == .2 and rows[1]['lat'] == 3
    assert rows[2]['sim_time'] == .4 and rows[2]['lat'] == 4
    assert all(row['source'] == 'carla' for row in rows.values())
    assert info['image_captures'] == 2


def test_capture_failure_is_reported_and_next_frame_retries_the_station(archive):
    info = {}
    captures = CameraCaptures('retry', 500, info)
    try:
        captures.observe_state(state(.2))
        captures.observe_frame(archive.with_name('missing.jpg'), .1)
        # A frame before the earliest state must be ignored, rather than using future state.
        captures.jobs.join()
        assert not info
        captures.observe_frame(archive.with_name('missing.jpg'), .2)
        captures.jobs.join()
        assert info['similarity_error']
        captures.observe_frame(archive, .2)
    finally:
        captures.close()
    assert info['image_captures'] == 1 and 'similarity_error' not in info
    assert imagery.similarity('retry', 0)['status'] == 'ready'


def test_repeated_carla_drives_share_images_and_restore_the_five_match_warning(archive):
    for index in range(6):
        captures = CameraCaptures(f'city-{index}', 500, {})
        captures.observe_state(state(.2))
        captures.observe_frame(archive, .2)
        captures.close()
    value = imagery.similarity('city-5', 0)
    assert value['nearest_similarity_pct'] == 100
    assert value['similar_count'] == 5 and value['too_similar']
    assert value['database_images'] == 1 and value['database_captures'] == 6
    assert all(match['source'] == 'carla' for match in value['matches'])


def test_backfill_uses_archived_driver_frames_and_is_idempotent(archive, tmp_path):
    rid, active = str(uuid.uuid4()), str(uuid.uuid4())
    directory = carla_backend.camera_path(rid) / 'driver'
    directory.mkdir(parents=True)
    for stamp in (100, 300):
        (directory / f'{stamp:012d}.jpg').write_bytes(archive.read_bytes())
    recording = tmp_path / 'recordings.sqlite'
    with sqlite3.connect(recording) as db:
        db.executescript('CREATE TABLE runs(id TEXT,data TEXT); CREATE TABLE ticks(run TEXT,t REAL,state TEXT)')
        for run_id, status in ((rid, 'stopped'), (active, 'running')):
            db.execute('INSERT INTO runs VALUES(?,?)', (run_id, json.dumps(dict(
                route=dict(backend='carla', distance=500), status=status))))
        for t, remaining in ((.05, 500), (.15, 500), (.25, 475), (.35, 450)):
            db.execute('INSERT INTO ticks VALUES(?,?,?)', (rid, t, json.dumps(state(t, remaining))))
    assert backfill_recordings(recording) == [{'run_id': rid, 'image_captures': 2}]
    assert backfill_recordings(recording) == [{'run_id': rid, 'image_captures': 0}]
    rows = {row['station_index']: row for row in imagery.list_captures(rid)['items']}
    assert set(rows) == {0, 1}
    assert rows[0]['sim_time'] == .1 and rows[1]['sim_time'] == .3
    assert imagery.similarity(rid, 1)['similar_count'] == 1
