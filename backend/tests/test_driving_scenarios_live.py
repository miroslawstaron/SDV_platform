"""Opt-in prompt scenario acceptance against the running native CARLA platform."""
import io
import os
import time
import httpx
import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(os.getenv('SDV_CARLA_LIVE') != '1', reason='Requires an idle running CARLA platform')
URL = os.getenv('SDV_URL', 'http://api:8000/api/v1')


@pytest.mark.parametrize('prompt,pedestrians,traffic,rain,sun', [
    ('8 pedestrians, 3 cars, heavy rain at night, 20 km/h, 200 m, for 8 seconds, seed 17', 8, 3, 85, -30),
    ('No pedestrians and no traffic, no crossings, clear daytime, 15 km/h, 300 m, for 8 seconds', 0, 0, 0, 75),
])
def test_prompt_changes_carla_world_and_preserves_recording(prompt, pedestrians, traffic, rain, sun):
    with httpx.Client(base_url=URL, timeout=20) as client:
        def call(path, method='GET', data=None):
            response = client.request(method, path, json=data)
            response.raise_for_status()
            return response.json()
        if call('/health')['active_run']:pytest.skip('Keep the existing drive running')
        scenario = call('/scenarios', 'POST', {'name': 'Prompt acceptance test', 'prompt': prompt})
        rid = None
        try:
            run = call('/runs', 'POST', {'scenario_id': scenario['id'], 'carla': {'graphics': 'low', 'resolution': '720p'},
                                       'assertions': [{'kind': 'no_recorder_loss'}]})
            rid = run['id']
            assert run['configuration']['scenario'] == scenario
            assert run['configuration']['duration'] == 8
            call(f'/runs/{rid}/start', 'POST')
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                run = call(f'/runs/{rid}')
                if run['status'] not in ('starting', 'running'):break
                time.sleep(.5)
            assert run['status'] == 'timed_out', run
            assert run['recording_valid'] and run['results'][0]['passed']
            assert run['peak_speed'] > .5
            end = call(f'/runs/{rid}/timeline?at=8&window=0.05')
            state = end['state']
            assert state['pedestrian_count'] == pedestrians and state['traffic_count'] == traffic
            assert state['speed_limit'] <= scenario['settings']['speed_kmh'] / 3.6 + .001
            status = call('/carla/status')
            assert status['weather']['precipitation'] == pytest.approx(rain)
            assert status['weather']['sun_altitude_angle'] == pytest.approx(sun)
            assert status['scenario']['crossings'] == scenario['settings']['crossings']
            for view in ('driver', 'chase'):
                image = client.get(f'/runs/{rid}/carla/camera/{view}?at=4')
                image.raise_for_status()
                assert Image.open(io.BytesIO(image.content)).size == (1280, 720)
            assert any(event['protocol'] == 'CAN' for event in end['events'])
            call(f'/runs/{rid}/replay', 'POST', {'at': 4})
            assert call(f'/runs/{rid}')['configuration']['scenario'] == scenario
        finally:
            if rid and call('/health')['active_run'] == rid:client.post(f'/runs/{rid}/stop')
            client.delete(f"/scenarios/{scenario['id']}")
