import json
import httpx
import pytest
from sdv import api, driving_scenarios as scenarios
from sdv.carla_backend import city_route
from sdv.models import RunRequest, ScenarioPrompt


@pytest.mark.parametrize('prompt,expected', [
    ('Drive in heavy rain at night with 12 pedestrians and 6 cars, at 25 km/h, for 500 m and 2 minutes.',
     dict(weather='heavy_rain', time_of_day='night', pedestrians=12, traffic_vehicles=6, speed_kmh=25, distance_m=500, duration_seconds=120)),
    ('Drive in clear daytime with 5 pedestrians and 2 cars, at 20 km/h, for 800 m and 3 minutes.',
     dict(weather='clear', time_of_day='day', pedestrians=5, traffic_vehicles=2, speed_kmh=20, distance_m=800, duration_seconds=180)),
    ('Drive with 80 pedestrians, 16 cars and frequent pedestrian crossings, at 15 km/h, for 400 m and 3 minutes.',
     dict(pedestrians=80, traffic_vehicles=16, crossings='frequent', speed_kmh=15, distance_m=400, duration_seconds=180)),
    ('No pedestrians and no traffic, without crossings, cloudy at sunset, 1 km, 30 seconds, seed 17.',
     dict(pedestrians=0, traffic_vehicles=0, crossings='none', weather='cloudy', time_of_day='sunset', distance_m=1000, duration_seconds=30, seed=17)),
    ('A busy city with five cars and twenty-five pedestrians at 20 mph for 0.5 km.',
     dict(pedestrians=25, traffic_vehicles=5, speed_kmh=32.187, distance_m=500)),
])
def test_interprets_city_prompts_and_units(prompt, expected):
    result = scenarios.interpret(prompt)
    assert result['unrecognized'] == []
    assert {key: result['settings'][key] for key in expected} == expected


@pytest.mark.parametrize('prompt', ['101 pedestrians', '41 cars', '90 km/h', '50 m', '3 km', '20 minutes', '-5 pedestrians', '.5 minutes', '10 pedestrians and 20 pedestrians', 'sunset at night', 'clear and heavy rain', 'do something amazing'])
def test_invalid_or_conflicting_instructions_do_not_silently_use_defaults(prompt):
    with pytest.raises(ValueError):scenarios.interpret(prompt)


def test_unmatched_instructions_must_be_reviewed_and_are_retained(tmp_path, monkeypatch):
    monkeypatch.setattr(scenarios, 'DBPATH', tmp_path / 'library.sqlite')
    data = ScenarioPrompt(name='Custom', prompt='20 pedestrians and an ambulance overtakes then turn left in Stockholm')
    preview = scenarios.interpret(data.prompt)
    assert {'ambulance', 'overtakes', 'turn', 'left', 'stockholm'} <= set(preview['unrecognized'])
    with pytest.raises(ValueError, match='Review the unrecognized'):scenarios.save_scenario(data)
    saved = scenarios.save_scenario(data.model_copy(update={'accept_unrecognized': True}))
    assert saved['unrecognized'] == preview['unrecognized']
    assert scenarios.get_scenario(saved['id']) == saved


def test_scenario_route_and_weather_apply_supported_settings():
    settings = scenarios.interpret('No pedestrians, 3 cars, 20 km/h, 800 m, heavy rain at night')['settings']
    route = city_route(settings)
    assert route['distance'] == 800 and route['scenario']['pedestrians'] == 0
    assert route['scenario']['traffic_vehicles'] == 3
    assert route['scenario']['speed_limit'] == pytest.approx(20 / 3.6)
    weather = scenarios.weather_parameters(route['scenario'])
    assert weather['sun_altitude_angle'] < 0 and weather['precipitation'] == 85


@pytest.mark.asyncio
async def test_library_crud_and_recording_snapshot_survive_template_edit_and_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(scenarios, 'DBPATH', tmp_path / 'library.sqlite')
    saved_runs = []
    async def request(service, path, method='GET', data=None):
        assert service == 'recorder' and method == 'POST'
        saved_runs.append(json.loads(json.dumps(data)))
        return {'ok': True}
    monkeypatch.setattr(api, 'request', request)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test') as client:
        data = dict(name='Rainy evening', prompt='8 pedestrians, 3 cars, 20 km/h, 800 m, for 2 minutes, rain at sunset, seed 17')
        response = await client.post('/api/v1/scenarios/preview', json=data)
        assert response.status_code == 200 and response.json()['unrecognized'] == []
        response = await client.post('/api/v1/scenarios', json=data)
        assert response.status_code == 201
        scenario = response.json()
        assert (await client.get('/api/v1/scenarios')).json() == [scenario]
        response = await client.post('/api/v1/runs', json={'scenario_id': scenario['id'], 'carla': {'graphics': 'low', 'resolution': '720p'}})
        assert response.status_code == 201
        run = response.json()
        assert run['configuration']['scenario'] == scenario
        assert run['configuration']['duration'] == 120 and run['configuration']['seed'] == 17
        assert run['configuration']['carla'] == dict(graphics='low', resolution='720p')
        assert run['route']['name'] == data['name'] and run['route']['scenario']['pedestrians'] == 8
        assert run['route']['distance'] == 800
        response = await client.put(f"/api/v1/scenarios/{scenario['id']}", json={**data, 'prompt': '80 pedestrians in clear daytime'})
        assert response.status_code == 200 and response.json()['settings']['pedestrians'] == 80
        assert saved_runs[0]['configuration']['scenario']['settings']['pedestrians'] == 8
        assert (await client.delete(f"/api/v1/scenarios/{scenario['id']}")).status_code == 200
        assert (await client.get('/api/v1/scenarios')).json() == []
        # Rerun uses the immutable recording snapshot even after the template is gone.
        repeated = await client.post('/api/v1/runs', json=run['configuration'])
        assert repeated.status_code == 201
        assert repeated.json()['configuration']['scenario'] == scenario
        assert (await client.post('/api/v1/runs', json={'scenario_id': scenario['id']})).status_code == 404
        assert (await client.post('/api/v1/runs', json={'route_id': 'other', 'scenario_id': scenario['id']})).status_code == 422
        assert (await client.post('/api/v1/scenarios/preview', json={'prompt': '10000 cars'})).status_code == 422
        assert (await client.post('/api/v1/scenarios', json={'prompt': '10 cars and jump over a bridge'})).status_code == 422


def test_structured_scenario_settings_are_validated_for_reruns():
    with pytest.raises(ValueError):
        RunRequest(scenario={'id': 'test', 'name': 'Bad', 'prompt': 'Bad', 'settings': {'traffic_vehicles': 100000}})
