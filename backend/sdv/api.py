import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.responses import StreamingResponse, Response, FileResponse
from starlette.concurrency import run_in_threadpool
from . import imagery
from .models import RunRequest, RouteRequest, Fault, ROLES, ModuleManifest
from .observation import catalog
from .models import Selection

client=None
active=None
current={}
sockets={}
tasks={}
run_lock=asyncio.Lock()
gateway_status={'status':'connecting'}
provenance={}

async def request(service,path,method='GET',data=None,timeout=None):
    options={} if timeout is None else {'timeout':httpx.Timeout(timeout,connect=5)}
    response=await client.request(method,f'http://{service}:8000{path}',json=data,**options)
    if response.is_error:
        try:detail=response.json().get('detail',response.text)
        except ValueError:detail=response.text
        raise HTTPException(response.status_code,detail)
    return response.json()

@asynccontextmanager
async def lifespan(app):
    global client
    imagery.initialize()
    client=httpx.AsyncClient(timeout=5,limits=httpx.Limits(max_connections=40,max_keepalive_connections=30))
    if Path('/data/provenance.json').exists():provenance.update(json.loads(Path('/data/provenance.json').read_text()))
    for run in await request('recorder','/runs?unfinished_only=true'):
        if run['status'] in ('running','starting'):
            run.update(status='interrupted',recording_valid=False,error='Platform restarted during run')
            await request('recorder',f"/runs/{run['id']}",'POST',run)
    yield
    for task in tasks.values():task.cancel()
    await asyncio.gather(*tasks.values(),return_exceptions=True)
    await client.aclose()

app=FastAPI(title='Personal SDV Lab',version='1.0.0',lifespan=lifespan)


class RecordingSelection(Selection):
    include_images: bool = False


def require_idle():
    if active:raise HTTPException(409,'Stop the active drive before changing the simulation environment')


@app.get('/api/v1/management/overview')
async def management_overview():
    recording,images,platform=await asyncio.gather(request('recorder','/management/statistics',timeout=30),
                                                  run_in_threadpool(imagery.statistics_summary),health())
    return {'recordings':recording,'images':images,'platform':platform}


@app.delete('/api/v1/management/recordings')
async def management_delete_recordings(selection:RecordingSelection):
    async with run_lock:
        require_idle()
        try:value=await request('recorder','/runs','DELETE',selection.model_dump(exclude={'include_images'}),timeout=120)
        except httpx.TimeoutException as exc:raise HTTPException(504,'Cleanup timed out. Refresh the dashboard before retrying to check whether it completed.') from exc
        for rid in value['ids']:
            current.pop(rid,None)
            tasks.pop(rid,None)
            from .carla_backend import remove_camera_recording
            await run_in_threadpool(remove_camera_recording,rid)
        if selection.include_images:
            # If this second store fails, identify the already committed deletion.
            try:value.update(await run_in_threadpool(imagery.delete_run_captures,value['ids']))
            except Exception as exc:raise HTTPException(500,f"{value['runs_deleted']} recordings were deleted, but image cleanup failed. Use the Images section to retry.") from exc
        return value


@app.delete('/api/v1/management/images')
async def management_delete_images(selection:Selection):
    async with run_lock:
        require_idle()
        try:return await run_in_threadpool(imagery.delete_images,selection.ids)
        except KeyError as exc:raise HTTPException(404,str(exc)) from exc


@app.post('/api/v1/management/images',status_code=201)
async def management_import_image(request_body:Request,filename:str=Query(min_length=1,max_length=128)):
    require_idle()
    data=bytearray()
    async for chunk in request_body.stream():
        data.extend(chunk)
        if len(data)>imagery.MAX_IMAGE_BYTES:raise HTTPException(413,'Image exceeds 12 MiB')
    async with run_lock:
        require_idle()
        try:return await run_in_threadpool(imagery.import_image,bytes(data),filename)
        except ValueError as exc:raise HTTPException(422,str(exc)) from exc


