import math
import pytest
from sdv.application import compute
from sdv.models import Vehicle, Fault, RunRequest, RouteRequest
from sdv.sdk import DB

def ctx(speed=10,remaining=500,age=0,available=True):
    return {'sequence':12,'vehicle':Vehicle().model_dump(),'network':{'available':available,'intent':{'target_speed':12,'lane_request':0},'intent_age':age,'frames':{'256':{'age':age,'signals':{'Speed':speed,'Remaining':remaining,'SpeedLimit':13,'RedLight':0,'LightDistance':6553}},'272':{'age':age,'signals':{'PropulsionLimit':1}},'512':{'age':age,'signals':{'Acceleration':2,'Deceleration':0,'LaneRequest':0}}}}}

@pytest.mark.parametrize('speed,expected',[(0,2.5),(10,2.5),(12,0),(20,0)])
def test_controller_acceleration(speed,expected):
    assert compute('controller',ctx(speed))['can'][0][1]['Acceleration']==expected

@pytest.mark.parametrize('role,signal,value',[('controller','Deceleration',3),('powertrain','Acceleration',0),('brake','Deceleration',3)])
def test_watchdog(role,signal,value):
    assert compute(role,ctx(age=.201))['can'][0][1][signal]==value

def test_discovery_loss_stops():
    output=compute('controller',ctx(available=False))['can'][0][1]
    assert output['Acceleration']==0 and output['Deceleration']==3

def test_destination_stopping():
    output=compute('controller',ctx(speed=10,remaining=2))['can'][0][1]
    assert output['Deceleration']>0 and output['TargetSpeed']<3

def test_red_light_stopping():
    context=ctx(speed=10);context['network']['frames']['256']['signals'].update(RedLight=1,LightDistance=5)
    output=compute('controller',context)['can'][0][1]
    assert output['Deceleration']>0

@pytest.mark.parametrize('offset,expected',[(-2,-1),(-1,-1),(0,0),(1,1),(2,1)])
def test_navigation_requests_one_lane_toward_route_connection(offset,expected):
    context=ctx();context['truth']={'speed_limit':13,'remaining':500,'route_lane_offset':offset}
    intent=compute('navigation',context)['intent']
    assert intent['lane_request']==expected
    context['network']['intent']=intent
    command=compute('controller',context)['can'][0][1]
    context['network']['frames']['512']['signals']=command
    assert compute('lane',context)['can'][0][1]['LaneRequest']==expected

def test_manual_lane_request_takes_precedence_over_route_hint():
    context=ctx();context['truth']={'speed_limit':13,'remaining':500,'route_lane_offset':-1};context['lane_request']=1
    assert compute('navigation',context)['intent']['lane_request']==1

@pytest.mark.parametrize('charge,limit,warning',[(80,1,0),(10,1,0),(9,1,1),(5,1,1),(2.5,.5,1),(0,0,1)])
def test_bms_limits(charge,limit,warning):
    context=ctx();context['truth']={'charge_pct':charge,'energy_wh':100,'power_w':0,'consumed_wh':0,'regenerated_wh':0}
    output=compute('bms',context)['can'][0][1]
    assert output['PropulsionLimit']==limit and output['LowBattery']==warning

def test_powertrain_enforces_bms_limit():
    context=ctx();context['network']['frames']['272']['signals']['PropulsionLimit']=.1
    assert compute('powertrain',context)['can'][0][1]['Acceleration']==pytest.approx(.2)

@pytest.mark.parametrize('mid',[256,272,512,528,544,560])
def test_dbc_roundtrip(mid):
    message=DB.get_message_by_frame_id(mid)
    values={s.name:0 for s in message.signals};values['Sequence']=65535
    if mid==256:values.update(Latitude=59.3293,Longitude=18.0686,Speed=12.34)
    if mid==272:values.update(Power=-25000,Charge=80.12,PropulsionLimit=.5)
    encoded=message.encode(values);decoded=message.decode(encoded)
    assert len(encoded)==message.length
    for key,value in values.items():assert decoded[key]==pytest.approx(value,abs=.001)

@pytest.mark.parametrize('data',[{'module':'brake','kind':'withdraw'},{'module':'controller','kind':'freeze','signal':'Speed'},{'module':'sensor','kind':'substitute','signal':'Speed'}])
def test_invalid_faults(data):
    with pytest.raises(ValueError):Fault(**data)

def test_validation_bounds():
    with pytest.raises(ValueError):Vehicle(charge_pct=101)
    with pytest.raises(ValueError):RunRequest(duration=901)
    with pytest.raises(ValueError):RouteRequest(start={'lat':91,'lng':0},destination={'lat':0,'lng':0})
