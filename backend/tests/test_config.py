from sdv.api import config

def test_mapillary_config_does_not_expose_legacy_google_key(monkeypatch):
    monkeypatch.setenv('SIMULATOR_BACKEND','sumo')
    monkeypatch.setenv('MAPILLARY_ACCESS_TOKEN','test-client-token')
    monkeypatch.setenv('GOOGLE_MAPS_API_KEY','legacy-key')
    value=config()
    assert value['imagery_provider']=='mapillary'
    assert value['map_provider']=='openstreetmap'
    assert value['mapillary_access_token']=='test-client-token'
    assert 'google_maps_api_key' not in value


def test_carla_config_does_not_use_external_imagery(monkeypatch):
    monkeypatch.setenv('SIMULATOR_BACKEND','carla')
    monkeypatch.setenv('MAPILLARY_ACCESS_TOKEN','legacy-client-token')
    value=config()
    assert value['backend']=='carla'
    assert value['imagery_provider']=='carla' and value['map_provider']=='carla'
    assert value['mapillary_access_token']==''
