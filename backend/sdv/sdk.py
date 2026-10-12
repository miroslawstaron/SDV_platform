"""Python SDK for the native CAN/SOME/IP adapter. CAN is always real SIL Kit traffic."""
import json
import grpc
import cantools
from pathlib import Path
from . import adapter_pb2 as pb, adapter_pb2_grpc as rpc

DB = cantools.database.load_file(str(Path(__file__).parents[1] / 'contracts/vehicle.dbc'))
OWNERS = {256:'sensor',272:'bms',512:'controller',528:'powertrain',544:'brake',560:'lane'}

class Transport:
    def __init__(self, address='127.0.0.1:50051'):
        self.channel=grpc.insecure_channel(address)
        grpc.channel_ready_future(self.channel).result(timeout=30)
        self.stub=rpc.AdapterStub(self.channel)

    def send(self, message_id, values):
        msg=DB.get_message_by_frame_id(message_id)
        values={s.name:values.get(s.name,0) for s in msg.signals}
        self.stub.SendCan(pb.Frame(id=message_id,data=msg.encode(values)),timeout=2)

    def snapshot(self):
        reply=self.stub.Snapshot(pb.Empty(),timeout=2)
        frames={}
        for f in reply.frames:
            try: frames[str(f.id)]={'signals':DB.decode_message(f.id,f.data),'age':f.age_ns/1e9}
            except (KeyError,ValueError,cantools.database.errors.DecodeError): pass
        intent={}
        try: intent=json.loads(reply.intent.data)
        except (ValueError,TypeError): pass
        return {'frames':frames,'intent':intent,'intent_age':reply.intent.age_ns/1e9,'available':reply.available}

    def intent(self, value):
        self.stub.PublishIntent(pb.Intent(data=json.dumps(value,separators=(',',':')).encode()),timeout=2)

    def events(self, role, sim_time):
        reply=self.stub.Drain(pb.Empty(),timeout=2)
        if reply.overflow: raise RuntimeError('Native event queue overflow; recording invalid')
        out=[]
        for e in reply.events:
            decoded={}
            if e.protocol=='CAN':
                try: decoded=DB.decode_message(e.id,e.data)
                except (KeyError,ValueError,cantools.database.errors.DecodeError): pass
            elif e.data:
                try: decoded=json.loads(e.data)
                except ValueError: pass
            source=role if e.kind=='tx' or e.kind.endswith('_tx') else OWNERS.get(e.id,'unknown') if e.protocol=='CAN' else 'controller' if e.kind=='request_rx' else 'navigation'
            out.append({'module':role,'protocol':e.protocol,'kind':e.kind,'message_id':e.id,'raw':e.data.hex(),'decoded':decoded,'sim_time':sim_time,'monotonic_ns':e.elapsed_ns,'source':source,'sequence':decoded.get('Sequence',decoded.get('sequence'))})
        return out
