import asyncio
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import uuid
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path
import httpx
import sumolib
from fastapi import FastAPI, HTTPException
from .models import RouteRequest

ROOT=Path('/data/routes')
jobs={}
logger=logging.getLogger(__name__)
OVERPASS_PROVIDERS=('https://maps.mail.ru/osm/tools/overpass/api/interpreter','https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter')

def overpass_providers():
    configured=os.getenv('OVERPASS_URL','').strip()
    return list(dict.fromkeys([configured,*OVERPASS_PROVIDERS] if configured else OVERPASS_PROVIDERS))

def validate_roads(content):
    if len(content)>20_000_000:raise ValueError('Road dataset is too large')
    try:root=ET.fromstring(content)
    except ET.ParseError as exc:raise ValueError('Road provider returned invalid OSM XML') from exc
    if root.tag!='osm':raise ValueError('Road provider returned an unexpected response instead of OSM roads')
    remark=root.find('remark')
    if remark is not None:
        raise ValueError('Road provider query failed: '+''.join(remark.itertext()).strip()[:300])

async def download_roads(query,job,progress):
    providers=overpass_providers();errors={};permanent=set();retry_delay=2
    async with httpx.AsyncClient(timeout=httpx.Timeout(55,connect=8),follow_redirects=True) as client:
        for retry in range(2):
            for provider in providers:
                if provider in permanent:continue
                host=httpx.URL(provider).host
                job.update(stage=f'Downloading roads ({host}{", retry" if retry else ""})',progress=progress)
                try:
                    response=await client.post(provider,data={'data':query},headers={'User-Agent':'Personal-SDV-Test-Platform/1.0','Accept':'application/xml'})
                    response.raise_for_status()
                    validate_roads(response.content)
                    return response.content
                except httpx.TimeoutException:
                    reason='request timed out'
                except httpx.HTTPStatusError as exc:
                    reason=f'HTTP {exc.response.status_code}'
                    if exc.response.status_code==429:retry_delay=30
                    if exc.response.status_code not in (429,500,502,503,504):permanent.add(provider)
                except httpx.RequestError as exc:
                    reason=f'{type(exc).__name__}: {str(exc) or "connection failed"}'
                except ValueError as exc:
                    reason=str(exc)
                    if reason=='Road dataset is too large':raise
                errors[provider]=reason
                logger.warning('Road download from %s failed: %s',host,reason)
            if retry==0 and len(permanent)<len(providers):await asyncio.sleep(retry_delay)
    detail='; '.join(f'{httpx.URL(url).host}: {reason}' for url,reason in errors.items())
    raise ValueError(f'Could not download OpenStreetMap roads ({detail}). Retry Prepare route or check the map service internet connection and OVERPASS_URL.')

def convert(source:Path,target:Path,left_hand=False):
    command=[os.getenv('NETCONVERT_BINARY','netconvert'),'--osm-files',str(source),'--output-file',str(target),'--geometry.remove','false','--junctions.join','true','--tls.guess-signals','true','--tls.discard-simple','true','--tls.join','true','--keep-edges.by-vclass','passenger','--no-warnings','true']
    if left_hand:command += ['--lefthand','true']
    result=subprocess.run(command,capture_output=True,text=True,timeout=60)
    if result.returncode:raise ValueError('Road conversion failed: '+result.stderr[-1000:])

