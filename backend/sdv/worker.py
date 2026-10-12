import asyncio
import json
import os
import shlex
import socket
import subprocess
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from .sdk import Transport, DB

ROLE=os.getenv('ROLE','sensor')
transport=None
native=None
application=None
application_buffer=b''
pending=[]
freeze={}
stopped=False
withdrawn=False
plant=None

def launch_application():
    global application,application_buffer
    command=os.getenv('APPLICATION_COMMAND','python3 -m sdv.application')
    application=subprocess.Popen(shlex.split(command),stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
    application_buffer=b''

def ip_config():
    config={'unicast':socket.gethostbyname(socket.gethostname()),'logging':{'level':'warning','console':'true'},'applications':[{'name':ROLE,'id':'0x1101' if ROLE=='navigation' else '0x1102'}],'routing':ROLE,'service-discovery':{'enable':'true','multicast':'224.224.224.245','port':'30490','protocol':'udp','initial_delay_min':'10','initial_delay_max':'20','repetitions_base_delay':'50','repetitions_max':'3','ttl':'3','cyclic_offer_delay':'500','request_response_delay':'10'},'services':[{'service':'0x1234','instance':'0x0001','unreliable':'30509','events':[{'event':'0x8001','is_field':'true','is_reliable':'false'}],'eventgroups':[{'eventgroup':'0x0001','events':['0x8001']}]}]}
    path='/tmp/vsomeip.json'
    # Docker supplies a default route but no explicit multicast route notification.
    # vSomeIP can use the existing interface without privileged route changes.
    config['service-discovery']['wait_route_netlink_notification']='false'
    if ROLE!='navigation':config['services']=[]
    with open(path,'w') as f: json.dump(config,f)
    os.environ['VSOMEIP_CONFIGURATION']=path
    os.environ['VSOMEIP_APPLICATION_NAME']=ROLE

@asynccontextmanager
async def lifespan(app):
    global transport,native,plant
    ip_config()
    native=subprocess.Popen(['sdv-adapter',ROLE])
    transport=await asyncio.to_thread(Transport)
    if ROLE=='plant':
        from .simulator import SumoBackend
        plant=SumoBackend()
    else: launch_application()
    yield
    if plant: plant.shutdown()
    if application and application.poll() is None: application.terminate()
    if native and native.poll() is None: native.terminate()

app=FastAPI(lifespan=lifespan)

@app.get('/health')
def health():
    if not native or native.poll() is not None: raise HTTPException(503,'Native adapter unavailable')
    return {'module':ROLE,'transport':'ready','application':'stopped' if stopped else 'running' if ROLE=='plant' or application and application.poll() is None else 'failed'}

@app.post('/reset')
def reset():
    global stopped,withdrawn
    from . import adapter_pb2 as pb
    pending.clear();freeze.clear();stopped=False
    transport.stub.Reset(pb.Empty(),timeout=2)
    if ROLE=='navigation': transport.stub.Offer(pb.OfferRequest(enabled=True),timeout=2)
    withdrawn=False
    if ROLE!='plant':
        if application and application.poll() is None: application.terminate();application.wait(timeout=2)
        launch_application()
    return health()

@app.post('/load')
def load(ctx:dict):
    if ROLE!='plant': raise HTTPException(400,'Only plant loads worlds')
    plant.load_world(ctx['route'],ctx['vehicle'],ctx['seed'])
    return plant.state()

@app.post('/shutdown')
def shutdown():
    if plant: plant.shutdown()
    pending.clear()
    return {'ok':True}

def child_tick(ctx):
    global application_buffer
    if application.poll() is not None: raise RuntimeError('ECU application exited')
    application.stdin.write(json.dumps(ctx)+'\n');application.stdin.flush()
    # HTTP supervisor offloads this bounded wait; a hung application is terminated.
    import select
    deadline=time.monotonic()+1
    while b'\n' not in application_buffer:
        remaining=deadline-time.monotonic()
        if remaining<=0 or not select.select([application.stdout],[],[],remaining)[0]:
            application.kill();raise RuntimeError('ECU application tick timed out')
        chunk=os.read(application.stdout.fileno(),65536)
        if not chunk:raise RuntimeError('ECU application output closed')
        application_buffer+=chunk
        if len(application_buffer)>1_000_000:
            application.kill();raise RuntimeError('ECU application response exceeds one megabyte')
    line,application_buffer=application_buffer.split(b'\n',1)
    result=json.loads(line)
    if 'error' in result: raise RuntimeError(result['error'])
    return result

def process_tick(ctx:dict):
    global stopped,withdrawn
    from . import adapter_pb2 as pb
    t=ctx['time']
    faults=ctx.get('faults',[])
    should_stop=any(f['kind']=='stop' for f in faults)
    if should_stop and not stopped:
        if application and application.poll() is None: application.terminate();application.wait(timeout=2)
        stopped=True
    elif not should_stop and stopped:
        launch_application();stopped=False
    should_withdraw=any(f['kind']=='withdraw' for f in faults)
    if ROLE=='navigation' and should_withdraw!=withdrawn:
        transport.stub.Offer(pb.OfferRequest(enabled=not should_withdraw),timeout=2);withdrawn=should_withdraw
    for item in list(pending):
        if item[0]<=time.monotonic():
            if item[1]=='can':transport.send(*item[2])
            else:transport.intent(item[2])
            pending.remove(item)
    network=transport.snapshot()
    if ROLE=='plant':
        state,extra=plant.advance(network)
        return {'state':state,'events':transport.events(ROLE,t)+extra,'health':health()}
    if stopped:
        return {'events':transport.events(ROLE,t),'health':health()}
    appctx={'sequence':ctx['sequence'],'vehicle':ctx['vehicle'],'network':network,'lane_request':ctx.get('lane_request',0),'configuration':ctx.get('modules',{}).get(ROLE,{})}
    if ROLE in ('sensor','bms','navigation'): appctx['truth']=ctx['truth']
    actions=child_tick(appctx)
    applied=[]
    for mid,values in actions.get('can',[]):
        for f in faults:
            if f['kind'] in ('freeze','substitute') and (f.get('message_id') is None or f['message_id']==mid):
                signal=f['signal']
                if signal not in values: raise HTTPException(422,f'Unknown {ROLE} signal {signal}')
                key=f['id']
                if f['kind']=='freeze': values[signal]=freeze.setdefault(key,values[signal])
                else: values[signal]=f['value']
        msg=DB.get_message_by_frame_id(mid)
        # Reject invalid injected values explicitly, rather than crashing the native adapter.
        msg.encode(values)
        selected=[f for f in faults if f.get('message_id') is None or f['message_id']==mid]
        if any(f['kind']=='drop' for f in selected): applied.append({'kind':'adapter_drop','message_id':mid});continue
        delay=max([f['delay_ms']/1000 for f in selected if f['kind']=='delay'] or [0])
        if delay:pending.append((time.monotonic()+delay,'can',(mid,values)))
        else:transport.send(mid,values)
        if any(f['kind']=='duplicate' for f in selected):transport.send(mid,values)
    if 'intent' in actions:
        if any(f['kind']=='drop' for f in faults):applied.append({'kind':'adapter_drop','message_id':0x8001})
        else:
            delay=max([f['delay_ms']/1000 for f in faults if f['kind']=='delay'] or [0])
            if delay:pending.append((time.monotonic()+delay,'intent',actions['intent']))
            else:transport.intent(actions['intent'])
            if any(f['kind']=='duplicate' for f in faults):transport.intent(actions['intent'])
    events=transport.events(ROLE,t)
    events += [dict(e,module=ROLE,protocol='FAULT',sim_time=t,monotonic_ns=time.monotonic_ns()) for e in applied]
    return {'events':events,'health':health()}

@app.post('/tick')
def tick(ctx:dict):
    try:return process_tick(ctx)
    except Exception as exc:
        if ROLE=='plant' or 'overflow' in str(exc).lower():raise HTTPException(503,str(exc))
        # An application failure does not turn off its observer or discard RX events.
        try:events=transport.events(ROLE,ctx['time'])
        except Exception as observation_error:raise HTTPException(503,str(observation_error))
        events.append({'module':ROLE,'protocol':'HEALTH','kind':'failed','error':str(exc),'sim_time':ctx['time'],'monotonic_ns':time.monotonic_ns()})
        return {'events':events,'health':{'module':ROLE,'application':'failed','error':str(exc)}}
