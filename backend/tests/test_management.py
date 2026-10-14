import io
import json
import random

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sdv import api, imagery, maps, recorder


def picture(color):
    output=io.BytesIO()
    image=Image.new('RGB',(16,16))
    generator=random.Random(color)
    image.putdata([tuple(generator.randrange(256) for _ in range(3)) for _ in range(16*16)])
    image.save(output,format='PNG')
    return output.getvalue()


@pytest.fixture
def environment(tmp_path,monkeypatch):
    monkeypatch.setattr(imagery,'DBPATH',tmp_path/'images.sqlite')
    monkeypatch.setattr(recorder,'DBPATH',tmp_path/'recordings.sqlite')
    monkeypatch.setattr(api,'active',None)
    monkeypatch.setattr(api,'current',{})
    monkeypatch.setattr(api,'tasks',{})
    imagery.initialize()
    with TestClient(recorder.app) as store:
        async def request(service,path,method='GET',data=None,**options):
            if service=='recorder':
                response=store.request(method,path,json=data)
                if response.is_error:raise HTTPException(response.status_code,response.json()['detail'])
                return response.json()
            return {'status':'ready'}
        monkeypatch.setattr(api,'request',request)
        yield TestClient(api.app),store


def capture(run,image):
    return imagery.capture(run,0,image,'mapillary-source',1,57.7,11.97)


def test_uploaded_references_are_deduplicated_and_used_in_similarity(environment):
    client,_=environment
    data=picture('red')
    first=client.post('/api/v1/management/images?filename=reference.png',content=data)
    assert first.status_code==201
    image_id=first.json()['image_id']
    assert client.post('/api/v1/management/images?filename=reference.png',content=data).status_code==201
    assert imagery.list_images()['total']==1
    assert imagery.statistics_summary()['references']==1
    assert client.get('/api/v1/images/'+image_id).content==data
    assert imagery.list_images()['items'][0]['reference_label']=='reference.png'
    result=capture('new-drive',data)
    assert result['similar_count']==1 and result['nearest_similarity_pct']==100
    assert imagery.list_captures('reference-library')['total']==1
    reference=imagery.list_captures('reference-library')['items'][0]
    assert reference['source']=='uploaded' and reference['lat'] is None and reference['lng'] is None
    assert imagery.list_captures()['runs'][1]['run_id']=='reference-library'


def test_image_deletion_removes_all_references_atomically(environment):
    client,_=environment
    data=picture('red')
    image_id=capture('one',data)['image_id']
    capture('two',data)
    client.post('/api/v1/management/images?filename=reference.png',content=data)
    missing=client.request('DELETE','/api/v1/management/images',json={'ids':[image_id,'missing']})
    assert missing.status_code==404
    assert imagery.statistics_summary()['captures']==3
    deleted=client.request('DELETE','/api/v1/management/images',json={'ids':[image_id]}).json()
    assert deleted=={'images_deleted':1,'captures_deleted':3}
    assert client.get('/api/v1/images/'+image_id).status_code==404
    assert imagery.similarity('one',0)['status']=='awaiting_capture'
    assert imagery.list_captures()['total']==0


def test_recording_cleanup_keeps_shared_assets_and_retains_history_by_default(environment):
    client,store=environment
    for rid in ('one','two','three'):
        store.post('/runs/'+rid,json={'id':rid,'status':'completed','time':1})
        store.post('/runs/'+rid+'/tick',json={'time':1,'state':{'speed':0},'events':[{'sim_time':1,'kind':'tx'}]})
    shared=capture('one',picture('red'))['image_id']
    capture('two',picture('red'))
    unique=imagery.capture('one',1,picture('green'),'other-source',1,57.7,11.97)
    capture('three',picture('blue'))
    first=client.request('DELETE','/api/v1/management/recordings',json={'ids':['three']})
    assert first.status_code==200 and first.json()['ticks_deleted']==1
    assert imagery.list_captures('three')['total']==1
    second=client.request('DELETE','/api/v1/management/recordings',json={'ids':['one'],'include_images':True}).json()
    assert second['captures_deleted']==2 and second['images_deleted']==1
    assert imagery.image_bytes(shared) is not None
    assert imagery.image_bytes(unique['image_id']) is None
    assert store.get('/runs/two').status_code==200
    assert store.get('/runs/one').status_code==404
    remaining=client.request('DELETE','/api/v1/management/recordings',json={'all':True}).json()
    assert remaining['runs_deleted']==1
    assert imagery.statistics_summary()['captures']==2
    assert client.request('DELETE','/api/v1/management/images',json={'all':True}).json()['images_deleted']==2
    assert client.get('/api/v1/management/overview').json()['recordings']['runs']==0