def route_from_net(path:Path,req:RouteRequest,route_id:str):
    net=sumolib.net.readNet(str(path),withInternal=True)
    def nearby(p):
        x,y=net.convertLonLat2XY(p.lng,p.lat)
        candidates=[]
        for edge,dist in sorted(net.getNeighboringEdges(x,y,100),key=lambda p:p[1]):
            if edge.allows('passenger') and not edge.getID().startswith(':'):
                shape=edge.getShape()
                offset=sumolib.geomhelper.polygonOffsetWithMinimumDistanceToPoint((x,y),shape)
                candidates.append((edge,offset,dist))
        return candidates[:12]
    starts=nearby(req.start);ends=nearby(req.destination)
    if not starts or not ends:raise ValueError('An endpoint is more than 100 metres from a passenger car road')
    options=[]
    for a,ao,ad in starts:
        for b,bo,bd in ends:
            if a==b and bo<=ao:continue
            path_edges,cost=net.getShortestPath(a,b,vClass='passenger',fromPos=ao,toPos=bo,withInternal=True)
            if not path_edges:continue
            distance=cost
            if 100<=distance<=5000:options.append((ad+bd,distance,path_edges,ao,bo))
    if not options:raise ValueError('No connected 100 metre–5 kilometre passenger car route; choose other endpoints')
    _,distance,edges,ao,bo=min(options,key=lambda item:(item[0],item[1]))
    coordinates=[]
    for edge in edges:
        for x,y in edge.getShape():
            lng,lat=net.convertXY2LonLat(x,y);coordinates.append({'lat':lat,'lng':lng})
    def snapped(edge,offset):
        x,y=sumolib.geomhelper.positionAtShapeOffset(edge.getShape(),offset)
        lng,lat=net.convertXY2LonLat(x,y);return {'lat':lat,'lng':lng}
    roads=[]
    for edge in net.getEdges():
        road=[]
        for x,y in edge.getShape():
            lng,lat=net.convertXY2LonLat(x,y);road.append({'lat':lat,'lng':lng})
        roads.append(road)
    result={'schema_version':'1.1','id':route_id,'name':'Gothenburg demonstration' if route_id=='gothenburg-demo' else 'Custom route','network':str(path),'edges':[e.getID() for e in edges if not e.getID().startswith(':')],'start_offset':ao,'end_offset':bo,'distance':distance,'geometry':coordinates,'roads':roads,'start':snapped(edges[0],ao),'destination':snapped(edges[-1],bo),'requested':req.model_dump(),'attribution':'© OpenStreetMap contributors, ODbL; routing by Eclipse SUMO','source_hash':hashlib.sha256(path.read_bytes()).hexdigest()}
    (path.parent/'route.json').write_text(json.dumps(result))
    return result

def bundled():
    ROOT.mkdir(parents=True,exist_ok=True)
    folder=ROOT/'gothenburg-demo';folder.mkdir(exist_ok=True)
    if not (folder/'route.json').exists() or json.loads((folder/'route.json').read_text()).get('schema_version')!='1.1':
        source=Path('/app/fixtures/gothenburg.osm.xml')
        if not source.exists():raise RuntimeError('Bundled Gothenburg OSM fixture is missing')
        shutil.copyfile(source,folder/'source.osm.xml')
        convert(folder/'source.osm.xml',folder/'network.net.xml')
        req=RouteRequest(start={'lat':57.701722908,'lng':11.970532313},destination={'lat':57.700254527,'lng':11.965092268})
        route_from_net(folder/'network.net.xml',req,'gothenburg-demo')

@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(bundled)
    yield
    for j in jobs.values():
        if j.get('task') and not j['task'].done():j['task'].cancel()

app=FastAPI(lifespan=lifespan)

@app.get('/health')
def health():return {'status':'ready'}

@app.get('/routes')
def routes():
    # Existing Stockholm recordings remain readable, but new drives default to Gothenburg.
    paths=sorted(ROOT.glob('*/route.json'),key=lambda p:(p.parent.name!='gothenburg-demo',p.parent.name))
    return [json.loads(p.read_text()) for p in paths if p.parent.name!='stockholm-demo']

@app.get('/routes/{route_id}')
def get_route(route_id:str):
    path=ROOT/route_id/'route.json'
    if not path.is_file():raise HTTPException(404,'Route not found')
    return json.loads(path.read_text())


@app.delete('/routes/{route_id}')
def delete_route(route_id:str):
    if not re.fullmatch('[a-f0-9]{20}',route_id):raise HTTPException(422,'Only prepared custom routes can be removed; bundled routes are kept')
    if any(job.get('status')=='preparing' for job in jobs.values()):raise HTTPException(409,'Wait for route preparation to finish or cancel it first')
    folder=(ROOT/route_id).resolve()
    if folder.parent!=ROOT.resolve():raise HTTPException(422,'Invalid route path')
    if not (folder/'route.json').is_file():raise HTTPException(404,'Route not found')
    shutil.rmtree(folder)
    return {'route_deleted':route_id}

