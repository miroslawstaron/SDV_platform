import json
import csv
import io
import pytest
from fastapi.testclient import TestClient
from sdv import recorder

@pytest.fixture
def store(tmp_path,monkeypatch):
    monkeypatch.setattr(recorder,'DBPATH',tmp_path/'recordings.sqlite')
    with TestClient(recorder.app) as client:yield client

def test_atomic_recording_and_timeline(store):
    store.post('/runs/test',json={'id':'test','status':'completed'})
    store.post('/runs/test/tick',json={'time':1,'state':{'time':1,'speed':3},'events':[{'sim_time':.95,'kind':'tx','module':'sensor','protocol':'CAN','raw':'0102'}]})
    value=store.get('/runs/test/timeline?at=1').json()
    assert value['state']['speed']==3 and value['events'][0]['kind']=='tx'
    exported=store.get('/runs/test/export').text.splitlines()
    assert [json.loads(line)['type'] for line in exported]==['run','state','event']
    assert 'sensor' in store.get('/runs/test/export?format=csv').text
    assert store.delete('/runs/test').status_code==200
    assert store.get('/runs/test').status_code==404

def test_duplicate_tick_rolls_back_events(store):
    store.post('/runs/test',json={'id':'test'})
    tick={'time':1,'state':{'time':1},'events':[{'sim_time':1,'kind':'rx'}]}
    store.post('/runs/test/tick',json=tick)
    with pytest.raises(Exception):store.post('/runs/test/tick',json=tick)
    assert len(store.get('/runs/test/events').json())==1

def test_unknown_recording(store):assert store.get('/runs/missing/timeline').status_code==404

def test_restart_recovery_returns_only_unfinished_runs(store):
    for status in ('created','starting','running','completed','stopped','failed','timed_out','interrupted'):
        store.post('/runs/'+status,json={'id':status,'status':status,'configuration':{'seed':42}})
    recovered=store.get('/runs?unfinished_only=true').json()
    assert {run['id'] for run in recovered}=={'starting','running'}
    assert all(run['configuration']['seed']==42 for run in recovered)
    assert len(store.get('/runs').json())==8

def test_run_summary_avoids_large_snapshots_and_preserves_recording_details(store):
    data={'id':'large-history','status':'completed','time':12.5,'route':{'roads':['road geometry '*10000]},'configuration':{'seed':42},'provenance':{'note':'source'*10000}}
    store.post('/runs/large-history',json=data)
    response=store.get('/runs?summary=true')
    assert response.json()==[{'id':'large-history','status':'completed','time':12.5}]
    assert len(response.content)<200
    assert store.get('/runs/large-history').json()==data
    assert store.get('/runs').json()==[data]

def test_signal_export_keeps_broadcast_and_each_observed_reception(store):
    store.post('/runs/signals',json={'id':'signals'})
    shared={'sim_time':1,'protocol':'CAN','message_id':256,'raw':'0102','sequence':7,'source':'sensor','decoded':{'Speed':3.25,'Sequence':7}}
    observations=[dict(shared,module='sensor',kind='tx',monotonic_ns=10),
                  dict(shared,module='controller',kind='rx',monotonic_ns=20),
                  dict(shared,module='brake',kind='rx',monotonic_ns=30),
                  {'sim_time':1,'module':'navigation','source':'navigation','protocol':'SOME/IP','kind':'event_tx','decoded':{'target_speed':4,'remaining':120},'message_id':32769}]
    store.post('/runs/signals/tick',json={'time':1,'state':{'time':1},'events':observations})
    response=store.get('/runs/signals/export?format=signals')
    rows=list(csv.DictReader(io.StringIO(response.text)))
    assert len(rows)==8
    speed=[row for row in rows if row['signal']=='Speed']
    assert [(r['direction'],r['source'],r['destination']) for r in speed]==[
        ('transmit','sensor','CAN bus'),('receive','sensor','controller'),('receive','sensor','brake')]
    assert all(row['unit']=='m/s' and row['value']=='3.25' for row in speed)
    assert speed[0]['vss']=='Vehicle.Speed'
    assert rows[-1]['destination']=='controller' and rows[-1]['unit']=='m'
    assert 'signals.signals.csv' in response.headers['content-disposition']

def test_export_is_not_limited_to_event_page_size(store):
    store.post('/runs/large',json={'id':'large'})
    events=[{'sim_time':1,'module':'powertrain','source':'powertrain','protocol':'CAN','kind':'tx','message_id':528,'decoded':{'Acceleration':1.5,'Sequence':i}} for i in range(5001)]
    store.post('/runs/large/tick',json={'time':1,'state':{'time':1},'events':events})
    assert len(store.get('/runs/large/events?limit=5000').json())==5000
    exported=list(csv.DictReader(io.StringIO(store.get('/runs/large/export?format=signals').text)))
    assert len(exported)==10002 and exported[-1]['value']=='5000'
