import uuid
import pytest
from fastapi import HTTPException
from sdv.application import compute
from sdv.carla_backend import city_route, energy_step, fresh_signals
from sdv.models import Vehicle
from sdv.sdk import DB


def test_city_preset_is_independent_of_osm_and_mapillary():
    route = city_route()
    assert route['backend'] == 'carla'
    assert route['scenario']['pedestrians'] == 48
    assert route['scenario']['traffic_vehicles'] == 8
    assert route['world'] == 'Town10HD_Opt'
    assert 'network' not in route and 'edges' not in route


def test_pedestrian_perception_passes_through_can_and_controller():
    vehicle = Vehicle().model_dump()
    truth = dict(speed=4, lat=0, lng=0, heading=90, remaining=100,
                 speed_limit=7, lane_index=0, obstacle_distance=2,
                 pedestrian_hazard=True)
    sensor = compute('sensor', {'sequence': 1, 'truth': truth})['can'][0][1]
    message = DB.get_message_by_frame_id(256)
    signals = message.decode(message.encode(sensor))
    assert signals['PedestrianHazard'] == 1
    assert signals['ObstacleDistance'] == pytest.approx(2)
    context = {'sequence': 1, 'vehicle': vehicle, 'network': {
        'available': True, 'intent_age': 0, 'intent': {'target_speed': 7},
        'frames': {'256': {'age': 0, 'signals': signals}}}}
    command = compute('controller', context)['can'][0][1]
    assert command['Acceleration'] == 0
    assert command['Deceleration'] == vehicle['normal_decel']
    context['network']['frames']['512'] = {'age': 0, 'signals': command}
    assert compute('brake', context)['can'][0][1]['Deceleration'] > 0


def test_stale_carla_actuator_frame_cannot_accelerate():
    network = {'frames': {'528': {'age': .201, 'signals': {'Acceleration': 6}}}}
    assert fresh_signals(network, 528) == {}


def test_server_wait_retries_until_native_server_starts(monkeypatch):
    from contextlib import nullcontext
    from sdv import carla_backend
    attempts = []
    def connect(address, timeout):
        attempts.append(address)
        if len(attempts) < 3:
            raise ConnectionRefusedError('Server is still starting')
        return nullcontext()
    monkeypatch.setattr(carla_backend.socket, 'create_connection', connect)
    monkeypatch.setattr(carla_backend.time, 'sleep', lambda _: None)
    carla_backend.wait_for_server('native-host', 2000)
    assert attempts == [('native-host', 2000)] * 3


def test_server_wait_has_a_deadline(monkeypatch):
    from sdv import carla_backend
    times = iter([0, 0, 1, 2])
    monkeypatch.setattr(carla_backend.time, 'monotonic', lambda: next(times))
    monkeypatch.setattr(carla_backend.time, 'sleep', lambda _: None)
    def connect(*args, **kwargs):
        raise ConnectionRefusedError('No server')
    monkeypatch.setattr(carla_backend.socket, 'create_connection', connect)
    with pytest.raises(RuntimeError, match='did not start at native-host:2000 within 1 seconds'):
        carla_backend.wait_for_server('native-host', 2000, timeout=1)


def test_energy_model_consumes_and_regenerates_in_wh():
    vehicle = Vehicle().model_dump()
    power, wh = energy_step(vehicle, 8, 1, .05)
    assert power > 0 and wh == pytest.approx(power * .05 / 3600)
    power, wh = energy_step(vehicle, 8, -3, .05)
    assert power < 0 and wh < 0


@pytest.mark.asyncio
async def test_camera_replay_never_returns_a_future_frame(tmp_path, monkeypatch):
    from sdv import api, carla_backend
    rid = str(uuid.uuid4())
    monkeypatch.setattr(carla_backend, 'CAMERA_ROOT', tmp_path)
    async def run(_):
        return {'route': {'backend': 'carla'}}
    monkeypatch.setattr(api, 'get_run', run)
    directory = tmp_path / rid / 'driver'
    directory.mkdir(parents=True)
    for stamp in (50, 250, 450):
        (directory / f'{stamp:012d}.jpg').write_bytes(b'frame')
    response = await api.carla_camera(rid, 'driver', at=.3)
    assert response.path.name == '000000000250.jpg'
    assert response.headers['x-carla-simulation-time'] == '0.25'
    with pytest.raises(HTTPException) as error:
        await api.carla_camera(rid, 'driver', at=0)
    assert error.value.status_code == 404
    response = await api.carla_camera(rid, 'driver', at=None)
    assert response.path.name == '000000000450.jpg'


@pytest.mark.asyncio
async def test_old_recording_does_not_show_current_carla_camera(monkeypatch):
    from sdv import api
    async def run(_):
        return {'route': {'backend': 'sumo'}}
    monkeypatch.setattr(api, 'get_run', run)
    with pytest.raises(HTTPException) as error:
        await api.carla_camera(str(uuid.uuid4()), 'driver', at=None)
    assert error.value.status_code == 404
