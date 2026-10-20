"""CARLA plant adapter. Longitudinal commands come only from the vehicle CAN bus.

CARLA supplies physics, scenery, cameras and actors. The energy estimate is an
explicit vehicle model; CARLA does not simulate an EV traction battery.
"""
import io
import math
import multiprocessing
import os
from pathlib import Path
import random
import socket
import struct
import threading
import time

from PIL import Image

CAMERA_ROOT = Path('/data/carla')


class CarlaRemoteBackend:
    """Bridge the native plant to the host-network client without forwarding RPC."""
    def __init__(self):
        import httpx
        self.http = httpx.Client(transport=httpx.HTTPTransport(uds='/data/carla-service.sock'), timeout=600)
        self.last = {}

    def _request(self, path, data=None):
        response = self.http.request('GET' if data is None else 'POST', 'http://carla' + path, json=data)
        if response.is_error:
            raise RuntimeError(response.json().get('detail', response.text))
        return response.json()

    @property
    def info(self):
        return self._request('/status')

    def load_world(self, route, vehicle, seed, run_id):
        self.last = self._request('/load', dict(route=route, vehicle=vehicle, seed=seed, run_id=run_id))

    def advance(self, network):
        result = self._request('/tick', network)
        self.last = result['state']
        return self.last, result['events']

    def state(self):
        return self.last

    def shutdown(self):
        self._request('/shutdown', {})

    def close(self):
        self.http.close()


class _Progress(dict):
    def __init__(self, queue, value):
        super().__init__(value)
        self.queue = queue
        self.queue.put(dict(self))

    def update(self, *args, **kwargs):
        super().update(*args, **kwargs)
        self.queue.put(dict(self))

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.queue.put(dict(self))


def _carla_process(connection, progress):
    backend = CarlaBackend()
    backend.info = _Progress(progress, backend.info)
    try:
        while True:
            method, args = connection.recv()
            try:
                value = getattr(backend, method)(*args)
                connection.send((True, value))
            except Exception as exc:
                backend.info.update(status='failed', error=str(exc))
                connection.send((False, f'{type(exc).__name__}: {exc}'))
    except EOFError:
        backend.shutdown()


class CarlaProcessBackend:
    """Keep CARLA extension calls outside the HTTP/native-adapter process GIL."""
    def __init__(self):
        context = multiprocessing.get_context('spawn')
        self.connection, child = context.Pipe()
        self.progress = context.Queue()
        self.process = context.Process(target=_carla_process, args=(child, self.progress), daemon=True)
        self.process.start()
        child.close()
        self.last = {}
        self._info = {'backend': 'carla', 'status': 'connecting', 'renderer': os.getenv('CARLA_RENDERER', 'software')}

    @property
    def info(self):
        import queue
        while True:
            try:self._info.update(self.progress.get_nowait())
            except queue.Empty:break
        return dict(self._info)

    def _call(self, method, *args):
        if not self.process.is_alive():
            raise RuntimeError('CARLA client process exited')
        self.connection.send((method, args))
        if not self.connection.poll(580 if method == 'load_world' else 130):
            self._info.update(status='failed', error=f'CARLA {method} timed out')
            self.process.terminate()
            raise RuntimeError(self._info['error'])
        ok, result = self.connection.recv()
        if not ok:
            raise RuntimeError(result)
        return result

    def load_world(self, *args):
        self._call('load_world', *args)
        self.last = self._call('state')

    def advance(self, network):
        self.last, events = self._call('advance', network)
        return self.last, events

    def state(self):
        return self.last

    def shutdown(self):
        if self.process.is_alive():self._call('shutdown')

    def close(self):
        if self.process.is_alive():self.process.terminate()
        self.process.join(timeout=5)
        self.connection.close()


def server_host():
    if os.getenv('CARLA_HOST'):
        return os.environ['CARLA_HOST']
    # The Linux Docker host runs CARLA with --net=host. Its bridge gateway is
    # reachable by the plant even when Desktop's Windows host forwarding is off.
    for line in Path('/proc/net/route').read_text().splitlines()[1:]:
        fields = line.split()
        if fields[1] == '00000000':
            return socket.inet_ntoa(struct.pack('<I', int(fields[2], 16)))
    return '127.0.0.1'


