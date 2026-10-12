import io
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image, PngImagePlugin
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sdv import imagery, api


def picture(tag='', brightness=0):
    image = Image.new('RGB', (80, 64))
    image.putdata([(min(255, (x*3+y*2) % 220+brightness), (y*3) % 256, (x*y) % 256)
                   for y in range(64) for x in range(80)])
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('capture', tag)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG', pnginfo=metadata)
    return buffer.getvalue()


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(imagery, 'DBPATH', tmp_path/'images.sqlite')
    imagery.initialize()


def save(data, index=0, run='drive'):
    return imagery.capture(run, index, data, f'provider-{index}', index, 57.7, 11.97, 1700000000000)


def test_phash_is_64_bit_and_tolerates_brightness_and_image_encoding():
    original, media_type = imagery.phash(picture('first'))
    encoded, _ = imagery.phash(picture('another encoding'))
    brighter, _ = imagery.phash(picture('brighter', brightness=8))
    assert len(original) == 16 and media_type == 'image/png'
    assert original == encoded
    assert (int(original, 16) ^ int(brighter, 16)).bit_count() <= imagery.MAX_DISTANCE
    buffer = io.BytesIO()
    Image.new('L', (32, 32), 128).save(buffer, format='PNG')
    assert imagery.phash(buffer.getvalue())[0] == '8000000000000000'


def test_five_other_images_trigger_warning_and_self_is_excluded(database):
    for index in range(5):
        value = save(picture(str(index)), index)
        assert value['similar_count'] == index
        assert not value['too_similar']
    value = save(picture('sixth'), 5)
    assert value['similar_count'] == 5 and value['too_similar']
    assert value['nearest_similarity_pct'] == 100
    assert len(value['matches']) == 5
    assert all(match['image_id'] != value['image_id'] for match in value['matches'])


def test_duplicate_uploads_are_idempotent_but_separate_captures_match(database):
    data = picture()
    with ThreadPoolExecutor(max_workers=6) as pool:
        values = list(pool.map(lambda _: save(data), range(12)))
    assert all(value['database_images'] == 1 for value in values)
    repeated = save(data, 1)
    assert repeated['similar_count'] == 1 and repeated['nearest_similarity_pct'] == 100
    another_drive = save(data, run='another-drive')
    assert another_drive['database_images'] == 1
    assert another_drive['similar_count'] == 2 and another_drive['nearest_similarity_pct'] == 100
    assert another_drive['similar_image_count'] == 1 and another_drive['database_captures'] == 3
    assert imagery.list_images()['items'][0]['captures'] == 3
    with pytest.raises(ValueError, match='different captured image'):
        save(picture('changed'))
    assert imagery.list_images()['total'] == 1


def test_threshold_is_inclusive_and_unrelated_images_clear_warning(database):
    value = save(picture())
    current_hash = int(value['phash'], 16)
    with imagery.connection() as db:
        for index, bits in enumerate((1, 2, 3, 4, 8, 9, 64)):
            db.execute('INSERT INTO images VALUES(?,?,?,?,?)',
                       (f'image-{index}', f'{current_hash ^ ((1 << bits)-1):016x}', 'image/png', b'test', index))
            db.execute('INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)',
                       ('history', index, f'image-{index}', str(index), index, 57.7, 11.97, None))
    value = imagery.similarity('drive', 0)
    assert value['similar_count'] == 5 and value['too_similar']
    assert [item['distance'] for item in value['matches']] == [1, 2, 3, 4, 8]
    with imagery.connection() as db:
        db.execute('UPDATE images SET phash=? WHERE id=?', (f'{current_hash ^ ((1 << 64)-1):016x}', value['image_id']))
    assert not imagery.similarity('drive', 0)['too_similar']


def test_repeated_drives_reach_one_hundred_percent_and_five_capture_warning(database):
    data = picture()
    for index in range(6):
        value = save(data, run=f'drive-{index}')
        assert value['similar_count'] == index
        assert value['database_images'] == 1
        assert value['database_captures'] == index+1
        assert value['nearest_similarity_pct'] == (None if index == 0 else 100)
        assert value['too_similar'] == (index >= 5)
    # A second window, retry, or replay query must not create another observation.
    assert save(data, run='drive-5')['similar_count'] == 5
    assert imagery.similarity('drive-5', 0)['database_captures'] == 6
    assert all(match['run_id'] != 'drive-5' for match in value['matches'])
    assert all(match['exact_image'] and match['distance'] == 0 for match in value['matches'])


