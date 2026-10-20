import csv
import io
import json
import sqlite3
import threading
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from .observation import endpoints, signal_metadata
from .models import Selection

DBPATH=Path('/data/recordings.sqlite')
writer=None
writer_lock=threading.Lock()
@contextmanager
def connection():
    # A streaming iterator resumes serially on different Starlette worker threads.
    # Each request owns its connection; it is never shared with another iterator.
    conn=sqlite3.connect(DBPATH,timeout=10,check_same_thread=False)
    conn.row_factory=sqlite3.Row
    try:
        with conn:yield conn
    finally:conn.close()

@asynccontextmanager
async def lifespan(app):
    global writer
    DBPATH.parent.mkdir(parents=True,exist_ok=True)
    with connection() as db:
        db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,data TEXT); CREATE INDEX IF NOT EXISTS run_status ON runs(json_extract(data,\'$.status\')); CREATE TABLE IF NOT EXISTS ticks(run TEXT,t REAL,state TEXT,PRIMARY KEY(run,t)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT,t REAL,data TEXT); CREATE INDEX IF NOT EXISTS event_time ON events(run,t);')
    # Keep a connection alive between ticks. Closing the last WAL connection
    # checkpoints and removes the WAL; doing that every 50 ms stalls the drive.
    # SQLite's FULL durability and atomic state/event transactions stay intact.
    writer=sqlite3.connect(DBPATH,timeout=10,check_same_thread=False)
    try:yield
    finally:
        with writer_lock:
            writer.close()
            writer=None
app=FastAPI(lifespan=lifespan)

@app.get('/health')
def health():
    with connection() as db:db.execute('SELECT 1')
    return {'status':'ready'}


@app.get('/management/statistics')
def statistics_summary():
    with connection() as db:
        counts = {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in ('runs','ticks','events')}
        pages=db.execute('PRAGMA page_count').fetchone()[0]
        free=db.execute('PRAGMA freelist_count').fetchone()[0]
        page_size=db.execute('PRAGMA page_size').fetchone()[0]
    return dict(counts,database_bytes=pages*page_size,reusable_bytes=free*page_size)


@app.delete('/runs')
def delete_runs(selection:Selection):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        ids=list(set(selection.ids)) if selection.ids else [row[0] for row in db.execute('SELECT id FROM runs')]
        if not ids:return {'runs_deleted':0,'ids':[]}
        placeholders=','.join('?' for _ in ids)
        rows=list(db.execute(f"SELECT id,json_extract(data,'$.status') AS status FROM runs WHERE id IN ({placeholders})",ids))
        if len(rows)!=len(ids):raise HTTPException(404,'A recording no longer exists. Refresh the dashboard.')
        if any(row['status'] in ('running','starting') for row in rows):raise HTTPException(409,'Stop the drive before deleting its recording')
        events=db.execute(f'DELETE FROM events WHERE run IN ({placeholders})',ids).rowcount
        ticks=db.execute(f'DELETE FROM ticks WHERE run IN ({placeholders})',ids).rowcount
        db.execute(f'DELETE FROM runs WHERE id IN ({placeholders})',ids)
    return {'runs_deleted':len(ids),'events_deleted':events,'ticks_deleted':ticks,'ids':ids}

@app.post('/runs/{rid}')
def save_run(rid:str,data:dict):
    with connection() as db:db.execute('INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(rid,json.dumps(data)))
    return {'ok':True}

@app.get('/runs')
def runs(unfinished_only:bool=False,summary:bool=False):
    where=" WHERE json_extract(data,'$.status') IN ('running','starting')" if unfinished_only else ''
    with connection() as db:
        if summary:
            rows=db.execute("SELECT id,json_extract(data,'$.status') AS status,COALESCE(json_extract(data,'$.time'),0) AS time FROM runs"+where+' ORDER BY rowid DESC')
            return [dict(row) for row in rows]
        return [json.loads(row['data']) for row in db.execute('SELECT data FROM runs'+where+' ORDER BY rowid DESC')]

@app.get('/runs/{rid}')
def run(rid:str):
    with connection() as db:row=db.execute('SELECT data FROM runs WHERE id=?',(rid,)).fetchone()
    if not row:raise HTTPException(404,'Run not found')
    return json.loads(row['data'])

@app.post('/runs/{rid}/tick')
def write_tick(rid:str,tick:dict):
    # Commit all observations and ground truth together before live publication.
    state=json.dumps(tick['state'])
    events=[(rid,e['sim_time'],json.dumps(e)) for e in tick['events']]
    with writer_lock,writer:
        writer.execute('INSERT INTO ticks VALUES(?,?,?)',(rid,tick['time'],state))
        writer.executemany('INSERT INTO events(run,t,data) VALUES(?,?,?)',events)
    return {'ok':True,'events':len(tick['events'])}

@app.get('/runs/{rid}/timeline')
def timeline(rid:str,at:float=Query(0,ge=0),window:float=Query(.25,ge=0,le=5)):
    run(rid)
    with connection() as db:
        row=db.execute('SELECT state FROM ticks WHERE run=? AND t<=? ORDER BY t DESC LIMIT 1',(rid,at)).fetchone()
        if not row:row=db.execute('SELECT state FROM ticks WHERE run=? ORDER BY t LIMIT 1',(rid,)).fetchone()
        events=[dict(json.loads(e['data']),event_id=e['id']) for e in db.execute('SELECT id,data FROM events WHERE run=? AND t BETWEEN ? AND ? ORDER BY id',(rid,max(0,at-window),at))]
    return {'state':json.loads(row['state']) if row else None,'events':events}

@app.get('/runs/{rid}/events')
def events(rid:str,after:int=Query(0,ge=0),limit:int=Query(1000,ge=1,le=5000)):
    run(rid)
    with connection() as db:return [dict(json.loads(e['data']),event_id=e['id']) for e in db.execute('SELECT id,data FROM events WHERE run=? AND id>? ORDER BY id LIMIT ?',(rid,after,limit))]

@app.get('/runs/{rid}/export')
def export(rid:str,format:str='jsonl'):
    meta=run(rid)
    if format not in ('jsonl','csv','signals'):raise HTTPException(400,'Choose jsonl, csv or signals')
    def generate():
        with connection() as db:
            # One consistent snapshot even if this run is still recording.
            db.execute('BEGIN')
            snapshot = json.loads(db.execute('SELECT data FROM runs WHERE id=?',(rid,)).fetchone()['data'])
            if format=='jsonl':
                yield json.dumps({'type':'run','data':snapshot})+'\n'
                for row in db.execute('SELECT state FROM ticks WHERE run=? ORDER BY t',(rid,)):yield json.dumps({'type':'state','data':json.loads(row['state'])})+'\n'
                for row in db.execute('SELECT id,data FROM events WHERE run=? ORDER BY id',(rid,)):yield json.dumps({'type':'event','data':dict(json.loads(row['data']),event_id=row['id'])})+'\n'
            else:
                common=['run_id','event_id','sim_time','monotonic_ns','module','source','destination','direction','protocol','kind','message_id','sequence','raw']
                fields=common+(['message','signal','value','unit','vss'] if format=='signals' else ['decoded'])
                buf=io.StringIO();writer=csv.DictWriter(buf,fieldnames=fields,extrasaction='ignore');writer.writeheader();yield buf.getvalue()
                for row in db.execute('SELECT id,data FROM events WHERE run=? ORDER BY id',(rid,)):
                    data=dict(json.loads(row['data']),run_id=rid,event_id=row['id'])
                    data['source'],data['destination'],data['direction']=endpoints(data)
                    decoded=data.get('decoded',{})
                    observations=[]
                    if format=='signals':
                        if data.get('protocol') not in ('CAN','SOME/IP'):continue
                        for name,value in decoded.items():
                            message,unit,vss=signal_metadata(data,name)
                            observations.append(dict(data,message=message,signal=name,value=value,unit=unit,vss=vss))
                    else:observations=[dict(data,decoded=json.dumps(decoded))]
                    for observation in observations:
                        buf.seek(0);buf.truncate();writer.writerow(observation);yield buf.getvalue()
    filename=f'{rid}.signals.csv' if format=='signals' else f'{rid}.{format}'
    return StreamingResponse(generate(),media_type='application/x-ndjson' if format=='jsonl' else 'text/csv',headers={'Content-Disposition':f'attachment; filename="{filename}"'})

@app.delete('/runs/{rid}')
def delete(rid:str):
    run(rid)
    with connection() as db:
        db.execute('DELETE FROM events WHERE run=?',(rid,));db.execute('DELETE FROM ticks WHERE run=?',(rid,));db.execute('DELETE FROM runs WHERE id=?',(rid,))
    return {'deleted':rid}
