"""Repeatable live CARLA benchmark. Run only against an idle platform."""
import argparse
import json
from pathlib import Path
import sqlite3
import time

import httpx


def benchmark(url, profiles, duration, repeats, output):
    results=[]
    with httpx.Client(base_url=url, timeout=30) as client:
        def call(path, method='GET', data=None):
            response=client.request(method,path,json=data)
            response.raise_for_status()
            return response.json()
        if call('/health')['active_run']:raise RuntimeError('Keep the active drive running; benchmark requires an idle platform')
        for profile in profiles:
            graphics,resolution=profile.split(':')
            for repeat in range(repeats):
                if call('/health')['active_run']:raise RuntimeError('Another drive started; stopping benchmark')
                run=call('/runs','POST',{'route_id':'carla-city','duration':duration,'seed':42,
                         'carla':dict(graphics=graphics,resolution=resolution), 'assertions':[{'kind':'no_recorder_loss'}]})
                rid=run['id'];started=time.monotonic()
                try:
                    call(f'/runs/{rid}/start','POST')
                    deadline=started+300
                    while time.monotonic()<deadline:
                        run=call(f'/runs/{rid}')
                        if run['status'] not in ('starting','running'):break
                        time.sleep(.25)
                    if run['status']!='timed_out' or not run['recording_valid']:
                        raise RuntimeError(f"Run {rid}: {run['status']} at {run['time']} s: {run.get('error')}")
                    end=call(f'/runs/{rid}/timeline?at={duration}&window=0.05')
                    with sqlite3.connect('file:/data/recordings.sqlite?mode=ro',uri=True) as db:
                        ticks=db.execute('SELECT COUNT(*) FROM ticks WHERE run=?',(rid,)).fetchone()[0]
                        counts=dict(db.execute("SELECT json_extract(data,'$.protocol'),COUNT(*) FROM events WHERE run=? GROUP BY json_extract(data,'$.protocol')",(rid,)))
                        failures=db.execute("SELECT COUNT(*) FROM events WHERE run=? AND json_extract(data,'$.kind')='failed'",(rid,)).fetchone()[0]
                    cameras={view:len(list((Path('/data/carla')/rid/view).glob('*.jpg'))) for view in ('driver','chase')}
                    row=dict(id=rid,profile=profile,repeat=repeat+1,sim_seconds=run['time'],wall_seconds=run['wall_duration'],
                             realtime_factor=round(run['time']/run['wall_duration'],3),ticks=ticks,cameras=cameras,events=counts,
                             failures=failures,pedestrians=end['state']['pedestrian_count'],traffic=end['state']['traffic_count'],
                             performance=run.get('performance',{}),startup_seconds=round(time.monotonic()-started-run['wall_duration'],3))
                    results.append(row)
                    Path(output).write_text(json.dumps(results,indent=2))
                    print(json.dumps(row),flush=True)
                finally:
                    if call('/health')['active_run']==rid:
                        if run['status'] in ('starting','running'):client.post(f'/runs/{rid}/stop')
                        # Final metadata is readable while camera/SDK cleanup
                        # finishes; do not mistake our own cleanup for a new run.
                        deadline=time.monotonic()+30
                        while call('/health')['active_run']==rid:
                            if time.monotonic()>deadline:raise RuntimeError('Benchmark drive cleanup timed out')
                            time.sleep(.1)
    return results


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://api:8000/api/v1')
    parser.add_argument('--profiles',nargs='+',default=['high:1080p','low:720p'])
    parser.add_argument('--duration',type=float,default=12)
    parser.add_argument('--repeats',type=int,default=2)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    benchmark(args.url,args.profiles,args.duration,args.repeats,args.output)
