"""Local CARLA client shares the server network; SDV reaches it by Unix socket."""
from contextlib import asynccontextmanager
from pathlib import Path
import threading
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from .carla_backend import CarlaProcessBackend
from .carla_frames import MEDIA_TYPE, pack_frames

backend = None
operation = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    global backend
    if os.name!='nt' and os.getenv('CARLA_CLIENT_RUNTIME')=='windows':
        from .carla_native_bridge import CarlaNativeBridge
        backend=CarlaNativeBridge()
    else:backend=CarlaProcessBackend()
    yield
    backend.close()


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health():
    return {'status': 'ready'}


@app.get('/status')
def status():
    if isinstance(backend,CarlaProcessBackend) and operation.acquire(blocking=False):
        try:return backend.diagnostics()
        finally:operation.release()
    return backend.info


@app.get('/frames')
def frames():
    if os.getenv('CARLA_FRAME_TRANSPORT')!='http':raise HTTPException(404,'Native frame transport is disabled')
    return Response(pack_frames(None,[],backend.drain_frames(timeout=.1)),media_type=MEDIA_TYPE)


@app.post('/load')
def load(data: dict):
    with operation:
        try:
            backend.load_world(data['route'], data['vehicle'], data['seed'], data['run_id'])
            return backend.state()
        except Exception as exc:
            raise HTTPException(503, str(exc)) from exc


@app.post('/tick')
def tick(network: dict):
    with operation:
        try:
            state, events = backend.advance(network)
            return {'state': state, 'events': events}
        except Exception as exc:
            raise HTTPException(503, str(exc)) from exc


@app.post('/shutdown')
def shutdown():
    with operation:
        try:
            if os.getenv('CARLA_FRAME_TRANSPORT')=='http':
                backend._call('shutdown')
                frames=backend.drain_frames(timeout=.1)
                backend.shutdown()
                return Response(pack_frames(None,[],frames),media_type=MEDIA_TYPE)
            backend.shutdown()
        except Exception as exc:raise HTTPException(503, str(exc)) from exc
    return {'ok': True}


if __name__ == '__main__':
    import uvicorn
    if os.name=='nt':uvicorn.run(app,host='127.0.0.1',port=2003,log_level='warning')
    else:
        socket = Path('/data/carla-service.sock')
        socket.unlink(missing_ok=True)
        uvicorn.run(app, uds=str(socket), log_level='warning')
