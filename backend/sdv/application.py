"""Reference replaceable ECU application. One JSON tick in, one action object out."""
import json
import math
import os
import sys

def frame(ctx, mid):
    f=ctx.get('network',{}).get('frames',{}).get(str(mid),{})
    return f.get('signals',{}) if f.get('age',999)<=0.2 else None

def compute(role, ctx):
    seq=ctx['sequence']%65536
    truth=ctx.get('truth',{})
    profile=ctx.get('vehicle',{})
    if role=='sensor':
        return {'can':[[256,{'Speed':truth['speed'],'Latitude':truth['lat'],'Longitude':truth['lng'],'Heading':truth['heading'],'Remaining':truth['remaining'],'SpeedLimit':truth['speed_limit'],'LightDistance':min(6553.5,truth.get('light_distance',6553.5)),'RedLight':int(truth.get('red_light',False)),'LaneIndex':truth['lane_index'],'Sequence':seq}]]}
    if role=='bms':
        soc=truth['charge_pct']
        return {'can':[[272,{'Charge':soc,'Energy':truth['energy_wh'],'Power':truth['power_w'],'Consumed':max(0,truth['consumed_wh']),'Regenerated':max(0,truth['regenerated_wh']),'PropulsionLimit':min(1,max(0,soc/5)),'LowBattery':int(soc<10),'Sequence':seq}]]}
    if role=='navigation':
        lane=ctx.get('lane_request',0)
        if not lane:
            offset=truth.get('route_lane_offset',0)
            lane=1 if offset>0 else -1 if offset<0 else 0
        return {'intent':{'version':1,'sequence':seq,'target_speed':min(profile['max_speed'],truth['speed_limit']),'lane_request':lane,'remaining':truth['remaining']}}
    if role=='controller':
        sensors=frame(ctx,256)
        net=ctx['network']
        target=0.0
        lane=0
        if sensors and net.get('available') and net.get('intent_age',999)<=0.2:
            target=min(net.get('intent',{}).get('target_speed',0),sensors['SpeedLimit'],profile['max_speed'])
            stopping=max(0,sensors['Remaining']-2)
            if sensors['RedLight']: stopping=min(stopping,max(0,sensors['LightDistance']-3))
            # A conservative envelope leaves room for the proportional controller's lag.
            target=min(target,math.sqrt(profile['normal_decel']*stopping))
            lane=net.get('intent',{}).get('lane_request',0)
        speed=sensors['Speed'] if sensors else 0
        error=target-speed
        accel=min(profile['max_accel'],max(0,error*1.5))
        decel=min(profile['normal_decel'],max(0,-error*1.5))
        if target<=.01:accel=0;decel=profile['normal_decel']
        if not sensors or net.get('intent_age',999)>0.2 or not net.get('available'): accel=0;decel=profile['normal_decel']
        return {'can':[[512,{'Acceleration':accel,'Deceleration':decel,'LaneRequest':lane,'TargetSpeed':target,'Sequence':seq}]]}
    commands=frame(ctx,512)
    if role=='powertrain':
        battery=frame(ctx,272)
        limit=battery['PropulsionLimit'] if battery else 0
        return {'can':[[528,{'Acceleration':commands['Acceleration']*limit if commands else 0,'Sequence':seq}]]}
    if role=='brake':
        return {'can':[[544,{'Deceleration':commands['Deceleration'] if commands else profile['normal_decel'],'Sequence':seq}]]}
    if role=='lane':
        return {'can':[[560,{'LaneRequest':commands['LaneRequest'] if commands else 0,'Sequence':seq}]]}
    raise ValueError(f'Unknown role {role}')

def main():
    role=os.environ['ROLE']
    for line in sys.stdin:
        try: print(json.dumps(compute(role,json.loads(line))),flush=True)
        except Exception as exc: print(json.dumps({'error':str(exc)}),flush=True)

if __name__=='__main__': main()
