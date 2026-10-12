from sdv.api import config

def test_mapillary_config_does_not_expose_legacy_google_key(monkeypatch):
    monkeypatch.setenv('MAPILLARY_ACCESS_TOKEN','test-client-token')
    monkeypatch.setenv('GOOGLE_MAPS_API_KEY','legacy-key')
    value=config()
    assert value['imagery_provider']=='mapillary'
    assert value['map_provider']=='openstreetmap'
    assert value['mapillary_access_token']=='test-client-token'
    assert 'google_maps_api_key' not in value