@app.post('/api/v1/management/reset')
async def management_reset():
    async with run_lock:
        require_idle()
        async def reset_module(role):
            try:
                if role=='plant':await request(role,'/shutdown','POST',{})
                return role,{'status':'reset','result':await request(role,'/reset','POST',{})}
            except Exception as exc:return role,{'status':'failed','error':str(exc)}
        results=dict(await asyncio.gather(*(reset_module(role) for role in ('plant',*ROLES))))
        return {'status':'reset' if all(v['status']=='reset' for v in results.values()) else 'partial','services':results}


@app.delete('/api/v1/management/routes/{route_id}')
async def management_delete_route(route_id:str):
    async with run_lock:
        require_idle()
        return await request('maps',f'/routes/{route_id}','DELETE')

@app.get('/api/v1/health')
async def health():
    names=['maps','recorder','plant',*ROLES]
    async def inspect(name):
        try:return name,await request(name,'/health')
        except Exception as exc:return name,{'status':'unavailable','error':str(exc)}
    services=dict(await asyncio.gather(*(inspect(n) for n in names)))
    return {'status':'ready' if all(v.get('status')!='unavailable' and v.get('application') not in ('failed','stopped') for v in services.values()) else 'degraded','services':services,'gateway':gateway_status,'active_run':active}

@app.get('/api/v1/config')
def config():
    carla=os.getenv('SIMULATOR_BACKEND','sumo')=='carla'
    return {'mapillary_access_token':'' if carla else os.getenv('MAPILLARY_ACCESS_TOKEN',''),'modules':list(ROLES),'step_seconds':.05,'max_run_seconds':900,'backend':'carla' if carla else 'sumo','imagery_provider':'carla' if carla else 'mapillary','map_provider':'carla' if carla else 'openstreetmap','imagery':'Live CARLA cameras and simulated actors' if carla else 'Mapillary panoramas and street photographs; scenery does not represent simulated objects'}

@app.get('/api/v1/routes')
async def routes():
    if os.getenv('SIMULATOR_BACKEND','sumo')=='carla':
        from .carla_backend import city_route
        return [city_route()]
    return await request('maps','/routes')

@app.get('/api/v1/carla/status')
async def carla_status():
    return await request('plant','/carla/status')

@app.get('/api/v1/runs/{rid}/carla/camera/{view}')
async def carla_camera(rid:str,view:str,at:float|None=Query(None,ge=0,le=900)):
    from .carla_backend import camera_path
    if view not in ('driver','chase'):raise HTTPException(404,'Unknown camera')
    run=await get_run(rid)
    if run['route'].get('backend')!='carla':raise HTTPException(404,'This drive has no CARLA camera recording')
    try:directory=camera_path(rid)/view
    except ValueError:raise HTTPException(404,'Invalid drive ID')
    frames=sorted(directory.glob('*.jpg'))
    if at is not None:frames=[p for p in frames if int(p.stem)<=round(at*1000)]
    if not frames:raise HTTPException(404,'Waiting for a CARLA camera frame at this simulation time')
    frame=frames[-1]
    return FileResponse(frame,media_type='image/jpeg',headers={'Cache-Control':'no-store','X-CARLA-Simulation-Time':str(int(frame.stem)/1000)})

@app.post('/api/v1/routes/prepare',status_code=202)
async def prepare(req:RouteRequest):return await request('maps','/jobs','POST',req.model_dump())

@app.get('/api/v1/routes/jobs/{jid}')
async def job(jid:str):return await request('maps',f'/jobs/{jid}')

@app.delete('/api/v1/routes/jobs/{jid}')
async def cancel(jid:str):return await request('maps',f'/jobs/{jid}','DELETE')

@app.get('/api/v1/contracts')
def contracts():
    return catalog()

@app.get('/api/v1/images')
def image_database(offset:int=Query(0,ge=0),limit:int=Query(50,ge=1,le=100)):
    return imagery.list_images(offset,limit)

