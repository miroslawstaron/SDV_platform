"""Opt-in CARLA acceptance: SDV_CARLA_LIVE=1; requires an idle running platform."""
import io
import os
import time
import httpx
import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(os.getenv('SDV_CARLA_LIVE') != '1', reason='Requires a running CARLA server')
URL = os.getenv('SDV_URL', 'http://api:8000/api/v1')


@pytest.mark.parametrize('graphics,resolution,dimensions', [('low', '720p', (1280, 720)), ('high', '1080p', (1920, 1080))])
def test_city_motion_cameras_replay_and_real_ecu_transport(graphics, resolution, dimensions):
    with httpx.Client(base_url=URL, timeout=20) as client:
        def call(path, method='GET', data=None):
            response = client.request(method, path, json=data)
            response.raise_for_status()
            return response.json()
        if call('/health')['active_run']:
            pytest.skip('Keep the existing active drive running')
        run = call('/runs', 'POST', {'route_id': 'carla-city', 'duration': 8,
                                    'carla': {'graphics': graphics, 'resolution': resolution},
                                    'assertions': [{'kind': 'no_recorder_loss'}]})
        rid = run['id']
        try:
            call(f'/runs/{rid}/start', 'POST')
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                run = call(f'/runs/{rid}')
                if run['status'] not in ('starting', 'running'):
                    break
                time.sleep(.5)
            assert run['status'] == 'timed_out', run
            assert run['recording_valid'] and run['results'][0]['passed']
            assert run['configuration']['carla'] == {'graphics': graphics, 'resolution': resolution}
            assert run['peak_speed'] > .5
            assert run['route']['carla_roads'] and run['route']['carla_geometry']
            early = call(f'/runs/{rid}/timeline?at=1')['state']
            end = call(f'/runs/{rid}/timeline?at=8&window=0.05')
            late = end['state']
            assert any(e['protocol'] == 'CAN' for e in end['events']), 'Final ECU cycle must align with the simulator clock'
            assert late['progress'] > early['progress']
            assert late['pedestrian_count'] >= 32 and late['traffic_count'] >= 4
            previous = {a['id']: a for a in early['carla_actors'] if a['kind'] == 'pedestrian'}
            assert sum(abs(a['x'] - previous[a['id']]['x']) + abs(a['y'] - previous[a['id']]['y']) > .2
                       for a in late['carla_actors'] if a['id'] in previous) >= 25
            for view in ('driver', 'chase'):
                response = client.get(f'/runs/{rid}/carla/camera/{view}?at=4')
                response.raise_for_status()
                assert float(response.headers['x-carla-simulation-time']) <= 4
                image = Image.open(io.BytesIO(response.content))
                assert image.size == dimensions
            similarity = call(f'/runs/{rid}/images/0/similarity')
            assert similarity['status'] == 'ready'
            assert similarity['source'] == 'carla'
            assert similarity['provider_image_id'].startswith('carla:driver:')
            count = similarity['database_captures']
            call(f'/runs/{rid}/replay', 'POST', {'at': 4})
            assert call(f'/runs/{rid}/images/0/similarity')['database_captures'] == count
            events = []
            after = 0
            while True:
                batch = call(f'/runs/{rid}/events?after={after}&limit=5000')
                if not batch:
                    break
                events.extend(batch)
                after = batch[-1]['event_id']
            received = {e.get('message_id') for e in events if e['module'] == 'plant' and e['protocol'] == 'CAN' and e['kind'] == 'rx'}
            assert {528, 544, 560} <= received
            assert any(e['protocol'] == 'SOME/IP' for e in events)
        finally:
            if call('/health')['active_run'] == rid:
                response = client.post(f'/runs/{rid}/stop')
                assert response.status_code in (200, 409)
