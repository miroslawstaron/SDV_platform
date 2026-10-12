from types import SimpleNamespace
import subprocess
import pytest
from sdv.simulator import SumoBackend
from sdv.application import compute
from sdv.models import Vehicle

def test_simulator_route_exit_does_not_fake_success():
    backend=SumoBackend()
    backend.conn=SimpleNamespace(simulationStep=lambda:None,vehicle=SimpleNamespace(getIDList=lambda:[]))
    backend.last={'arrived':False,'speed':5};backend.elapsed=0
    backend.apply_actuators=lambda network:None
    with pytest.raises(RuntimeError,match='before a verified destination stop'):backend.advance({})

@pytest.mark.parametrize('lane_id,lanes,expected',[
    ('approach_0',[('approach_0',100,0,1,False,()),('approach_1',300,0,0,True,())],1),
    ('approach_1',[('approach_0',300,0,0,True,()),('approach_1',100,0,-1,False,())],-1),
    (':junction_0',[('exit_0',300,0,1,True,())],0),
    ('approach_0',[],0),
])
def test_route_lane_hint_matches_current_lane(lane_id,lanes,expected):
    backend=SumoBackend()
    backend.conn=SimpleNamespace(vehicle=SimpleNamespace(getLaneID=lambda _:lane_id,getBestLanes=lambda _:lanes))
    assert backend._route_lane_offset()==expected

def test_turn_lane_is_selected_through_navigation_controller_and_lane_ecu(tmp_path,monkeypatch):
    nodes=tmp_path/'nodes.xml';edges=tmp_path/'edges.xml';connections=tmp_path/'connections.xml';network=tmp_path/'network.net.xml'
    nodes.write_text('<nodes><node id="a" x="0" y="0"/><node id="b" x="100" y="0"/><node id="c" x="100" y="100"/></nodes>')
    edges.write_text('<edges><edge id="in" from="a" to="b" numLanes="2" speed="13.9"/><edge id="out" from="b" to="c" numLanes="1" speed="13.9"/></edges>')
    connections.write_text('<connections><connection from="in" to="out" fromLane="1" toLane="0"/></connections>')
    subprocess.run(['netconvert','--node-files',str(nodes),'--edge-files',str(edges),'--connection-files',str(connections),'--output-file',str(network),'--no-warnings','true'],check=True,capture_output=True)
    route={'network':str(network),'edges':['in','out'],'start_offset':0,'end_offset':75,'distance':175}
    # Keep the test's temporary world separate from the live plant route file.
    from pathlib import Path
    import sdv.simulator as simulator
    monkeypatch.setattr(simulator,'Path',lambda value:tmp_path/'active.rou.xml' if value=='/data/active.rou.xml' else Path(value))
    vehicle=Vehicle().model_dump()
    def drive(lane_ecu_enabled):
        backend=SumoBackend();requests=[]
        try:
            backend.load_world(route,vehicle,1)
            for seq in range(1000):
                context={'sequence':seq,'vehicle':vehicle,'truth':backend.state(),'network':{'available':True,'intent_age':0,'frames':{}}}
                sensor=compute('sensor',context)['can'][0][1]
                context['network']['frames']['256']={'age':0,'signals':sensor}
                context['network']['frames']['272']={'age':0,'signals':compute('bms',context)['can'][0][1]}
                context['network']['intent']=compute('navigation',context)['intent']
                context['network']['frames']['512']={'age':0,'signals':compute('controller',context)['can'][0][1]}
                frames={}
                for role in ('powertrain','brake','lane'):
                    mid,signals=compute(role,context)['can'][0]
                    if role=='lane' and not lane_ecu_enabled:continue
                    frames[str(mid)]={'age':0,'signals':signals}
                    if role=='lane' and signals['LaneRequest']:requests.append(signals['LaneRequest'])
                state,_=backend.advance({'frames':frames})
                if state['arrived']:break
            return state,requests
        finally:backend.shutdown()
    blocked,_=drive(False)
    assert not blocked['arrived'] and blocked['speed']==0 and blocked['remaining']>50
    completed,requests=drive(True)
    assert completed['arrived'] and completed['speed']==0 and completed['remaining']<=2
    assert 1 in requests
