"""Small, thread-safe timing summaries; no per-tick logging or disk writes."""
from collections import deque
from contextlib import contextmanager
import threading
import time


class Timings:
    def __init__(self):
        self.entries = {}
        self.lock = threading.Lock()

    def record(self, name, seconds):
        milliseconds = seconds * 1000
        with self.lock:
            item = self.entries.setdefault(name, dict(count=0, total=0, maximum=0, samples=deque(maxlen=2048)))
            item['count'] += 1
            item['total'] += milliseconds
            item['maximum'] = max(item['maximum'], milliseconds)
            item['samples'].append(milliseconds)

    @contextmanager
    def measure(self, name):
        started = time.perf_counter()
        try:yield
        finally:self.record(name, time.perf_counter() - started)

    def summary(self):
        with self.lock:
            result = {}
            for name, item in self.entries.items():
                samples = sorted(item['samples'])
                result[name] = dict(count=item['count'], mean_ms=round(item['total']/item['count'], 3),
                                    p50_ms=round(samples[len(samples)//2], 3),
                                    p95_ms=round(samples[min(len(samples)-1, int(len(samples)*.95))], 3),
                                    max_ms=round(item['maximum'], 3))
            return result
