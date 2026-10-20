import json
import struct
import threading
import httpx
import pytest
from sdv.carla_frames import MEDIA_TYPE, pack_frames, unpack_frames
from sdv.performance import Timings


def test_binary_camera_envelope_preserves_jpeg_and_telemetry_without_base64():
    frames=[('driver',200,b'\xff\xd8\x00\x01\xff\xd9'),('chase',200,b'\xff\xd8\x00\x02\xff\xd9')]
    state={'time':.2,'speed':3.1,'heading':42}
    events=[{'protocol':'SIM','kind':'collision','other_actor':'walker.pedestrian'}]
    assert unpack_frames(pack_frames(state,events,frames))==(state,events,frames)


@pytest.mark.parametrize('data', [b'',b'\0\0',struct.pack('<I',200)+b'{}',pack_frames(None,[],[('driver',1,b'x')])[:-1],pack_frames(None,[],[('driver',1,b'x')])+b'x',pack_frames(None,[],[('../other',1,b'x')])])
def test_invalid_camera_packets_cannot_write_partial_or_unexpected_files(data):
    with pytest.raises(ValueError):unpack_frames(data)


def test_native_camera_receiver_persists_both_views_and_flushes_before_capture_close(tmp_path,monkeypatch):
    from sdv import carla_backend,carla_native_bridge as bridge
    rid='533eb98c-a365-42c4-8a81-234e0b1ecbe2'
    monkeypatch.setattr(carla_backend,'CAMERA_ROOT',tmp_path)
    calls=[];observed=[];delivered=threading.Event()
    class Captures:
        def __init__(self,*args):pass
        def observe_state(self,state):observed.append(('state',state['time']))
        def observe_frame(self,path,stamp):
            assert path.read_bytes()==b'jpeg-driver'
            observed.append(('frame',stamp));delivered.set()
        def close(self):observed.append(('closed',None))
    monkeypatch.setattr(bridge,'CameraCaptures',Captures)
    state=dict(time=0,distance=500,remaining=500,lat=0,lng=0)
    sent=False
    def handler(request):
        nonlocal sent
        calls.append(request.url.path)
        if request.url.path=='/load':return httpx.Response(200,json=state)
        if request.url.path=='/tick':return httpx.Response(200,json=dict(state={**state,'time':.2},events=[{'protocol':'SIM'}]))
        if request.url.path=='/shutdown':return httpx.Response(200,content=pack_frames(None,[],[('chase',400,b'jpeg-chase')]),headers={'content-type':MEDIA_TYPE})
        if request.url.path=='/frames':
            if not sent:
                sent=True
                return httpx.Response(200,content=pack_frames(None,[],[('driver',200,b'jpeg-driver')]),headers={'content-type':MEDIA_TYPE})
            client.stop_receiver.wait(.01)
            return httpx.Response(200,content=pack_frames(None,[],[]),headers={'content-type':MEDIA_TYPE})
        return httpx.Response(200,json={'performance':{}})
    client=bridge.CarlaNativeBridge()
    client.http.close();client.frame_http.close()
    client.http=httpx.Client(base_url='http://native',transport=httpx.MockTransport(handler))
    client.frame_http=httpx.Client(base_url='http://native',transport=httpx.MockTransport(handler))
    try:
        client.load_world({}, {},42,rid)
        assert delivered.wait(2)
        value,events=client.advance({})
        assert value['time']==.2 and events==[{'protocol':'SIM'}]
        client.shutdown()
        assert (tmp_path/rid/'driver'/'000000000200.jpg').read_bytes()==b'jpeg-driver'
        assert (tmp_path/rid/'chase'/'000000000400.jpg').read_bytes()==b'jpeg-chase'
        assert (tmp_path/rid/'chase'/'latest.txt').read_text()=='400'
        assert observed[-1]==('closed',None)
        assert not client.receiver.is_alive()
    finally:client.close()


def test_timing_summary_counts_concurrent_camera_and_control_work():
    timings=Timings()
    threads=[threading.Thread(target=lambda:[timings.record('work',.002) for _ in range(100)]) for _ in range(4)]
    for thread in threads:thread.start()
    for thread in threads:thread.join()
    assert timings.summary()['work']==dict(count=400,mean_ms=2,p50_ms=2,p95_ms=2,max_ms=2)
