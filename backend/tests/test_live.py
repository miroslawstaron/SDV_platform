"""Acceptance tests against the running Docker composition; opt in with SDV_LIVE=1."""
import os
import time
import httpx
import pytest

pytestmark=pytest.mark.skipif(os.getenv('SDV_LIVE')!='1',reason='Requires running Docker services')
URL=os.getenv('SDV_URL','http://api:8000/api/v1')

def call(path,method='GET',data=None):
    if path=='/runs' and method=='POST':data={'route_id':'gothenburg-demo',**(data or {})}
    r=httpx.request(method,URL+path,json=data,timeout=10);r.raise_for_status();return r.json()

def run_scenario(configuration,timeout=180):
    run=call('/runs','POST',configuration);call(f"/runs/{run['id']}/start",'POST')
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        state=call(f"/runs/{run['id']}")
        if state['status'] not in ('created','starting','running'):return state
        time.sleep(.2)
    call(f"/runs/{run['id']}/stop",'POST');raise AssertionError('Acceptance run exceeded wall time limit')

def test_services_and_baseline_journey():
    assert call('/health')['status']=='ready'
    run=run_scenario({'duration':160})
    assert run['status']=='completed',run
    assert run['recording_valid']
    events=[];after=0
    while True:
        batch=call(f"/runs/{run['id']}/events?after={after}&limit=5000")
        if not batch:break
        events+=batch;after=batch[-1]['event_id']
    assert any(e['protocol']=='CAN' and e['kind']=='tx' for e in events)
    assert any(e['protocol']=='CAN' and e['kind']=='rx' for e in events)
    received_by_plant={e.get('message_id') for e in events if e['module']=='plant' and e['protocol']=='CAN' and e['kind']=='rx'}
    assert {528,544,560}<=received_by_plant, 'The simulator must receive the applied propulsion, braking and lane messages'
    assert run['peak_speed']>1, 'Advancing time alone does not prove the vehicle moved'
    assert any(e['protocol']=='SOME/IP' and e['kind']=='event_rx' for e in events)
    assert any(e['protocol']=='SOME/IP' and e['kind']=='response_rx' for e in events)
    final=call(f"/runs/{run['id']}/timeline?at={run['time']}")['state']
    assert final['speed']==0 and final['remaining']<=2
    previous=call(f"/runs/{run['id']}/timeline?at={run['time']-.1}")['state']
    assert previous['speed']<.5, 'Arrival must follow measured deceleration, not automatic vehicle removal'
    assert final['consumed_wh']>0 and final['regenerated_wh']>0

@pytest.mark.parametrize('module,kind,signal,value',[
    ('sensor','drop',None,None),('controller','stop',None,None),('navigation','withdraw',None,None),('bms','substitute','PropulsionLimit',0),('sensor','substitute','Speed',80),('sensor','delay',None,None),('sensor','duplicate',None,None)])
def test_fault_observation_and_recording(module,kind,signal,value):
    fault={'module':module,'kind':kind,'at':1,'duration':2,'delay_ms':300}
    if signal:fault.update(signal=signal,value=value)
    run=run_scenario({'duration':5,'faults':[fault]},timeout=20)
    assert run['status']=='timed_out' and run['recording_valid'],run
    events=call(f"/runs/{run['id']}/events?limit=5000")
    assert any(e['protocol']=='FAULT' and e['kind']=='activated' for e in events)
    assert any(e['protocol']=='FAULT' and e['kind']=='removed' for e in events)
    if signal:
        field=[e['decoded'].get(signal) for e in events if e.get('decoded') and e.get('module')==module and e['kind']=='tx' and 1<=e['sim_time']<3]
        assert value in field
    if kind=='drop':assert any(e['kind']=='adapter_drop' for e in events)
    if kind=='delay':
        # Protocol watchdogs use wall time: host overruns can make the braking
        # interval finish before an arbitrary simulation-time cutoff.
        controller_events=sorted([e for e in events if e.get('module')=='controller' and e['protocol']=='CAN'],key=lambda e:e['monotonic_ns'])
        last_sensor_rx=None;stale_commands=[]
        for event in controller_events:
            if event['kind']=='rx' and event.get('message_id')==256:last_sensor_rx=event['monotonic_ns']
            # Allow processing between sampling feedback age and sending a frame.
            if event['kind']=='tx' and event.get('message_id')==512 and last_sensor_rx is not None and event['monotonic_ns']-last_sensor_rx>220_000_000:
                stale_commands.append(event['decoded'])
        assert stale_commands, 'Delayed delivery must produce an observable stale-feedback interval'
        assert all(command['Acceleration']==0 and command['Deceleration']>0 for command in stale_commands)
        assert any(e.get('module')=='brake' and e.get('decoded',{}).get('Deceleration',0)>0 and 1<=e['sim_time']<3 for e in events)
    elif module in ('controller','navigation'):
        assert any(e.get('module')=='brake' and e.get('decoded',{}).get('Deceleration',0)>0 and e['sim_time']>1.25 for e in events)

def test_depleted_battery_prevents_motion():
    run=run_scenario({'duration':3,'vehicle':{'charge_pct':0}},timeout=15)
    state=call(f"/runs/{run['id']}/timeline?at={run['time']}")['state']
    assert state['speed']==0 and state['energy_wh']==0

def test_brake_message_loss_changes_actual_stopping():
    sensor={'module':'sensor','kind':'substitute','signal':'Speed','value':80,'at':1,'duration':2}
    working=run_scenario({'duration':3,'faults':[sensor]},timeout=15)
    failed=run_scenario({'duration':3,'faults':[sensor,{'module':'brake','kind':'drop','at':1,'duration':2}]},timeout=15)
    stopped=call(f"/runs/{working['id']}/timeline?at=3")['state']
    coasting=call(f"/runs/{failed['id']}/timeline?at=3")['state']
    assert stopped['speed']<.2
    assert coasting['speed']>stopped['speed']+1, 'The plant must not silently brake for a failed ECU'

def test_replay_and_exports():
    run=run_scenario({'duration':1},timeout=10)
    replay=call(f"/runs/{run['id']}/replay",'POST',{'at':.5})
    assert replay['state']['time']<=.5
    r=httpx.get(URL+f"/runs/{run['id']}/export?format=jsonl")
    assert r.status_code==200 and '"type": "event"' in r.text

def test_invalid_locations_and_second_run():
    r=httpx.post(URL+'/routes/prepare',json={'start':{'lat':100,'lng':0},'destination':{'lat':0,'lng':0}})
    assert r.status_code==422
    run=call('/runs','POST',{'duration':2});call(f"/runs/{run['id']}/start",'POST')
    try:
        other=call('/runs','POST',{'duration':2})
        r=httpx.post(URL+f"/runs/{other['id']}/start")
        assert r.status_code==409
    finally:
        call(f"/runs/{run['id']}/stop",'POST');time.sleep(.5)