def wait_for_server(host, port, timeout=120):
    """The Windows launcher starts an idle server only when a drive needs it."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(f'CARLA server did not start at {host}:{port} within {timeout} seconds')
        try:
            with socket.create_connection((host, port), timeout=min(1, remaining)):
                return
        except OSError:
            time.sleep(min(.5, max(0, deadline - time.monotonic())))


def city_route():
    return {'id': 'carla-city', 'backend': 'carla', 'name': 'CARLA · City with pedestrians',
            'world': 'Town10HD_Opt', 'distance': 500.0, 'geometry': [],
            'start': {'lat': 0, 'lng': 0}, 'destination': {'lat': 0, 'lng': 0},
            'attribution': 'CARLA Simulator · Town10HD · simulated city',
            'scenario': {'pedestrians': 48, 'traffic_vehicles': 8, 'speed_limit': 6.94}}


def fresh_signals(network, mid):
    item = network.get('frames', {}).get(str(mid), {})
    return item.get('signals', {}) if item.get('age', 999) <= .2 else {}


def energy_step(vehicle, speed, acceleration, dt):
    force = vehicle['mass'] * acceleration + vehicle['mass'] * 9.81 * .01 + .5 * 1.225 * .29 * 2.3 * speed ** 2
    mechanical = force * speed
    power = 700 + (mechanical / .9 if mechanical >= 0 else mechanical * .6)
    return power, power * dt / 3600


def camera_path(run_id):
    import uuid
    return CAMERA_ROOT / str(uuid.UUID(run_id))


def remove_camera_recording(run_id):
    import shutil
    try:path = camera_path(run_id)
    except ValueError:return
    if path.is_dir():shutil.rmtree(path)


class CarlaBackend:
    def __init__(self):
        self.world = None
        self.actors = []
        self.controllers = []
        self.cameras = []
        self.last = {}
        renderer = os.getenv('CARLA_RENDERER', 'software')
        self.info = {'backend': 'carla', 'status': 'idle', 'renderer': renderer,
                     'notice': 'CPU Vulkan rendering is slower than wall time.' if renderer == 'software' else 'Native CARLA graphics · live simulated cameras and actors.'}
        self.camera_lock = threading.Lock()
        self.image_captures = None

    def capabilities(self):
        return {'backend': 'carla', 'lane_control': True, 'steering_dynamics': True,
                'battery': 'estimated EV energy model', 'step_seconds': .05, 'cameras': ['driver', 'chase']}

    def validate_route(self, route):
        return route.get('backend') == 'carla' and route.get('world') == 'Town10HD_Opt'

    def load_world(self, route, vehicle, seed, run_id):
        import carla
        self.shutdown()
        if not self.validate_route(route):
            raise ValueError('Unsupported CARLA city route')
        self.info.update(status='connecting', error=None)
        self.vehicle_profile = vehicle
        self.rng = random.Random(seed)
        self.elapsed = 0
        self.travelled = 0
        self.route_index = 0
        self.consumed = self.regenerated = 0
        self.energy = vehicle['capacity_wh'] * vehicle['charge_pct'] / 100
        self.previous_speed = 0
        self.events = []
        self.frame_dir = camera_path(run_id)
        self.frame_dir.mkdir(parents=True, exist_ok=True)
        host, port = server_host(), int(os.getenv('CARLA_PORT', '2000'))
        wait_for_server(host, port)
        self.client = carla.Client(host, port)
        self.client.set_timeout(120)
        self.world = self.client.get_world()
        self.info['status'] = 'loading-map'
        self.map = self.world.get_map()
        if not self.map.name.endswith(route['world']):
            self.world = self.client.load_world(route['world'])
            self.map = self.world.get_map()
        self.original_settings = self.world.get_settings()
        settings = self.world.get_settings()
        settings.synchronous_mode = True
        settings.fixed_delta_seconds = .05
        settings.no_rendering_mode = True
        self.world.apply_settings(settings)
        self.world.set_pedestrians_seed(seed)
        self.world.set_pedestrians_cross_factor(.35)
        self.world.set_weather(carla.WeatherParameters.ClearNoon)
        self.info['status'] = 'populating'
        library = self.world.get_blueprint_library()
        spawns = self.map.get_spawn_points()
        blueprint = library.find('vehicle.tesla.model3')
        blueprint.set_attribute('role_name', 'sdv-ego')
        self.ego = None
        for transform in spawns:
            self.ego = self.world.try_spawn_actor(blueprint, transform)
            if self.ego:
                break
        if not self.ego:
            raise RuntimeError('No free CARLA vehicle spawn point')
        self.actors.append(self.ego)
        physics = self.ego.get_physics_control()
        physics.mass = vehicle['mass']
        self.ego.apply_physics_control(physics)
        self.world.tick(120)
        waypoint = self.map.get_waypoint(self.ego.get_location())
        self.waypoints = [waypoint]
        for _ in range(int(route['distance'] / 2)):
            following = waypoint.next(2.0)
            if not following:
                break
            waypoint = min(following, key=lambda w: abs((w.transform.rotation.yaw - waypoint.transform.rotation.yaw + 180) % 360 - 180))
            self.waypoints.append(waypoint)
        if len(self.waypoints) < 50:
            raise RuntimeError('CARLA could not prepare a city route')
        self.remaining_distances = [0.0] * len(self.waypoints)
        for i in range(len(self.waypoints) - 2, -1, -1):
            self.remaining_distances[i] = self.remaining_distances[i + 1] + self.waypoints[i].transform.location.distance(self.waypoints[i + 1].transform.location)
        self.route = dict(route, distance=self.remaining_distances[0])
        self.route['geometry'] = [self._geo(w.transform.location) for w in self.waypoints]
        self.route['start'] = self.route['geometry'][0]
        self.route['destination'] = self.route['geometry'][-1]
        self.route['carla_geometry'] = [self._xy(w.transform.location) for w in self.waypoints]
        # Full lane topology comes from this simulator, without web map tiles.
        self.route['carla_roads'] = [[self._xy(w.transform.location) for w in pair] for pair in self.map.get_topology()]
        center = self.ego.get_location()
        walkers = library.filter('walker.pedestrian.*')
        candidates = []
        for _ in range(300):
            point = self.world.get_random_location_from_navigation()
            if point:
                distance = min(point.distance(w.transform.location) for w in self.waypoints[::8])
                candidates.append((distance, point))
        candidates.sort(key=lambda item: item[0])
        batch = []
        for _, point in candidates[:route['scenario']['pedestrians'] * 2]:
            bp = self.rng.choice(list(walkers))
            if bp.has_attribute('is_invincible'):
                bp.set_attribute('is_invincible', 'false')
            batch.append(carla.command.SpawnActor(bp, carla.Transform(point)))
        pedestrian_ids = []
        for response in self.client.apply_batch_sync(batch, True):
            if not response.error:
                pedestrian_ids.append(response.actor_id)
        self.walkers = list(self.world.get_actors(pedestrian_ids))
        self.actors.extend(self.walkers)
        # Keep the configured crowd bounded; destroy extra successful candidates.
        extra = self.walkers[route['scenario']['pedestrians']:]
        if extra:
            self.client.apply_batch_sync([carla.command.DestroyActor(a.id) for a in extra], True)
            self.walkers = self.walkers[:route['scenario']['pedestrians']]
            self.actors = [a for a in self.actors if a not in extra]
        controller_bp = library.find('controller.ai.walker')
        responses = self.client.apply_batch_sync([carla.command.SpawnActor(controller_bp, carla.Transform(), walker.id) for walker in self.walkers], True)
        self.controllers = list(self.world.get_actors([r.actor_id for r in responses if not r.error]))
        for controller in self.controllers:
            controller.start()
            destination = self.world.get_random_location_from_navigation()
            if destination:
                controller.go_to_location(destination)
            controller.set_max_speed(self.rng.uniform(.8, 1.5))
        self.tm = self.client.get_trafficmanager(8005)
        self.tm.set_synchronous_mode(True)
        self.tm.set_random_device_seed(seed)
        self.tm.global_percentage_speed_difference(55)
        self.traffic = []
        cars = [b for b in library.filter('vehicle.*') if b.has_attribute('number_of_wheels') and b.get_attribute('number_of_wheels').as_int() == 4]
        nearby = sorted(spawns, key=lambda t: t.location.distance(center))
        for transform in nearby:
            if len(self.traffic) >= route['scenario']['traffic_vehicles']:
                break
            if transform.location.distance(center) < 15:
                continue
            bp = self.rng.choice(cars)
            bp.set_attribute('role_name', 'sdv-traffic')
            actor = self.world.try_spawn_actor(bp, transform)
            if actor:
                actor.set_autopilot(True, 8005)
                self.traffic.append(actor)
                self.actors.append(actor)
        collision = self.world.spawn_actor(library.find('sensor.other.collision'), carla.Transform(), attach_to=self.ego)
        collision.listen(lambda event: self.events.append({'kind': 'collision', 'other_actor': event.other_actor.type_id}))
        self.cameras.append(collision)
        # Physics settles without spending time on a software rendered viewport.
        for _ in range(8):
            self.world.tick(120)
        self.origin = self.world.get_snapshot().timestamp.elapsed_seconds
        self.previous_location = self.ego.get_location()
        from .carla_imagery import CameraCaptures
        self.info.update(image_captures=0)
        self.info.pop('similarity_error', None)
        self.image_captures = CameraCaptures(run_id, self.route['distance'], self.info)
        self.image_captures.observe_state(dict(time=0, remaining=self.route['distance'], **self._geo(self.previous_location)))
        for view, transform in [('driver', carla.Transform(carla.Location(x=.35, y=-.32, z=1.35))),
                                ('chase', carla.Transform(carla.Location(x=-7, z=4), carla.Rotation(pitch=-18)))]:
            camera = library.find('sensor.camera.rgb')
            camera.set_attribute('image_size_x', os.getenv('CARLA_CAMERA_WIDTH', '1920'))
            camera.set_attribute('image_size_y', os.getenv('CARLA_CAMERA_HEIGHT', '1080'))
            camera.set_attribute('fov', '95')
            camera.set_attribute('sensor_tick', '.2')
            camera.set_attribute('enable_postprocess_effects', 'false' if self.info['renderer']=='software' else 'true')
            if camera.has_attribute('motion_blur_intensity'):
                camera.set_attribute('motion_blur_intensity', '0')
            sensor = self.world.spawn_actor(camera, transform, attach_to=self.ego)
            (self.frame_dir / view).mkdir(exist_ok=True)
            sensor.listen(lambda image, view=view: self._save_camera(view, image))
            self.cameras.append(sensor)
        settings.no_rendering_mode = False
        self.world.apply_settings(settings)
        self.info.update(status='running', server_version=self.client.get_server_version(), world=self.map.name,
                         pedestrians=len(self.walkers), traffic_vehicles=len(self.traffic), ego_id=self.ego.id,
                         energy_model='Estimated: mass, drag, rolling resistance, 90% propulsion / 60% regeneration')
        self.last = self._read()
        self.image_captures.observe_state(self.last)
        self.last['carla_route'] = self.route

    @staticmethod
    def _xy(location):
        return {'x': round(location.x, 2), 'y': round(location.y, 2)}

    def _geo(self, location):
        geo = self.map.transform_to_geolocation(location)
        return {'lat': geo.latitude, 'lng': geo.longitude}

    def _save_camera(self, view, image):
        try:
            stamp = max(0, round((image.timestamp - self.origin) * 1000))
            picture = Image.frombytes('RGB', (image.width, image.height), image.raw_data, 'raw', 'BGRX')
            data = io.BytesIO()
            picture.save(data, format='JPEG', quality=93, subsampling=0)
            target = self.frame_dir / view / f'{stamp:012d}.jpg'
            with self.camera_lock:
                temporary = target.with_suffix('.tmp')
                temporary.write_bytes(data.getvalue())
                temporary.replace(target)
            if view == 'driver' and self.image_captures:
                self.image_captures.observe_frame(target, stamp / 1000)
        except Exception as exc:
            self.info['camera_error'] = str(exc)

    def apply_actuators(self, network):
        import carla
        propulsion = fresh_signals(network, 528)
        braking = fresh_signals(network, 544)
        lane = fresh_signals(network, 560)
        accel = max(0, min(self.vehicle_profile['max_accel'], propulsion.get('Acceleration', 0))) if self.energy > 0 else 0
        decel = max(0, min(self.vehicle_profile['emergency_decel'], braking.get('Deceleration', self.vehicle_profile['normal_decel'])))
        transform = self.ego.get_transform()
        nearby = range(self.route_index, min(len(self.waypoints), self.route_index + 25))
        self.route_index = min(nearby, key=lambda i: transform.location.distance(self.waypoints[i].transform.location))
        target = self.waypoints[min(self.route_index + max(3, int(self.last.get('speed', 0) * .65)), len(self.waypoints) - 1)].transform.location
        desired = math.atan2(target.y - transform.location.y, target.x - transform.location.x)
        delta = (desired - math.radians(transform.rotation.yaw) + math.pi) % (2 * math.pi) - math.pi
        steer = max(-1, min(1, math.atan2(2 * 2.8 * math.sin(delta), max(3, transform.location.distance(target))) / .65))
        # Lateral route following is the plant's lane actuator, never autopilot
        # on the ego. Longitudinal acceleration/braking remain ECU controlled.
        if lane.get('LaneRequest') and lane.get('Sequence') != getattr(self, 'last_lane_sequence', None):
            self.last_lane_sequence = lane.get('Sequence')
            self.events.append({'kind': 'lane_rejected', 'reason': 'City scenario follows its prepared lane route'})
        throttle = max(0, min(1, accel / 4.0 + (0.09 if accel > 0 else 0)))
        brake = max(0, min(1, decel / self.vehicle_profile['emergency_decel']))
        self.ego.apply_control(carla.VehicleControl(throttle=throttle if brake < .05 else 0, brake=brake, steer=steer))

    def advance(self, network):
        self.apply_actuators(network)
        frame = self.world.tick(120)
        snapshot = self.world.get_snapshot()
        self.elapsed = round(snapshot.timestamp.elapsed_seconds - self.origin, 6)
        self.last = self._read()
        self.image_captures.observe_state(self.last)
        self.last['carla_frame'] = frame
        events, self.events = self.events, []
        events = [dict(event, module='plant', protocol='SIM', sim_time=self.elapsed, monotonic_ns=time.monotonic_ns()) for event in events]
        self.info.update(sim_time=self.elapsed, frame=frame, speed=self.last['speed'])
        return self.last, events

    def _read(self):
        import carla
        transform = self.ego.get_transform()
        velocity = self.ego.get_velocity()
        speed = math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2)
        acceleration = (speed - self.previous_speed) / .05
        self.previous_speed = speed
        self.travelled += transform.location.distance(self.previous_location)
        self.previous_location = transform.location
        power, delta = energy_step(self.vehicle_profile, speed, acceleration, .05)
        self.energy = max(0, min(self.vehicle_profile['capacity_wh'], self.energy - delta))
        self.consumed += max(0, delta)
        self.regenerated += max(0, -delta)
        remaining = self.remaining_distances[self.route_index]
        pedestrian_distance = 6553.5
        obstacle_distance = 6553.5
        forward = transform.get_forward_vector()
        actors = []
        for actor in [*self.walkers, *self.traffic]:
            if not actor.is_alive:
                continue
            location = actor.get_location()
            dx, dy = location.x - transform.location.x, location.y - transform.location.y
            ahead = dx * forward.x + dy * forward.y
            lateral = abs(dx * forward.y - dy * forward.x)
            is_walker = actor.type_id.startswith('walker.')
            if is_walker and ahead > 0 and lateral < 3.0:
                pedestrian_distance = min(pedestrian_distance, max(0, ahead - 2))
            if ahead > 0 and lateral < (3.0 if is_walker else 2.5):
                obstacle_distance = min(obstacle_distance, max(0, ahead - (2 if is_walker else 4.5)))
            actors.append(dict(self._xy(location), id=actor.id, kind='pedestrian' if is_walker else 'vehicle'))
        red = self.ego.is_at_traffic_light() and self.ego.get_traffic_light_state() in (carla.TrafficLightState.Red, carla.TrafficLightState.Yellow)
        wp = self.map.get_waypoint(transform.location)
        return dict(self._geo(transform.location), time=self.elapsed, heading=(transform.rotation.yaw + 90) % 360,
                    speed=speed, acceleration=acceleration, lane_index=max(0, abs(wp.lane_id) - 1), route_lane_offset=0,
                    remaining=remaining, distance=self.route['distance'], progress=max(0, min(1, 1 - remaining / self.route['distance'])),
                    speed_limit=min(self.route['scenario']['speed_limit'], max(1, self.ego.get_speed_limit() / 3.6)),
                    light_distance=6 if red else 6553.5, red_light=red,
                    obstacle_distance=obstacle_distance, pedestrian_hazard=pedestrian_distance < 25,
                    charge_pct=self.energy / self.vehicle_profile['capacity_wh'] * 100, energy_wh=self.energy, power_w=power,
                    consumed_wh=self.consumed, regenerated_wh=self.regenerated, arrived=remaining <= 2 and speed <= .1,
                    backend='carla', carla_x=transform.location.x, carla_y=transform.location.y, carla_yaw=transform.rotation.yaw,
                    carla_actors=actors, pedestrian_count=len(self.walkers), traffic_count=len(self.traffic),
                    energy_model='estimated', carla_frame=self.world.get_snapshot().frame)

    def state(self):
        return self.last

    def shutdown(self):
        if not self.world:
            return
        import carla
        self.info['status'] = 'stopping'
        try:
            for camera in self.cameras:
                if camera.is_alive:
                    camera.stop()
            for controller in self.controllers:
                if controller.is_alive:
                    controller.stop()
            ids = [a.id for a in [*self.cameras, *self.controllers, *self.actors] if a.is_alive]
            if ids:
                self.client.apply_batch_sync([carla.command.DestroyActor(i) for i in ids], True)
        finally:
            if self.image_captures:
                self.image_captures.close()
                self.image_captures = None
            if hasattr(self, 'tm'):
                self.tm.set_synchronous_mode(False)
            if hasattr(self,'original_settings'):self.world.apply_settings(self.original_settings)
            self.world = None
            self.actors = []
            self.cameras = []
            self.controllers = []
            self.info['status'] = 'idle'
