import asyncio
import json
from pathlib import Path

import httpx
import pytest

from sdv import maps
from sdv.models import RouteRequest


ROADS=b'<osm version="0.6"><node id="1" lat="57.7" lon="11.97"/></osm>'


def mock_download(monkeypatch,handler):
    factory=httpx.AsyncClient
    monkeypatch.setattr(maps.httpx,'AsyncClient',lambda **kwargs:factory(transport=httpx.MockTransport(handler),**kwargs))
    monkeypatch.setattr(maps,'overpass_providers',lambda:['https://primary.test/api/interpreter','https://backup.test/api/interpreter'])
    async def no_wait(seconds):pass
    monkeypatch.setattr(maps.asyncio,'sleep',no_wait)


@pytest.mark.parametrize('failure',['timeout','connect','rate_limit','server','remark','html'])
def test_download_recovers_on_backup_provider(monkeypatch,failure):
    calls=[]
    def handler(request):
        calls.append(request.url.host)
        if request.url.host=='primary.test':
            if failure=='timeout':raise httpx.ReadTimeout('',request=request)
            if failure=='connect':raise httpx.ConnectError('',request=request)
            if failure=='rate_limit':return httpx.Response(429)
            if failure=='server':return httpx.Response(504)
            if failure=='remark':return httpx.Response(200,content=b'<osm><remark>runtime error: timed out</remark></osm>')
            return httpx.Response(200,content=b'<html>Service unavailable</html>')
        assert b'data=' in request.content
        return httpx.Response(200,content=ROADS)
    mock_download(monkeypatch,handler)
    job={}
    assert asyncio.run(maps.download_roads('test query',job,10))==ROADS
    assert calls==['primary.test','backup.test']
    assert job['progress']==10 and 'backup.test' in job['stage']


def test_download_retries_and_explains_blank_timeout(monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request.url.host)
        raise httpx.ReadTimeout('',request=request)
    mock_download(monkeypatch,handler)
    with pytest.raises(ValueError,match='primary.test: request timed out; backup.test: request timed out'):
        asyncio.run(maps.download_roads('test query',{},10))
    assert calls==['primary.test','backup.test']*2


def test_second_round_can_recover(monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request.url.host)
        return httpx.Response(200,content=ROADS) if len(calls)==3 else httpx.Response(503)
    mock_download(monkeypatch,handler)
    assert asyncio.run(maps.download_roads('test query',{},10))==ROADS
    assert len(calls)==3


def test_cancellation_stops_provider_requests(monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request.url.host)
        raise asyncio.CancelledError()
    mock_download(monkeypatch,handler)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(maps.download_roads('test query',{},10))
    assert calls==['primary.test']


def test_provider_order_preserves_override_and_removes_duplicates(monkeypatch):
    monkeypatch.setenv('OVERPASS_URL',maps.OVERPASS_PROVIDERS[1])
    assert maps.overpass_providers()==[maps.OVERPASS_PROVIDERS[1],*[url for url in maps.OVERPASS_PROVIDERS if url!=maps.OVERPASS_PROVIDERS[1]]]
    monkeypatch.setenv('OVERPASS_URL','https://custom.test/api/interpreter')
    assert maps.overpass_providers()[0]=='https://custom.test/api/interpreter'


def test_failed_preparation_has_actionable_error(monkeypatch,tmp_path):
    monkeypatch.setattr(maps,'ROOT',tmp_path)
    monkeypatch.setattr(maps,'jobs',{'failed':{}})
    def handler(request):raise httpx.ReadTimeout('',request=request)
    mock_download(monkeypatch,handler)
    request=RouteRequest(start={'lat':57.703,'lng':11.977},destination={'lat':57.697,'lng':11.967})
    asyncio.run(maps.prepare('failed',request))
    job=maps.public_job('failed')
    assert job['status']=='failed' and job['progress']==10
    assert 'request timed out' in job['error'] and 'Retry Prepare route' in job['error']
    assert not list(tmp_path.glob('*/source.osm.xml'))


def test_cached_route_finishes_at_100_percent(monkeypatch,tmp_path):
    monkeypatch.setattr(maps,'ROOT',tmp_path)
    monkeypatch.setattr(maps,'jobs',{'cached':{}})
    request=RouteRequest(start={'lat':57.703,'lng':11.977},destination={'lat':57.697,'lng':11.967})
    key=maps.hashlib.sha256(('1.1:'+request.model_dump_json()).encode()).hexdigest()[:20]
    folder=tmp_path/key;folder.mkdir();(folder/'route.json').write_text(json.dumps({'id':key}))
    asyncio.run(maps.prepare('cached',request))
    assert maps.public_job('cached')=={'status':'ready','progress':100,'stage':'Ready (cached route)','route':{'id':key}}


def test_real_osm_junction_regression_converts(tmp_path):
    # These two genuine OSM roads crash Ubuntu's debug netconvert 1.18 build.
    source=Path('/app/fixtures/gothenburg-junction-regression.osm.xml')
    target=tmp_path/'network.net.xml'
    maps.convert(source,target)
    net=maps.sumolib.net.readNet(str(target))
    assert net.getEdges() and all(edge.allows('passenger') for edge in net.getEdges())