@pytest.mark.parametrize('method,path,body',[
    ('DELETE','/api/v1/management/recordings',{'all':True}),
    ('DELETE','/api/v1/management/images',{'all':True}),
    ('POST','/api/v1/management/reset',None),
    ('DELETE','/api/v1/management/routes/'+'a'*20,None),
    ('POST','/api/v1/management/images?filename=reference.png',None),
])
def test_environment_changes_are_blocked_during_a_drive(environment,monkeypatch,method,path,body):
    client,store=environment
    store.post('/runs/live',json={'id':'live','status':'running'})
    capture('live',picture('red'))
    monkeypatch.setattr(api,'active','live')
    response=client.request(method,path,json=body)
    assert response.status_code==409
    assert imagery.statistics_summary()['images']==1
    assert store.get('/runs/live').status_code==200


@pytest.mark.parametrize('selection',[{}, {'ids':[]}, {'ids':['one'],'all':True}])
def test_cleanup_requires_an_explicit_selection(environment,selection):
    client,_=environment
    assert client.request('DELETE','/api/v1/management/images',json=selection).status_code==422
    assert client.request('DELETE','/api/v1/management/recordings',json=selection).status_code==422


def test_bulk_recording_delete_rejects_unfinished_and_missing_without_partial_deletion(environment):
    _,store=environment
    for status in ('running','completed'):
        store.post('/runs/'+status,json={'id':status,'status':status})
    assert store.request('DELETE','/runs',json={'all':True}).status_code==409
    assert store.request('DELETE','/runs',json={'ids':['completed','missing']}).status_code==404
    assert len(store.get('/runs?summary=true').json())==2


def test_invalid_uploads_do_not_create_images(environment):
    client,_=environment
    url='/api/v1/management/images?filename=broken.png'
    assert client.post(url,content=b'invalid').status_code==422
    assert client.post(url,content=b'x'*(12*1024*1024+1)).status_code==413
    assert imagery.statistics_summary()['images']==0


def test_reset_reports_partial_failure_without_erasing_data(environment,monkeypatch):
    client,_=environment
    capture('saved',picture('red'))
    async def request(service,path,method='GET',data=None):
        if service=='brake':raise RuntimeError('brake unavailable')
        return {'status':'ready'}
    monkeypatch.setattr(api,'request',request)
    value=client.post('/api/v1/management/reset').json()
    assert value['status']=='partial' and value['services']['brake']['status']=='failed'
    assert len(value['services'])==8
    assert imagery.statistics_summary()['images']==1


def test_custom_route_removal_validates_path_and_keeps_bundled_routes(tmp_path,monkeypatch):
    root=tmp_path/'routes';root.mkdir()
    monkeypatch.setattr(maps,'ROOT',root)
    monkeypatch.setattr(maps,'jobs',{})
    custom=root/('a'*20);custom.mkdir()
    (custom/'route.json').write_text(json.dumps({'id':'a'*20}))
    bundled=root/'gothenburg-demo';bundled.mkdir()
    client=TestClient(maps.app)
    assert client.delete('/routes/gothenburg-demo').status_code==422
    assert client.delete('/routes/'+('a'*20)).status_code==200
    assert not custom.exists() and bundled.exists()
    assert client.delete('/routes/'+('b'*20)).status_code==404
    assert client.delete('/routes/invalid').status_code==422
