import pytest
from sdv import api


@pytest.mark.asyncio
async def test_api_restart_recovers_unfinished_runs_without_loading_completed_history(monkeypatch,tmp_path):
    unfinished=[{'id':'running','status':'running','recording_valid':True},{'id':'starting','status':'starting','recording_valid':True}]
    saved=[]
    async def request(service,path,method='GET',data=None):
        assert service=='recorder'
        if method=='GET':
            assert path=='/runs?unfinished_only=true', 'Startup must not download the complete recording history'
            return unfinished
        saved.append((path,dict(data)))
        return {'ok':True}
    monkeypatch.setattr(api,'request',request)
    monkeypatch.setattr(api.imagery,'initialize',lambda:None)
    monkeypatch.setattr(api,'Path',lambda value:tmp_path/'provenance.json')
    monkeypatch.setattr(api,'tasks',{})
    monkeypatch.setattr(api,'client',None)
    async with api.lifespan(api.app):
        assert {path for path,_ in saved}=={'/runs/running','/runs/starting'}
        assert all(run['status']=='interrupted' and not run['recording_valid'] for _,run in saved)
    assert api.client.is_closed