@app.get('/api/v1/image-captures')
def capture_database(run_id:str|None=None,offset:int=Query(0,ge=0),limit:int=Query(24,ge=1,le=100)):
    return imagery.list_captures(run_id,offset,limit)

@app.get('/api/v1/image-captures/{rid}/{station_index}/similarity')
def capture_comparisons(rid:str,station_index:int,offset:int=Query(0,ge=0),limit:int=Query(20,ge=1,le=100),matches_only:bool=False):
    # Image history survives vehicle recording deletion and has its own browse API.
    value=imagery.similarity(rid,station_index,offset,limit,matches_only)
    if value['status']!='ready':raise HTTPException(404,'Captured station not found')
    return value

@app.get('/api/v1/images/{image_id}')
def captured_image(image_id:str):
    image=imagery.image_bytes(image_id)
    if not image:raise HTTPException(404,'Captured image not found')
    return Response(image[0],media_type=image[1])

@app.get('/api/v1/runs/{rid}/images/{station_index}/similarity')
async def view_similarity(rid:str,station_index:int):
    run=await get_run(rid)
    if not 0<=station_index<=int(run['route']['distance']//25):raise HTTPException(422,'Image station is outside the route')
    return await run_in_threadpool(imagery.similarity,rid,station_index)

@app.post('/api/v1/runs/{rid}/images/{station_index}',status_code=201)
async def capture_image(rid:str,station_index:int,request_body:Request,
                        provider_image_id:str=Query(min_length=1,max_length=128),
                        sim_time:float=Query(ge=0,le=900,allow_inf_nan=False),
                        lat:float=Query(ge=-90,le=90,allow_inf_nan=False),
                        lng:float=Query(ge=-180,le=180,allow_inf_nan=False),
                        captured_at:float|None=Query(None,ge=0,le=8.64e15,allow_inf_nan=False)):
    run=await get_run(rid)
    if run['status']!='running':raise HTTPException(409,'Images are captured only during a live drive')
    if not 0<=station_index<=int(run['route']['distance']//25):raise HTTPException(422,'Image station is outside the route')
    data=bytearray()
    async for chunk in request_body.stream():
        data.extend(chunk)
        if len(data)>imagery.MAX_IMAGE_BYTES:raise HTTPException(413,'Image exceeds 12 MiB')
    try:
        async with run_lock:
            if (await get_run(rid))['status']!='running':raise HTTPException(409,'The drive ended before this image was saved')
            return await run_in_threadpool(imagery.capture,rid,station_index,bytes(data),provider_image_id,sim_time,lat,lng,captured_at)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc

@app.get('/api/v1/modules')
def modules():return [ModuleManifest.model_validate(m).model_dump() for m in json.loads(Path('/app/contracts/modules.json').read_text())]

@app.post('/api/v1/runs',status_code=201)
async def create(req:RunRequest):
    if req.route_id=='carla-city':
        from .carla_backend import city_route
        route=city_route()
    else:route=await request('maps',f'/routes/{req.route_id}')
    run={'id':str(uuid.uuid4()),'status':'created','created_at':time.time(),'configuration':req.model_dump(),'route':route,'recording_valid':True,'time':0,'results':[],'dependencies':json.loads(Path('/app/dependencies.json').read_text()),'provenance':dict(provenance)}
    for f in run['configuration']['faults']:f['id']=f['id'] or str(uuid.uuid4())
    await request('recorder',f"/runs/{run['id']}",'POST',run)
    return run

@app.get('/api/v1/runs')
async def runs(summary:bool=False):return await request('recorder','/runs?summary=true' if summary else '/runs')

@app.get('/api/v1/runs/{rid}')
async def get_run(rid:str):return current[rid]['run'] if rid in current else await request('recorder',f'/runs/{rid}')

@app.post('/api/v1/runs/{rid}/start')
async def start(rid:str):
    global active
    async with run_lock:
        if active:raise HTTPException(409,'Another run is active')
        run=await get_run(rid)
        if run['status']!='created':raise HTTPException(409,'Create a new run to repeat this configuration')
        active=rid;run['status']='starting'
        current[rid]={'run':run,'state':None,'signals':{},'health':{},'stop':False,'lane_request':0}
        tasks[rid]=asyncio.create_task(drive(rid))
    return run

@app.post('/api/v1/runs/{rid}/stop')
async def stop(rid:str):
    if active!=rid:raise HTTPException(409,'Run is not active')
    current[rid]['stop']=True
    return {'status':'stopping'}

@app.post('/api/v1/runs/{rid}/lane')
async def lane(rid:str,data:dict):
    if active!=rid:raise HTTPException(409,'Run is not active')
    if data.get('direction') not in (-1,0,1):raise HTTPException(422,'Lane direction must be -1, 0, or 1')
    current[rid]['lane_request']=data['direction'];return {'accepted':True}

@app.post('/api/v1/runs/{rid}/faults')
async def fault(rid:str,f:Fault):
    if active!=rid:raise HTTPException(409,'Run is not active')
    item=f.model_dump();item['id']=str(uuid.uuid4());item['at']=max(item['at'],current[rid]['run']['time'])
    current[rid]['run']['configuration']['faults'].append(item)
    return item

@app.delete('/api/v1/runs/{rid}/faults/{fid}')
async def remove_fault(rid:str,fid:str):
    if active!=rid:raise HTTPException(409,'Run is not active')
    for f in current[rid]['run']['configuration']['faults']:
        if f['id']==fid:f['duration']=max(0,current[rid]['run']['time']-f['at']);return {'removed':fid}
    raise HTTPException(404,'Fault not found')

async def publish(rid,payload):
    # Live views may skip a display update; they must never stall the plant.
    for queue in list(sockets.get(rid,{}).values()):
        if queue.full():queue.get_nowait()
        queue.put_nowait(payload)

def assertions(run,state):
    out=[]
    for assertion in run['configuration']['assertions']:
        kind=assertion['kind'];value=assertion['value']
        observed={'arrived':state.get('arrived',False),'max_speed':run.get('peak_speed',0),'min_charge':run.get('min_charge',100),'stopped':state.get('speed',999),'no_recorder_loss':run['recording_valid']}[kind]
        passed=bool(observed) if kind in ('arrived','no_recorder_loss') else observed<=value if kind in ('max_speed','stopped') else observed>=value
        out.append({'kind':kind,'expected':value if kind not in ('arrived','no_recorder_loss') else True,'observed':observed,'passed':passed})
    return out

async def drive(rid):
    global active
    ctx=current[rid];run=ctx['run'];cfg=run['configuration'];prior_faults=set();valid=True
    try:
        await request('recorder',f'/runs/{rid}','POST',run)
        await asyncio.gather(*(request(role,'/reset','POST',{}) for role in ('plant',*ROLES)))
        is_carla=run['route'].get('backend')=='carla'
        state=await request('plant','/load','POST',{'route':run['route'],'vehicle':cfg['vehicle'],'seed':cfg['seed'],'run_id':rid},timeout=600 if is_carla else 5)
        if 'carla_route' in state:run['route']=state.pop('carla_route')
        ctx['state']=state
        await asyncio.sleep(1) # discovery and subscription startup, outside simulated time
        run['status']='running';started=time.monotonic();seq=0;previous_start=None
        await request('recorder',f'/runs/{rid}','POST',run)
        await publish(rid,{'type':'started','run':run,'state':state,'signals':{},'health':ctx['health']})
        while run['time']<cfg['duration'] and not ctx['stop']:
            tick_start=time.monotonic();t=round(state['time'],6);events=[]
            if previous_start is not None and tick_start-previous_start>.075:
                events.append({'module':'platform','protocol':'SIM','kind':'overrun','duration_ms':(tick_start-previous_start)*1000,'sim_time':t,'monotonic_ns':time.monotonic_ns()})
            previous_start=tick_start
            active_faults=[f for f in cfg['faults'] if f['at']<=t<f['at']+f['duration']]
            ids={f['id'] for f in active_faults}
            for fid in ids^prior_faults:
                f=next(x for x in cfg['faults'] if x['id']==fid)
                events.append({'module':f['module'],'protocol':'FAULT','kind':'activated' if fid in ids else 'removed','fault':f,'sim_time':t,'monotonic_ns':time.monotonic_ns()})
            prior_faults=ids
            base={'time':t,'sequence':seq,'vehicle':cfg['vehicle'],'truth':state,'lane_request':ctx['lane_request'],'modules':cfg.get('modules',{})}
            async def tick(role):
                try:
                    result=await request(role,'/tick','POST',dict(base,faults=[f for f in active_faults if f['module']==role]),timeout=150 if role=='plant' and is_carla else 5)
                    ctx['health'][role]=result['health'];events.extend(result.get('events',[]));return result
                except Exception as exc:
                    ctx['health'][role]={'application':'failed','error':str(exc)}
                    if role=='plant':raise
                    if 'overflow' in str(exc).lower():raise RuntimeError('Recorder observation lost: '+str(exc))
                    events.append({'module':role,'protocol':'HEALTH','kind':'failed','error':str(exc),'sim_time':t,'monotonic_ns':time.monotonic_ns()})
                    return {}
            await asyncio.gather(*(tick(role) for role in ('sensor','bms','navigation')))
            await asyncio.sleep(.002)
            await tick('controller')
            await asyncio.sleep(.002)
            await asyncio.gather(*(tick(role) for role in ('powertrain','brake','lane')))
            await asyncio.sleep(.002)
            result=await tick('plant');state=result['state'];ctx['state']=state
            ctx['lane_request']=0
            for event in events:
                event['run_id']=rid
                if event.get('kind')=='tx' and event.get('protocol')=='CAN':ctx['signals'].update(event.get('decoded',{}))
            run['time']=state['time'];run['peak_speed']=max(run.get('peak_speed',0),state['speed']);run['min_charge']=min(run.get('min_charge',100),state['charge_pct'])
            elapsed=time.monotonic()-tick_start
            if elapsed>.075:events.append({'run_id':rid,'module':'platform','protocol':'SIM','kind':'overrun','duration_ms':elapsed*1000,'sim_time':t,'monotonic_ns':time.monotonic_ns()})
            await request('recorder',f'/runs/{rid}/tick','POST',{'time':state['time'],'state':state,'events':events})
            essential=[e for e in events if e['protocol']!='CAN' or e['kind']=='tx'][-25:]
            receives=[e for e in events if e['protocol']=='CAN' and e['kind']=='rx']
            offset=seq%len(receives) if receives else 0
            display=sorted(essential+(receives[offset:]+receives[:offset])[:25-len(essential)],key=lambda e:e.get('monotonic_ns',0))
            await publish(rid,{'type':'tick','run':{'id':rid,'status':run['status'],'time':run['time']},'state':state,'signals':ctx['signals'],'health':ctx['health'],'events':display,'display_omitted':max(0,len(events)-len(display)),'faults':active_faults})
            seq+=1
            if state['arrived']:run['status']='completed';break
            await asyncio.sleep(max(0,.05-(time.monotonic()-tick_start)))
        if run['status']=='running':run['status']='stopped' if ctx['stop'] else 'timed_out'
        run['wall_duration']=time.monotonic()-started
    except asyncio.CancelledError:run.update(status='interrupted',error='Run task cancelled',recording_valid=False)
    except Exception as exc:run.update(status='failed',error=str(exc),recording_valid=False)
    finally:
        run['results']=assertions(run,ctx['state'] or {})
        try:await request('plant','/shutdown','POST',{},timeout=150 if run['route'].get('backend')=='carla' else 5)
        except Exception:pass
        try:await request('recorder',f'/runs/{rid}','POST',run)
        except Exception:run.update(status='failed',recording_valid=False,error='Recorder unavailable; final metadata could not be saved')
        await publish(rid,{'type':'finished','run':run,'state':ctx['state'],'signals':ctx['signals'],'health':ctx['health']})
        active=None

@app.websocket('/api/v1/runs/{rid}/stream')
async def stream(ws:WebSocket,rid:str):
    await ws.accept()
    try:run=await get_run(rid)
    except Exception:await ws.close(code=1008);return
    queue=asyncio.Queue(maxsize=2)
    sockets.setdefault(rid,{})[ws]=queue
    if rid in current:
        ctx=current[rid];await ws.send_json({'type':'snapshot','run':ctx['run'],'state':ctx['state'],'signals':ctx['signals'],'health':ctx['health']})
    else:
        timeline=await request('recorder',f'/runs/{rid}/timeline?at={run["time"]}')
        await ws.send_json({'type':'snapshot','run':run,**timeline})
    async def send_updates():
        try:
            while True:await asyncio.wait_for(ws.send_json(await queue.get()),timeout=1)
        except asyncio.CancelledError:raise
        except Exception:
            try:await ws.close(code=1013)
            except Exception:pass
    sender=asyncio.create_task(send_updates())
    try:
        while True:await ws.receive_text()
    except WebSocketDisconnect:pass
    finally:
        sockets.get(rid,{}).pop(ws,None);sender.cancel();await asyncio.gather(sender,return_exceptions=True)

@app.get('/api/v1/runs/{rid}/timeline')
async def timeline(rid:str,at:float=Query(0,ge=0),window:float=Query(.25,ge=0,le=5)):
    return await request('recorder',f'/runs/{rid}/timeline?at={at}&window={window}')

@app.post('/api/v1/runs/{rid}/replay')
async def replay(rid:str,data:dict):
    run=await get_run(rid)
    if run['status'] in ('running','starting'):raise HTTPException(409,'Replay requires a finished run')
    at=max(0,min(run['time'],float(data.get('at',0))))
    value=await request('recorder',f'/runs/{rid}/timeline?at={at}')
    await publish(rid,{'type':'replay','run':run,'cursor':at,**value})
    return value

@app.get('/api/v1/runs/{rid}/events')
async def event_list(rid:str,after:int=0,limit:int=1000):return await request('recorder',f'/runs/{rid}/events?after={after}&limit={limit}')

@app.get('/api/v1/runs/{rid}/export')
async def export(rid:str,format:str='jsonl'):
    if format not in ('jsonl','csv','signals'):raise HTTPException(400,'Choose jsonl, csv or signals')
    response=await client.send(client.build_request('GET',f'http://recorder:8000/runs/{rid}/export?format={format}'),stream=True)
    if response.is_error:await response.aclose();raise HTTPException(response.status_code,'Export unavailable')
    async def content():
        try:
            async for chunk in response.aiter_bytes():yield chunk
        finally:await response.aclose()
    return StreamingResponse(content(),media_type=response.headers.get('content-type'),headers={'Content-Disposition':response.headers.get('content-disposition',f'attachment; filename="{rid}.{format}"')})

@app.delete('/api/v1/runs/{rid}')
async def delete(rid:str):
    async with run_lock:
        if active==rid:raise HTTPException(409,'Stop run before deleting it')
        value=await request('recorder',f'/runs/{rid}','DELETE')
        current.pop(rid,None)
        from .carla_backend import remove_camera_recording
        await run_in_threadpool(remove_camera_recording,rid)
        return value

@app.get('/api/v1/telemetry')
def telemetry():
    if active:return {'run_id':active,'state':current[active]['state'],'signals':current[active]['signals']}
    return {'run_id':None,'state':None,'signals':{}}

@app.post('/api/v1/gateway/status')
def gateway_update(data:dict):gateway_status.update(data);return {'ok':True}

@app.post('/api/v1/provenance')
def update_provenance(data:dict):
    provenance.clear();provenance.update(data)
    Path('/data/provenance.json').write_text(json.dumps(data))
    return {'ok':True}
