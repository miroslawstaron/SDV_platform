import pytest
import subprocess
import time
from fastapi import HTTPException
from sdv import worker

def failed(message):
    def tick(ctx):raise RuntimeError(message)
    return tick

def test_application_failure_preserves_native_receptions(monkeypatch):
    monkeypatch.setattr(worker,'ROLE','controller')
    monkeypatch.setattr(worker,'process_tick',failed('ECU application exited'))
    class Observer:
        def events(self,role,time):return [{'module':role,'protocol':'CAN','kind':'rx','sim_time':time}]
    monkeypatch.setattr(worker,'transport',Observer())
    result=worker.tick({'time':1})
    assert result['health']['application']=='failed'
    assert result['events'][0]['kind']=='rx'
    assert result['events'][1]['kind']=='failed'

def test_observation_overflow_is_explicit_http_failure(monkeypatch):
    monkeypatch.setattr(worker,'ROLE','sensor')
    monkeypatch.setattr(worker,'process_tick',failed('Native event queue overflow; recording invalid'))
    with pytest.raises(HTTPException) as exc:worker.tick({'time':1})
    assert exc.value.status_code==503 and 'overflow' in exc.value.detail

def test_plant_failure_is_not_hidden_by_ecu_recovery(monkeypatch):
    monkeypatch.setattr(worker,'ROLE','plant')
    monkeypatch.setattr(worker,'process_tick',failed('Vehicle exited without stopping'))
    with pytest.raises(HTTPException) as exc:worker.tick({'time':1})
    assert 'without stopping' in exc.value.detail

def test_partial_response_cannot_bypass_application_deadline(monkeypatch):
    process=subprocess.Popen(['python3','-c','import sys,time;sys.stdin.readline();sys.stdout.write("{");sys.stdout.flush();time.sleep(5)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    monkeypatch.setattr(worker,'application',process);monkeypatch.setattr(worker,'application_buffer',b'')
    started=time.monotonic()
    try:
        with pytest.raises(RuntimeError,match='timed out'):worker.child_tick({})
        assert time.monotonic()-started<2
    finally:
        process.kill();process.wait(timeout=2)
