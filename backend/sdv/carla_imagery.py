"""Sample recorded first-person CARLA frames into the shared pHash library."""
from collections import deque
import json
from pathlib import Path
from queue import Queue
import sqlite3
import threading

from . import imagery


def station_index(state, distance):
    travelled = max(0, min(distance, distance - state['remaining']))
    return min(int(distance // 25), int((travelled + 1e-7) // 25))


class CameraCaptures:
    """Pair asynchronous camera frames with past telemetry, then hash off-thread.

    Only the first driver frame at each 25 m station counts. Browser polling,
    chase cameras and replay do not create observations.
    """
    def __init__(self, run_id, distance, info):
        imagery.initialize()
        self.run_id, self.distance, self.info = run_id, distance, info
        with imagery.connection() as db:
            self.stations = {row[0] for row in db.execute(
                'SELECT station_index FROM captures WHERE run_id=?', (run_id,))}
        self.states = deque(maxlen=256)
        self.frames = deque(maxlen=32)
        self.lock = threading.Lock()
        self.jobs = Queue()
        self.closed = False
        self.thread = threading.Thread(target=self._write, name='carla-image-captures', daemon=True)
        self.thread.start()

    def observe_state(self, state):
        with self.lock:
            if self.closed:
                return
            self.states.append({key: state[key] for key in ('time', 'remaining', 'lat', 'lng')})
            self._pair()

    def observe_frame(self, path, stamp):
        with self.lock:
            if self.closed:
                return
            self.frames.append((path, stamp))
            self._pair()

    def _pair(self):
        while self.frames and self.states and self.frames[0][1] <= self.states[-1]['time'] + 1e-6:
            path, stamp = self.frames.popleft()
            state = next((s for s in reversed(self.states) if s['time'] <= stamp + 1e-6), None)
            if state is None:
                continue  # Never label an image using future telemetry.
            index = station_index(state, self.distance)
            if index not in self.stations:
                self.stations.add(index)
                self.jobs.put((path, stamp, state, index))

    def _write(self):
        while True:
            job = self.jobs.get()
            try:
                if job is None:
                    return
                path, stamp, state, index = job
                imagery.capture(self.run_id, index, path.read_bytes(),
                                f'carla:driver:{round(stamp * 1000):012d}', stamp, state['lat'], state['lng'])
                self.info['image_captures'] = self.info.get('image_captures', 0) + 1
                self.info.pop('similarity_error', None)
            except Exception as exc:
                self.info['similarity_error'] = str(exc)
                with self.lock:
                    self.stations.discard(job[3])
            finally:
                self.jobs.task_done()

    def close(self):
        with self.lock:
            self.closed = True
            self.frames.clear()  # Frames after the last telemetry tick are not observations.
        self.jobs.put(None)
        self.thread.join()


def backfill_recordings(recording_path=Path('/data/recordings.sqlite')):
    """Restore missing observations in retained, finished CARLA recordings only."""
    from .carla_backend import camera_path
    results = []
    with sqlite3.connect(f'file:{recording_path}?mode=ro', uri=True) as db:
        for rid, data in db.execute('SELECT id,data FROM runs'):
            run = json.loads(data)
            if run['route'].get('backend') != 'carla' or run['status'] in ('starting', 'running'):
                continue
            directory = camera_path(rid) / 'driver'
            if not directory.is_dir():
                continue
            info = {'run_id': rid, 'image_captures': 0}
            captures = CameraCaptures(rid, run['route']['distance'], info)
            try:
                rows = iter(db.execute('SELECT state FROM ticks WHERE run=? ORDER BY t', (rid,)))
                first = next(rows, None)
                if first is None:
                    continue
                state = json.loads(first[0])
                # Replay the archived sensor/telemetry ordering without creating new stations.
                captures.observe_state(state)
                for path in sorted(directory.glob('*.jpg')):
                    stamp = int(path.stem) / 1000
                    while state is not None and state['time'] < stamp - 1e-6:
                        row = next(rows, None)
                        state = json.loads(row[0]) if row else None
                        if state:
                            captures.observe_state(state)
                    if state is None:
                        break
                    captures.observe_frame(path, stamp)
            finally:
                captures.close()
            results.append(info)
    return results


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backfill', action='store_true', required=True)
    parser.parse_args()
    print(json.dumps(backfill_recordings()))
