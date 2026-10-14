"""SUMO backend; no controller logic or actuator bypass belongs here."""
import math
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Protocol
import traci
import sumolib

ENERGY_PARAMETERS={'frontSurfaceArea':2.3,'airDragCoefficient':0.29,'rotatingMass':40,'radialDragCoefficient':0.1,'rollDragCoefficient':0.01,'constantPowerIntake':700,'propulsionEfficiency':0.9,'recuperationEfficiency':0.6}

class SimulatorBackend(Protocol):
    def capabilities(self)->dict: ...
    def load_world(self,route:dict,vehicle:dict,seed:int)->None: ...
    def validate_route(self,route:dict)->bool: ...
    def spawn(self)->None: ...
    def apply_actuators(self,network:dict)->None: ...
    def advance(self,network:dict)->tuple[dict,list]: ...
    def state(self)->dict: ...
    def shutdown(self)->None: ...

class SumoBackend:
    def __init__(self):self.conn=None;self.last={};self.events=[]
    def capabilities(self):return {'backend':'sumo','lane_control':True,'steering_dynamics':False,'battery':True,'step_seconds':0.05}
    def validate_route(self,route):return Path(route['network']).is_file() and bool(route['edges'])
    def load_world(self,route,vehicle,seed):
        self.shutdown()
        if not self.validate_route(route):raise ValueError('Invalid route snapshot')
        self.route=route;self.vehicle=vehicle;self.elapsed=0;self.consumed=0;self.regenerated=0;self.previous_energy=vehicle['capacity_wh']*vehicle['charge_pct']/100;self.last_lane_sequence=None;self.events=[]
        root=ET.Element('routes')
        typ=ET.SubElement(root,'vType',id='passenger-ev',vClass='passenger',length=str(vehicle['length']),width=str(vehicle['width']),mass=str(vehicle['mass']),accel=str(vehicle['max_accel']),decel=str(vehicle['normal_decel']),emergencyDecel=str(vehicle['emergency_decel']),maxSpeed=str(vehicle['max_speed']),sigma='0',emissionClass='Energy/unknown')
        params=dict(ENERGY_PARAMETERS,**{'has.battery.device':'true','maximumBatteryCapacity':vehicle['capacity_wh'],'vehicleMass':vehicle['mass'],'internalMomentOfInertia':40})
        for k,v in params.items():ET.SubElement(typ,'param',key=k,value=str(v))
        ET.SubElement(root,'route',id='journey',edges=' '.join(route['edges']))
        net=sumolib.net.readNet(route['network'])
        arrival=min(net.getEdge(route['edges'][-1]).getLength(),route['end_offset']+10)
        car=ET.SubElement(root,'vehicle',id='ego',type='passenger-ev',route='journey',depart='0',departPos=str(route.get('start_offset',0)),departSpeed='0',arrivalPos=str(arrival))
        ET.SubElement(car,'param',key='actualBatteryCapacity',value=str(self.previous_energy))
        routefile=Path('/data/active.rou.xml');ET.ElementTree(root).write(routefile)
        self.conn=traci.connect(port=self._start(route['network'],routefile,seed),host='127.0.0.1',numRetries=20)
        self.spawn()
    def _start(self,net,routefile,seed):
        import socket,subprocess
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        self.process=subprocess.Popen(['sumo','-n',net,'-r',str(routefile),'--step-length','0.05','--seed',str(seed),'--remote-port',str(port),'--no-step-log','true','--time-to-teleport','-1','--collision.action','warn','--no-warnings','true'])
        return port
    def spawn(self):
        self.conn.simulationStep()
        # 96 disables all automatic speed/right-of-way/red-light limits, including inverted bits 5/6.
        self.conn.vehicle.setSpeedMode('ego',96)
        self.conn.vehicle.setLaneChangeMode('ego',0)
        self.net=sumolib.net.readNet(self.route['network'])
        self.last=self._read()
    @staticmethod
    def _frame(network,mid):
        f=network.get('frames',{}).get(str(mid),{})
        return f.get('signals',{}) if f.get('age',999)<=0.2 else {}
    def apply_actuators(self,network):
        v=self.conn.vehicle
        propulsion=self._frame(network,528);braking=self._frame(network,544);lane=self._frame(network,560)
        acceleration=max(0,min(self.vehicle['max_accel'],propulsion.get('Acceleration',0)))
        deceleration=max(0,min(self.vehicle['emergency_decel'],braking.get('Deceleration',0)))
        if self.last['energy_wh']<=0:acceleration=0
        speed=max(0,v.getSpeed('ego')+(acceleration-deceleration)*.05)
        v.setSpeed('ego',speed)
        if lane.get('LaneRequest') and lane.get('Sequence')!=self.last_lane_sequence:
            self.last_lane_sequence=lane.get('Sequence');target=v.getLaneIndex('ego')+lane['LaneRequest'];edge=v.getRoadID('ego')
            if not edge.startswith(':') and 0<=target<self.conn.edge.getLaneNumber(edge):v.changeLane('ego',target,.1)
            else:self.events.append({'kind':'lane_rejected','reason':'No adjacent lane','module':'plant','protocol':'SIM','sim_time':self.elapsed,'monotonic_ns':time.monotonic_ns()})
    def advance(self,network):
        if not self.conn:raise RuntimeError('No world loaded')
        if self.last.get('arrived'):return self.last,[]
        self.apply_actuators(network);self.conn.simulationStep();self.elapsed=round(self.elapsed+.05,6)
        if 'ego' not in self.conn.vehicle.getIDList():
            raise RuntimeError('Vehicle exited the route before a verified destination stop; simulator removal is not a successful arrival')
        else:
            self.last=self._read()
            if self.last['remaining']<=2 and self.last['speed']<=.001:
                self.last['arrived']=True
        if self.conn.simulation.getCollidingVehiclesIDList():self.events.append({'module':'plant','protocol':'SIM','kind':'collision','sim_time':self.elapsed,'monotonic_ns':time.monotonic_ns()})
        events=self.events;self.events=[]
        return self.last,events
    def _battery(self,name,legacy,default):
        for key in (name,legacy):
            try:
                value=self.conn.vehicle.getParameter('ego','device.battery.'+key)
                if value:return float(value)
            except traci.TraCIException:pass
        return default
    def _route_lane_offset(self):
        # Route connectivity is navigation input; only the lane ECU moves the car.
        lane_id=self.conn.vehicle.getLaneID('ego')
        if lane_id.startswith(':'):return 0
        for lane in self.conn.vehicle.getBestLanes('ego'):
            if lane[0]==lane_id:return lane[3]
        return 0
    def _read(self):
        v=self.conn.vehicle;x,y=v.getPosition('ego');lng,lat=self.conn.simulation.convertGeo(x,y)
        energy=max(0,min(self.vehicle['capacity_wh'],self._battery('actualBatteryCapacity','actualBatteryCapacity',self.previous_energy)))
        # Older SUMO calls the capacity parameter maximumBatteryCapacity.
        delta=self.previous_energy-energy;self.previous_energy=energy
        self.consumed+=max(0,delta);self.regenerated+=max(0,-delta)
        remaining=v.getDrivingDistance('ego',self.route['edges'][-1],self.route['end_offset'])
        if remaining<0:remaining=0
        lights=v.getNextTLS('ego');red=False;distance=6553.5
        if lights:distance=max(0,lights[0][2]);red=lights[0][3].lower() in ('r','y')
        # getAllowedSpeed includes the driver's speed factor and the vehicle cap.
        # Report the road limit; navigation/controller apply the vehicle cap separately.
        speed_limit=self.conn.lane.getMaxSpeed(v.getLaneID('ego'))
        return {'time':self.elapsed,'lat':lat,'lng':lng,'heading':v.getAngle('ego'),'speed':v.getSpeed('ego'),'acceleration':v.getAcceleration('ego'),'lane_index':v.getLaneIndex('ego'),'route_lane_offset':self._route_lane_offset(),'remaining':max(0,remaining),'distance':self.route['distance'],'progress':max(0,min(1,1-max(0,remaining)/self.route['distance'])),'speed_limit':speed_limit,'light_distance':distance,'red_light':red,'charge_pct':energy/self.vehicle['capacity_wh']*100,'energy_wh':energy,'power_w':delta*3600/.05,'consumed_wh':self.consumed,'regenerated_wh':self.regenerated,'arrived':False}
    def state(self):return self.last
    def shutdown(self):
        if self.conn:
            try:self.conn.close()
            except Exception:pass
            self.conn=None
        if hasattr(self,'process') and self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=3)
            except Exception:self.process.kill()