def test_capture_gallery_filter_pagination_and_comparison_history(database):
    for index in range(7):
        save(picture(), index=index, run='old-drive')
    save(picture(), run='new-drive')
    page = imagery.list_captures('old-drive', offset=2, limit=3)
    assert page['total'] == 7 and len(page['items']) == 3
    assert [row['station_index'] for row in page['items']] == [4, 3, 2]
    assert page['database_images'] == 1 and page['database_captures'] == 8
    assert page['runs'][0] == {'run_id': 'new-drive', 'captures': 1}
    comparison = imagery.similarity('new-drive', 0, offset=2, limit=2, matches_only=False)
    assert comparison['comparison_total'] == 7
    assert [row['station_index'] for row in comparison['comparisons']] == [2, 3]
    assert comparison['nearest_similarity_pct'] == 100
    assert all(row['run_id'] == 'old-drive' for row in comparison['comparisons'])


def test_images_hashes_and_capture_metadata_survive_reinitialization(database):
    data = picture()
    initial = save(data)
    imagery.initialize()
    assert imagery.similarity('drive', 0) == initial
    assert imagery.image_bytes(initial['image_id']) == (data, 'image/png')
    assert imagery.list_images()['items'][0]['phash'] == initial['phash']
    assert imagery.similarity('drive', 1)['status'] == 'awaiting_capture'


@pytest.mark.parametrize('data', [b'', b'not-an-image', b'\x89PNG\r\n\x1a\n', b'x'*(12*1024*1024+1)])
def test_invalid_images_are_rejected_without_rows(database, data):
    with pytest.raises(ValueError):
        save(data)
    assert imagery.list_images()['total'] == 0


def test_capture_api_validates_input_and_preserves_replay_without_inserts(database, monkeypatch):
    status = ['running']
    async def get_run(rid):
        if rid != 'drive':
            raise HTTPException(404, 'Run not found')
        return {'id': rid, 'status': status[0], 'route': {'distance': 100}}
    monkeypatch.setattr(api, 'get_run', get_run)
    client = TestClient(api.app)
    url = '/api/v1/runs/drive/images/0?provider_image_id=123&sim_time=0&lat=57.7&lng=11.97'
    data = picture()
    response = client.post(url, content=data)
    assert response.status_code == 201
    image_id = response.json()['image_id']
    assert client.get(f'/api/v1/images/{image_id}').content == data
    assert client.get('/api/v1/images').json()['total'] == 1
    assert client.post(url, content=b'invalid').status_code == 422
    assert client.post(url.replace('lat=57.7', 'lat=nan'), content=data).status_code == 422
    assert client.post(url.replace('/images/0?', '/images/9?'), content=data).status_code == 422
    assert client.post(url, content=b'x'*(12*1024*1024+1)).status_code == 413
    status[0] = 'completed'
    assert client.post(url, content=data).status_code == 409
    assert client.get('/api/v1/runs/drive/images/0/similarity').json()['status'] == 'ready'
    assert client.get('/api/v1/images').json()['total'] == 1
    assert client.get('/api/v1/runs/missing/images/0/similarity').status_code == 404
    assert client.get('/api/v1/image-captures?run_id=drive').json()['items'][0]['phash'] == response.json()['phash']
    assert client.get('/api/v1/image-captures/drive/0/similarity').json()['status'] == 'ready'
    assert client.get('/api/v1/image-captures/drive/0/similarity?offset=-1').status_code == 422
    assert client.get('/api/v1/image-captures/drive/8/similarity').status_code == 404
    async def deleted_run(rid):
        raise HTTPException(404, 'Run deleted')
    monkeypatch.setattr(api, 'get_run', deleted_run)
    assert client.get('/api/v1/runs/drive/images/0/similarity').status_code == 404
    assert client.get('/api/v1/image-captures/drive/0/similarity').status_code == 200