async def prepare(job_id,req):
    job=jobs[job_id]
    try:
        key=hashlib.sha256(('1.1:'+req.model_dump_json()).encode()).hexdigest()[:20]
        folder=ROOT/key;folder.mkdir(exist_ok=True)
        cached=folder/'route.json'
        if cached.exists():job.update(status='ready',progress=100,stage='Ready (cached route)',route=json.loads(cached.read_text()));return
        # A bounded imported network can support many endpoint pairs, including offline.
        for existing in ROOT.glob('*/route.json'):
            if existing==cached:continue
            try:
                saved=json.loads(existing.read_text())
                if saved.get('requested',{}).get('left_hand',False)!=req.left_hand:continue
                source_net=Path(saved['network'])
                job.update(stage='Checking cached road region',progress=15)
                shutil.copyfile(source_net,folder/'network.net.xml')
                route=await asyncio.to_thread(route_from_net,folder/'network.net.xml',req,key)
                source_osm=source_net.parent/'source.osm.xml'
                if source_osm.exists():shutil.copyfile(source_osm,folder/'source.osm.xml')
                job.update(status='ready',progress=100,stage='Ready (cached roads)',route=route);return
            except (ValueError,KeyError,OSError):continue
        error=''
        for attempt,margin in enumerate((1,2,3)):
            job.update(stage='Downloading roads',progress=10+attempt*20)
            lat=(req.start.lat+req.destination.lat)/2
            dy=margin/111.32;dx=margin/(111.32*max(.1,math.cos(math.radians(lat))))
            south=min(req.start.lat,req.destination.lat)-dy;north=max(req.start.lat,req.destination.lat)+dy
            west=min(req.start.lng,req.destination.lng)-dx;east=max(req.start.lng,req.destination.lng)+dx
            area=(north-south)*111.32*(east-west)*111.32*math.cos(math.radians(lat))
            if area>100:raise ValueError('Download region exceeds 100 km²; choose closer endpoints')
            # Request a small memory budget so busy public servers can admit this bounded extract.
            query=f'[out:xml][timeout:45][maxsize:67108864];way["highway"]({south},{west},{north},{east});(._;>;);out body;'
            content=await download_roads(query,job,10+attempt*20)
            source=folder/'source.osm.xml';source.write_bytes(content)
            job.update(stage='Converting road network',progress=30+attempt*20)
            await asyncio.to_thread(convert,source,folder/'network.net.xml',req.left_hand)
            await asyncio.sleep(0)
            try:
                route=await asyncio.to_thread(route_from_net,folder/'network.net.xml',req,key)
                job.update(status='ready',progress=100,stage='Ready',route=route);return
            except ValueError as exc:error=str(exc)
        raise ValueError(error)
    except asyncio.CancelledError:job.update(status='cancelled',stage='Cancelled')
    except Exception as exc:
        logger.exception('Route preparation %s failed',job_id)
        job.update(status='failed',error=str(exc) or type(exc).__name__,stage='Failed')

@app.post('/jobs',status_code=202)
async def create_job(req:RouteRequest):
    jid=str(uuid.uuid4());jobs[jid]={'id':jid,'status':'preparing','stage':'Queued','progress':0}
    jobs[jid]['task']=asyncio.create_task(prepare(jid,req));return public_job(jid)

def public_job(jid):
    if jid not in jobs:raise HTTPException(404,'Preparation job not found')
    return {k:v for k,v in jobs[jid].items() if k!='task'}

@app.get('/jobs/{jid}')
def read_job(jid:str):return public_job(jid)

@app.delete('/jobs/{jid}')
def cancel_job(jid:str):
    public_job(jid);jobs[jid]['task'].cancel();jobs[jid]['status']='cancelled'
    return public_job(jid)
