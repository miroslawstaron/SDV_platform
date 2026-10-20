"""Local CARLA client shares the server network; SDV reaches it by Unix socket."""
from contextlib import asynccontextmanager
from pathlib import Path
import threading
from fastapi import FastAPI, HTTPException
from .carla_backend import CarlaProcessBackend

backend = None
operation = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    global backend
    backend = CarlaProcessBackend()
    yield
    backend.close()


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health():
    return {'status': 'ready'}


@app.get('/status')
def status():
    return backend.info


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
        try:backend.shutdown()
        except Exception as exc:raise HTTPException(503, str(exc)) from exc
    return {'ok': True}


if __name__ == '__main__':
    import uvicorn
    socket = Path('/data/carla-service.sock')
    socket.unlink(missing_ok=True)
    uvicorn.run(app, uds=str(socket), log_level='warning')
