from types import SimpleNamespace
from sdv.sdk import Transport
from sdv import adapter_pb2 as pb

def test_malformed_frame_is_recorded_raw_and_not_used_for_control():
    transport=Transport.__new__(Transport)
    snapshot=pb.SnapshotReply(frames=[pb.Frame(id=256,data=b'\x01')])
    events=pb.Events(events=[pb.Event(protocol='CAN',kind='rx',id=256,data=b'\x01',elapsed_ns=1),pb.Event(protocol='SOME/IP',kind='request_tx',id=1)])
    transport.stub=SimpleNamespace(Snapshot=lambda *args,**kwargs:snapshot,Drain=lambda *args,**kwargs:events)
    assert transport.snapshot()['frames']=={}
    recorded=transport.events('controller',1)
    assert recorded[0]['raw']=='01' and recorded[0]['decoded']=={}
    assert recorded[1]['source']=='controller'
