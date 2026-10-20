"""Keep raw GPU image transfers on Windows; persist compressed frames in Docker."""
import os
import threading
import httpx
from .carla_backend import camera_path
from .carla_frames import MEDIA_TYPE, unpack_frames
from .carla_imagery import CameraCaptures
from .performance import Timings


class CarlaNativeBridge:
    def __init__(self):
        self.http=httpx.Client(base_url=os.getenv('CARLA_CLIENT_URL','http://host.docker.internal:2003'),timeout=600)
        self.frame_http=httpx.Client(base_url=os.getenv('CARLA_CLIENT_URL','http://host.docker.internal:2003'),timeout=5)
        self.run_id=None
        self.last={}
        self.captures=None
        self.capture_info={}
        self.timings=Timings()
        self.receiver=None
        self.stop_receiver=threading.Event()

    def _request(self,path,data=None):
        response=self.http.request('GET' if data is None else 'POST',path,json=data)
        if response.is_error:raise RuntimeError(response.json().get('detail',response.text))
        if response.headers.get('content-type')==MEDIA_TYPE:
            state,events,frames=unpack_frames(response.content)
            return dict(state=state,events=events,frames=frames)
        return response.json()

    @property
    def info(self):
        try:info=self._request('/status')
        except httpx.ConnectError:
            return dict(backend='carla',status='idle',renderer='nvidia',client_runtime='windows',notice='Native CARLA client starts with the next drive.')
        info.update(self.capture_info)
        info['client_runtime']='windows'
        info['performance']={**info.get('performance',{}),**self.timings.summary()}
        return info

    def _frames(self,frames):
        for view,stamp,jpeg in frames:
            target=self.directory/view/f'{stamp:012d}.jpg'
            with self.timings.measure('bridge_frame_write'):
                temporary=target.with_suffix('.tmp')
                temporary.write_bytes(jpeg)
                temporary.replace(target)
                latest=target.parent/'latest.txt'
                latest.with_suffix('.tmp').write_text(str(stamp))
                latest.with_suffix('.tmp').replace(latest)
            if view=='driver' and self.captures:self.captures.observe_frame(target,stamp/1000)

    def _receive(self):
        # Camera transfers run alongside the control loop, as CARLA sensors do.
        # The native queue is bounded and applies backpressure rather than
        # allocating an unbounded image backlog.
        while not self.stop_receiver.is_set():
            try:
                with self.timings.measure('bridge_camera_http'):
                    response=self.frame_http.get('/frames')
                    response.raise_for_status()
                    _,_,frames=unpack_frames(response.content)
                self._frames(frames)
                self.capture_info.pop('camera_error',None)
            except Exception as exc:
                self.capture_info['camera_error']=str(exc)
                self.stop_receiver.wait(.25)

    def load_world(self,route,vehicle,seed,run_id):
        self.shutdown()
        self.directory=camera_path(run_id)
        for view in ('driver','chase'):(self.directory/view).mkdir(parents=True,exist_ok=True)
        self.timings=Timings()
        self.capture_info={'image_captures':0}
        self.run_id=run_id
        self.last=self._request('/load',dict(route=route,vehicle=vehicle,seed=seed,run_id=run_id))
        self.captures=CameraCaptures(run_id,self.last['distance'],self.capture_info)
        self.captures.observe_state(self.last)
        self.stop_receiver.clear()
        self.receiver=threading.Thread(target=self._receive,name='carla-native-cameras',daemon=True)
        self.receiver.start()

    def advance(self,network):
        with self.timings.measure('bridge_http'):
            result=self._request('/tick',network)
        self.last=result['state']
        self.captures.observe_state(self.last)
        return self.last,result['events']

    def state(self):return self.last

    def shutdown(self):
        if not self.run_id:return
        try:
            self.stop_receiver.set()
            if self.receiver:
                self.receiver.join(timeout=7)
                if self.receiver.is_alive():raise RuntimeError('Native CARLA camera receiver did not stop')
            result=self._request('/shutdown',{})
            self._frames(result.get('frames',[]))
        finally:
            if self.captures:self.captures.close()
            self.captures=None
            self.run_id=None

    def close(self):
        try:self.shutdown()
        finally:
            self.http.close()
            self.frame_http.close()
