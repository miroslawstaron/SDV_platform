// Build vertical details beneath the existing 19 editable main slides.
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../../',import.meta.url),deck=new URL('../public/presentation/index.html',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const catalog=JSON.parse(await read('contracts/catalog.json'));
const dbc=await read('contracts/vehicle.dbc');
const screenshots=JSON.parse(await read('web/public/presentation/screenshots/provenance.json'));
let html=await readFile(deck,'utf8');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const notes=value=>`<aside class="notes">${escape(value)}</aside>`;
const paragraph=value=>`<p>${value}</p>`;
const list=items=>`<ul class="detail-list">${items.map(item=>`<li>${item}</li>`).join('')}</ul>`;
const table=(headers,rows)=>`<table class="detail-table"><thead><tr>${headers.map(header=>`<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const detail=(title,body,note,caption='')=>`<section class="detail-slide"><h2>${title}</h2>${body}${caption?`<p class="caption">${caption}</p>`:''}${notes(note)}</section>`;
function screenshot(title,name,explanation,caption){
 const source=screenshots.assets[name];if(!source)throw new Error(`Missing screenshot ${name}`);
 const imageNote=source.provider_image_id?(source.backend==='carla'?`CARLA driver frame: ${source.provider_image_id}, at the ${source.station_index*25} m station. Simulated location ${source.lat.toFixed(5)}, ${source.lng.toFixed(5)}. Visual fingerprint: ${source.phash}.`:`Mapillary image: ${source.provider_image_id}. Original capture date: ${source.source_captured_at?new Date(source.source_captured_at).toISOString().slice(0,10):'unknown'}.`):'';
 const sourceNote=[`This screenshot shows ${source.kind}.`,source.run_id?`Recorded drive: ${source.run_id}${source.sample_time!==undefined?`, at ${source.sample_time} seconds`:''}.`:'',imageNote,source.description||'',`Screenshot captured on ${source.captured_on||screenshots.captured_on}. The workflow reads saved state, events and camera frames without server writes. Full source metadata: screenshots/provenance.json. Screenshot file: ${source.file}.`].filter(Boolean).join(' ');
 return detail(title,`<div class="screenshot-layout"><a class="screenshot-link" href="${source.file}" target="_blank" rel="noopener" aria-label="Open full screenshot: ${escape(title)}" data-help="Open this screenshot at its original resolution in a new tab."><img class="slide-screenshot" src="${source.file}" alt="${escape(title)}" loading="eager"></a><div class="screenshot-explanation">${list(explanation)}</div></div>`,
  sourceNote,caption||'Screenshot of the platform UI. Click the image to enlarge it.');
}
const groups=new Map();const add=(chapter,slide)=>{if(!groups.has(chapter))groups.set(chapter,[]);groups.get(chapter).push(slide)};

add(2,screenshot('Engineering dashboard: the test bench','engineering-overview',[
 'Choose the route, set the battery charge and start a drive.',
 'Inspect the control units and their messages, then introduce a fault to see the response.',
 'Replay the recording or export its data for later analysis.',
],'Actual engineering UI showing a saved CARLA city drive.'));
add(2,screenshot('Engineering dashboard: following the drive','engineering-route',[
 'CARLA road topology shows the car and surrounding actors.',
 'The readings show its actual speed, battery charge and journey progress.',
 'View similarity compares the current station’s driver-camera capture.',
 'The speed chart compares actual speed with the sensor’s report.',
]));

const nativeProvenance='Built here as sdv-native:local on Ubuntu 24.04. SIL Kit 5.0.7 carries CAN messages; vSomeIP 3.7.6 provides navigation services. Python runs our vehicle-control code.';
const pythonProvenance='Built here as sdv-python:local on Ubuntu 24.04. Our Python code uses FastAPI 0.115.12 to handle requests and uvicorn 0.34.2 to serve them.';
const containers=[
 ["carla-client", "The simulator SDK bridge", "Built here as sdv-python:local on Ubuntu 24.04. FastAPI 0.115.12 and uvicorn 0.34.2 expose the platform services. The CARLA SDK is 0.9.16.", ["Connects to native CARLA through host.docker.internal.", "Owns cameras, crowd setup, Traffic Manager and synchronous ticks.", "Archives both cameras; samples driver frames for pHash matching."], "python3 -m sdv.carla_service", "backend/sdv/carla_service.py, carla_backend.py, carla_imagery.py. The isolated child process owns the CARLA 0.9.16 SDK. network_mode: host; /data/carla-service.sock links to the plant; /data/carla stores camera frames."],
 ['api','Platform coordinator',pythonProvenance,['Advances the simulation and manages drives, faults and replay.','Sends dashboard updates and answers image-history requests.','Saves images and their visual fingerprints in a database.'], 'uvicorn sdv.api:app','backend/Dockerfile; backend/sdv/api.py; backend/sdv/imagery.py; /data/images.sqlite; Pillow 11.3.0 (MIT-CMU).'],
 ['registry','Communication directory',nativeProvenance,['Helps the vehicle’s message adapters find one another.','Starts the SIL Kit directory on port 8500.','Provides the connection setup for CAN communication.'],'sil-kit-registry','native/Dockerfile; compose.yaml; upstream https://github.com/vectorgrp/sil-kit/releases/tag/v5.0.7.'],
 ["plant", "Applying ECU actions to CARLA", "Built here as sdv-native:local on Ubuntu 24.04. SIL Kit 5.0.7 carries CAN messages; vSomeIP 3.7.6 provides navigation services. Python runs the vehicle-control code.", ["Receives actual propulsion, brake and lane CAN messages.", "Sends actions to the CARLA client and returns physics state.", "Follows prepared waypoints for steering; records rejected lane changes."], "ROLE=plant → sdv.worker", "backend/sdv/worker.py; carla_backend.py CarlaRemoteBackend; native/adapter.cpp; contracts/vehicle.dbc. The SDK runs in carla-client. SUMO remains the legacy backend."],
 ['sensor','Vehicle sensor reports',nativeProvenance,['Reads the car’s actual state from the simulator.','Reports speed, position, road conditions and lane to the controller.','Fault tests can delay, remove, freeze or replace these reports.'],'ROLE=sensor → sdv.application','backend/sdv/application.py (sensor); backend/sdv/worker.py; native/adapter.cpp; contracts/vehicle.dbc; Sensors 0x100.'],
 ['bms','Battery management',nativeProvenance,['Reports battery charge, remaining energy and power use.','Shows a warning below 10% charge and reduces drive power below 5%.','Tracks energy consumed and recovered during the drive.'],'ROLE=bms → sdv.application','backend/sdv/application.py (bms); backend/sdv/worker.py; contracts/vehicle.dbc; Battery 0x110. PropulsionLimit=max(0,min(1,charge/5)).'],
 ['navigation','Route guidance',nativeProvenance,['Reads the prepared route and the car’s current surroundings.','Chooses the desired speed and lane, and reports distance left.','Sends this guidance to the controller through SOME/IP.'],'ROLE=navigation → sdv.application','backend/sdv/application.py (navigation); backend/sdv/worker.py; contracts/catalog.json; vSomeIP 3.7.6; service 0x1234/event 0x8001.'],
 ['controller','Driving decisions',nativeProvenance,['Combines route guidance with sensor and battery reports.','Decides how much to accelerate, brake or change lane.','Requests a stop when essential input is more than 200 ms old.'],'ROLE=controller → sdv.application','backend/sdv/application.py (controller); Commands 0x200. CONTROLLER_COMMAND can replace its application. Python/C++ examples: examples/python/controller.py and examples/cpp/controller.cpp.'],
 ['powertrain','Applying drive power',nativeProvenance,['Reads the controller’s acceleration request.','Reduces that request when the battery limits drive power.','Sends the permitted acceleration to the simulator.'],'ROLE=powertrain → sdv.application','backend/sdv/application.py (powertrain); contracts/vehicle.dbc; inputs Commands 0x200/Battery 0x110; output Propulsion 0x210. Missing battery or stale commands reduce positive propulsion to zero.'],
 ['brake','Applying the brakes',nativeProvenance,['Reads how strongly the controller wants to slow down.','Sends the braking action to the simulator.','Requests normal braking if controller commands stop arriving.'],'ROLE=brake → sdv.application','backend/sdv/application.py (brake); contracts/vehicle.dbc; Commands 0x200/Braking 0x220. A failed brake application cannot be assumed to provide its watchdog response.'],
 ["lane", "Observing lane requests", "Built here as sdv-native:local on Ubuntu 24.04. SIL Kit 5.0.7 carries CAN messages; vSomeIP 3.7.6 provides navigation services. Python runs the vehicle-control code.", ["Receives the controller’s requested lane action.", "Sends the action over CAN to the plant.", "The city preset follows its prepared lane and records manual requests as rejected."], "ROLE=lane → sdv.application", "backend/sdv/application.py; carla_backend.py apply_actuators; contracts/vehicle.dbc, LaneAction 0x230. CARLA uses continuous waypoint steering; manual lane changes are not implemented in this preset."],
 ['recorder','Saving the experiment',pythonProvenance,['Saves the drive settings, actual vehicle state and message history.','Records each message being sent and each receiver seeing it.','Provides the recording used for replay and downloadable exports.'],'uvicorn sdv.recorder:app','backend/sdv/recorder.py; /data/recordings.sqlite on the persistent sdv-data volume. Python standard-library SQLite and CSV/JSON serialization.'],
 ["maps", "Retained route service", "Built here as sdv-python:local on Ubuntu 24.04. FastAPI 0.115.12 and uvicorn 0.34.2 expose the platform services. The CARLA SDK is 0.9.16.", ["Keeps previously prepared SUMO routes available.", "Supports map-pin route preparation in legacy SUMO mode.", "The current CARLA preset gets roads and waypoints directly from CARLA."], "uvicorn sdv.maps:app", "backend/sdv/maps.py; SIMULATOR_BACKEND=sumo enables legacy route creation. Default CARLA routes are supplied by api.py city_route and carla_backend.py."],
 ['kuksa','Standard vehicle-signal store','The original KUKSA databroker 0.7.1 image is used unchanged (Apache-2.0). Signal names come from COVESA’s Vehicle Signal Specification, VSS 6.1 (MPL-2.0).', ['Makes reported values available under standard Vehicle.* names.','Receives speed, position and battery updates from our gateway.','Lets other software read these values through a common interface.'],'kuksa-databroker --vss /contracts/vss.json','compose.yaml; contracts/vss.json; backend/dependencies.json. Local configuration uses --insecure. Upstream: https://github.com/eclipse-kuksa/kuksa-databroker and https://github.com/COVESA/vehicle_signal_specification.'],
 ['gateway','Translating vehicle signals',pythonProvenance,['Reads the values reported by the vehicle’s control units.','Copies speed, position and battery readings into KUKSA.','Converts speed to km/h and remaining energy to kWh.'],'python3 -m sdv.gateway','backend/sdv/gateway.py; kuksa-client 0.4.3 (Apache-2.0); broker port 55555; 200 ms publishing loop. It mirrors ECU reports, not independent ground truth.'],
 ['instruments','The driver’s instrument panel','Built here as sdv-instruments:local. nginx 1.27 Alpine serves our display’s HTML, CSS and JavaScript; nginx uses the BSD-2-Clause license.', ['Reads the selected drive’s actual state directly from the platform.','Shows speed, battery, journey progress and similarity warnings.','Works inside the driver window or separately on port 8081.'],'nginx → instruments/public/','instruments/Dockerfile; instruments/nginx.conf; instruments/public/dashboard.js; instruments/manifest.json; original user-supplied Metriczone logo.'],
 ["web", "Dashboards, portal and presentation", "React 19.1.0 builds with Node 22 and nginx 1.27 serves the app. reveal.js 6.0.2 displays this deck. Leaflet and MapillaryJS remain for legacy recordings.", ["Provides engineering, driver, CARLA portal and similarity views.", "Shows 1080p camera images with full-screen controls.", "Proxies API and independent instruments and serves the deck locally."], "nginx → web/dist/", "web/Dockerfile; web/nginx.conf; web/src/CarlaView.tsx; web/public/presentation; THIRD_PARTY_NOTICES.md. Node is a build dependency."],
];
for(const [name,title,provenance,content,entry,source] of containers){
 add(3,detail(`Container: ${name} · ${title}`,`<div class="two-columns"><div><h3>What it does</h3>${list(content)}<p class="entrypoint"><code>${escape(entry)}</code></p></div><div><h3>Where its software comes from</h3><p>${escape(provenance)}</p></div></div>`,`${source} Container definition: compose.yaml. Exact built image IDs, pinned base digests and package versions: dependencies.lock.json. Local application and native adapter code are platform-owned reference implementations, not upstream ECU products. SIL Kit uses MIT and vSomeIP MPL-2.0. The shared native image includes gRPC/protobuf and the local message adapter.`, 'Each service runs independently, even when several services use the same base image.'));
}

add(3,detail('Native CARLA server on Windows',`<div class="two-columns"><div><h3>Physics and rendering</h3>${list(['Official CARLA 0.9.16 Windows release.','Vulkan on the NVIDIA RTX 4090.','Hidden windowed surface, Epic quality and sound disabled.'])}</div><div><h3>How SDV connects</h3>${list(['Docker’s SDK client reaches host.docker.internal.','RPC uses port 2000; camera streaming uses 2001.','The launcher starts the server; Stop-Sdv stops its owned process.'])}</div></div>`, 'Source: scripts/Start-Carla.ps1 and docs/carla.md. Installed at %LOCALAPPDATA%/SDV/CARLA/0.9.16. The first official archive download is approximately 7.3 GiB and resumes if interrupted. The launcher prepares signed legacy Microsoft dependency DLLs beside the executable. Launch flags include -windowed -nosound -quality-level=Epic -ResX=640 -ResY=360 -vulkan -preferNvidia. The 640x360 viewport is separate from the 1920x1080 camera sensors.', 'This server runs natively on Windows. The SDV services and Python client run in Docker.'));
add(3,detail('Optional Docker server on a compatible GPU host',table(['Setting','Purpose'],[
 ['carlasim/carla:0.9.16','Official server image'],['NVIDIA runtime and visible devices = all','Expose the GPU'],['NVIDIA driver capabilities = all','Include graphics and Vulkan libraries'],['Host networking','Expose server ports without port mapping'],['-RenderOffScreen -nosound','Render cameras without a display or sound'],
]), 'Source: compose.yaml, docs/carla.md and the CARLA Docker documentation. COMPOSE_PROFILES=carla-docker, CARLA_RUNTIME=docker and CARLA_HOST=127.0.0.1 select this path. On this Windows Docker Desktop machine the stock image used software Vulkan; the active setup uses native Windows Vulkan. Windows native Vulkan requires a window surface and does not use -RenderOffScreen. Official documentation: https://carla.readthedocs.io/en/0.9.16/build_docker/.', 'The current machine uses the native Windows server described on the preceding slide.'));

const frames=new Map();
for(const match of dbc.matchAll(/BO_\s+(\d+)\s+(\w+):\s+(\d+)\s+(\w+)\r?\n([\s\S]*?)(?=\r?\nBO_|$)/g)){
 const rows=[...match[5].matchAll(/SG_\s+(\w+)\s*:\s*[^\n]*?"([^"]*)"\s*([^\r\n]*)/g)].map(signal=>[signal[1],signal[2]||'unitless',signal[3].trim()]);
 frames.set(Number(match[1]),{name:match[2],bytes:match[3],producer:match[4],rows});
}
const signalMeanings={Speed:'Reported vehicle speed',Latitude:'North–south location',Longitude:'East–west location',Heading:'Direction of travel',Remaining:'Distance left on the route',SpeedLimit:'Current road’s speed limit',LightDistance:'Distance to the traffic light',RedLight:'Whether the traffic light is red',LaneIndex:'Current lane number',Sequence:'Update counter: identifies successive messages',Charge:'Battery charge remaining',Energy:'Electrical energy remaining',Power:'Current battery power use',Consumed:'Energy used during this drive',Regenerated:'Energy recovered during this drive',PropulsionLimit:'Allowed fraction of drive power (0–1)',LowBattery:'Whether charge is below 10%',Acceleration:'How quickly to increase speed',Deceleration:'How quickly to reduce speed',LaneRequest:'Right (−1), no change (0) or left (+1)',TargetSpeed:'Desired vehicle speed',ObstacleDistance:'Distance to an actor in the driving corridor',PedestrianHazard:'Walker ahead within the hazard distance'};
function signalSlide(id,offset,count,title='',explanation=''){
 const frame=frames.get(id),binding=`0x${id.toString(16)}`;
 const recipients=catalog.messages.find(m=>m.id===id).consumers.join(', ');
 return detail(title,table(['Signal and unit','What it means','Receiver'],frame.rows.slice(offset,offset+count).map(([name,unit,receiver])=>[`${name}${unit==='unitless'?'':` (${unit})`}`,signalMeanings[name]||name,receiver.replaceAll(',',', ')])).replace('detail-table','detail-table signal-table'),
  `Exact field names and receivers from contracts/vehicle.dbc, frame ${binding} ${frame.name} (${frame.bytes} bytes); message-level intended consumers from contracts/catalog.json; applied behavior from backend/sdv/application.py and backend/sdv/simulator.py. CAN is broadcast, so other adapters may also record receptions. All six CAN messages are produced every 50 ms. Sequence is a uint16 counter. ${explanation}`,
  `${frame.name} ${binding} · ${frame.producer} → ${recipients} · ${explanation||'20 updates per second; inputs older than 200 ms trigger a fallback.'}`);
}
add(4,signalSlide(256,0,4,'Sensor feedback: speed and position'));
add(4,signalSlide(256,4,6,'Sensor feedback: road and journey'));
add(4,signalSlide(256,10,2,'Sensor feedback: people and obstacles','CARLA actor proximity supplies these signals; camera perception is not implemented.'));
add(4,signalSlide(272,0,5,'Battery feedback: charge and energy'));
add(4,signalSlide(272,5,3,'Battery feedback: limits and warnings'));
add(4,signalSlide(512,0,5,'Controller requests: how the car should move','Receiver names follow the DBC message definition. The simulator moves the car using the applied actions below.'));
add(4,signalSlide(528,0,2,'Drive power: acceleration actually applied','The battery limit scales the controller’s request. Missing battery feedback prevents acceleration.'));
add(4,signalSlide(544,0,2,'Brakes: slowing the car down','A working brake unit requests normal braking when controller commands stop arriving.'));
add(4,signalSlide(560,0,2,'Lane actions: requested and observed','The CARLA city preset rejects manual lane changes and follows its prepared lane.'));
add(4,detail('Route guidance: what navigation sends',table(['Message field','What it means'],[
 ['version','Message format version (currently 1)'],['sequence','Update counter: identifies successive messages'],['target_speed','Desired speed, in metres per second'],['lane_request','Right (−1), no change (0) or left (+1)'],['remaining','Distance left on the route, in metres'],
]), 'Source: contracts/catalog.json, backend/sdv/application.py and native/adapter.cpp. Service 0x1234, instance 0x0001, event 0x8001, event group 0x0001; GetIntent method 0x0001. JSON UTF-8 serialization. Data transport: UDP 30509; service discovery multicast 224.224.224.245:30490; sequence is uint16.', 'navigation → controller via SOME/IP · service 0x1234, event 0x8001 · Guidance older than 200 ms triggers a stop request.'));

add(6,screenshot('Driver example: instruments and CARLA camera','driver-view',[
 'Independent instruments show recorded vehicle state and EV estimates.', 'The first-person image comes from the same CARLA drive.', 'Image similarity appears below the speedometer.',
],'Actual CARLA replay with a 1920 × 1080 source camera.'));
add(6,screenshot('Driver example: vehicle instruments','driver-instruments',[
 'Speed comes from CARLA physics; battery energy uses the EV estimate.', 'Similarity shows the nearest match and the number of similar captures.', 'Replay aligns the readings with the chosen simulation time.',
]));
add(6,screenshot('CARLA portal: the car and the city','carla-portal',[
 'The chase camera shows the car from behind.', 'The map follows the ego car, walking pedestrians and surrounding vehicles.', 'Start a city drive or inspect a saved recording.',
]));
add(7,screenshot('First-person camera: a simulated city','imagery-example',[
 '1920 × 1080 camera sensors, high-quality JPEG and motion blur disabled.', 'Full screen enlarges the camera.', 'Frame time shows when CARLA rendered this image.',
],'CARLA renders the same city whose physics and actors drive the SDV state.'));
const image=screenshots.assets['image-provenance'];
add(7,detail('Capture provenance: the source camera frame',`<div class="two-columns"><div><h3>Frame source</h3>${list([`Frame ID: <code>${escape(image.provider_image_id)}</code>.`,`Simulation time: ${image.sample_time.toFixed(2)} seconds.`,`Source: CARLA driver camera.`])}</div><div><h3>Capture observation</h3>${list([`Drive ${escape(image.run_id.slice(0,8))}, ${image.station_index*25} m station.`,`pHash: <code>${escape(image.phash)}</code>.`,'The gallery identifies a simulated scene and its location.'])}</div></div>`, 'Metadata comes from screenshots/provenance.json and the capture database. CARLA frame IDs encode the view and simulation-relative milliseconds. CARLA geolocation is simulator map output. No external photo date is invented. Sources: carla_backend.py, carla_imagery.py, imagery.py and SimilarityDashboard.tsx.', 'Images and observations remain separate: repeated zero-distance pHash matches share an archived image.'));
add(7,detail('From asynchronous cameras to one observation',list([
 'Both cameras request a frame every 0.2 simulated seconds.', 'The service saves each JPEG with a simulation-relative filename.', 'It pairs driver frames with past vehicle telemetry.', 'The first eligible frame at each 25 m station enters the pHash library.', 'Hashing runs off-thread; retries can recover a failed capture.',
]), 'Sources: CameraCaptures in carla_imagery.py and CarlaBackend._save_camera in carla_backend.py. Repeated browser windows, chase frames and replay never create extra observations. The browser polls the shared comparison endpoint for the current station.', 'Capture and comparisons work even with every browser closed.'));

add(8,screenshot('Similarity dashboard: browsing saved drives','similarity-dashboard',[
 'Choose one drive or browse images from all drives.', 'Click a capture to inspect its pHash, CARLA frame ID and location.', 'The comparison list searches all drives, including those hidden by your filter.',
]));
add(8,screenshot('Similarity example: exact repeats across drives','similarity-exact',[
 '100% means identical pHashes. Same stored image means observations share an archived file.', 'A new drive or station counts as another observation, even when its image is shared.', 'Lower scores help you inspect views that did not qualify as matches.', 'Matching only keeps scores of 87.5% or higher.',
],'Saved comparisons across drives. The selected capture is not compared with itself.'));
const warning=screenshots.assets['driver-similarity-warning'];
if(warning)add(10,screenshot('Similarity warning on the driver’s dashboard','driver-similarity-warning',[
 'View similarity appears in the instruments, engineering dashboard and CARLA portal.', 'At least five other matching captures show “Drive to another place.”', 'The warning clears when the next view has fewer than five matches.',
],'Actual database comparisons supply the warning in this saved CARLA drive.'));

add(12,screenshot('Normal drive: actual and reported speed','truth-normal',[
 'The teal line shows actual speed calculated by the simulator.', 'The orange line shows the speed sent by the sensor unit.', 'Use this normal drive as a baseline before introducing faults.',
]));
add(12,screenshot('Sensor fault: a false speed report','truth-substituted',[
 'This test makes the sensor report 80 m/s (288 km/h).', 'The car’s actual speed remains visible in the teal line.', 'The orange line and message values show what the controller was told.',
],'Historical SUMO recording: the same fault-injection and signal contracts remain available with CARLA.'));
add(13,screenshot('Fault example: configuring sensor substitution','fault-configuration',[
 'Select sensor, substitute and Speed, then enter the false value.', 'Set the duration and click Inject fault while a drive is running.', 'The recorded example used 80 m/s for two seconds.',
],'Historical SUMO fault example, retained with its original recording and capture date.'));
add(13,screenshot('Fault example: controller application outage','controller-outage',[
 'The FAULT row marks when the controller application stopped.', 'Replay later moments to check commands, braking and actual speed.', 'The message adapter can stay connected while the decision code is stopped.',
],'Historical SUMO controller-outage recording; the message list shows fault events.'));
add(13,detail('Watchdogs: what happens when updates stop?',table(['Missing or old information','Response from a working control unit'],[
 ['Sensor or navigation update is over 200 ms old','Controller requests braking and zero acceleration'],['Drive command is over 200 ms old','Powertrain removes drive power'],['Brake command is over 200 ms old','Brake unit requests normal braking'],['Brake application itself has failed','The braking request may never reach the simulator'],
]), 'Reference behavior from backend/sdv/application.py and backend/tests/test_live.py. Default normal deceleration is 3 m/s². Stopping is evaluated from ground-truth state, not merely the presence of a stop command. A failed brake application is different from missing controller commands at a working brake application.', 'A watchdog checks for missing updates. Verify the car actually slowed down, as well as checking that a stop was requested.'));

add(15,detail('City population and driving response',table(['Scenario element','Current behavior'],[
 ['48 requested pedestrians','Walker AI moves people, with a 35% crossing factor'],['8 requested traffic vehicles','Traffic Manager controls the surrounding cars'],['Tesla Model 3 ego car','SDV ECU messages control propulsion and braking'],['Actor in the driving corridor','Sensor reports obstacle distance and pedestrian hazard'],['Prepared lane route','Plant follows waypoints; manual lane requests are rejected'],
]), 'Sources: scenarios/carla-city.json, carla_backend.py, application.py and vehicle.dbc. Actual successful spawns may be lower. Actor-truth perception checks relative distance and lateral corridor; PedestrianHazard marks a walker ahead within 25 m and 3 m lateral distance. Collision events are recorded. This is a simple simulation perception model.', 'The portal reports actual actor counts and positions. Inspect the vehicle’s response in the recording.'));
add(15,detail('Startup, cameras and runtime checks',list([
 'Run <code>scripts/Start-Sdv.ps1</code> to start native CARLA and Docker services.', 'Check the CARLA portal for simulator status and actual actor counts.', 'Camera labels show resolution, simulation time and live or recording mode.', 'Use <code>CARLA_CAMERA_WIDTH</code> and <code>CARLA_CAMERA_HEIGHT</code> to change new drives.', 'Stop a drive before restarting its simulator or replacing a module.',
]), 'Sources: Start-Sdv.ps1, Start-Carla.ps1, compose.yaml, docs/carla.md. Defaults are 1920x1080. A camera can lag the current telemetry tick; the UI shows timestamps and stale-frame notices. Only the plant may advance the synchronous world. Keep additional clients from ticking the same server.', 'Native CARLA and the CARLA SDK have distinct processes and health checks.'));
add(15,detail('Retained recordings and legacy mode',list([
 'CARLA is the default source of roads, actor state and cameras.', 'Earlier SUMO/Mapillary recordings remain readable.', 'The shared pHash gallery compares CARLA, retained photos and uploaded references.', 'Set <code>SIMULATOR_BACKEND=sumo</code> to prepare new legacy map-pin routes.', 'Backfill missing CARLA observations with <code>python3 -m sdv.carla_imagery --backfill</code> inside the API container.',
]), 'Sources: docs/carla.md, api.py, carla_imagery.py and compose.yaml. Backfill skips active drives and existing run/station captures; it reads retained driver frames and past telemetry. It does not upscale old camera recordings. Native CARLA city mode has no arbitrary geographic pin picker.', 'The current city preset requires no Mapillary token or external map tiles.'));
add(16,screenshot('Export tutorial: choose the evidence format','recordings-export',[
 'Select a completed drive in Runs & replay.', 'Full recording JSONL includes settings, vehicle state and events.', 'All events CSV includes sent and received messages and their decoded contents.', 'All signals CSV puts each reported value on its own spreadsheet row.',
]));
add(16,screenshot('Export tutorial: download all signals CSV','signals-export-choice',[
 'Click All signals CSV for the selected drive.', 'The browser downloads a .signals.csv file named after the drive ID.', 'Open it in a spreadsheet to compare times, senders, receivers and values.', 'Each send and each reception has its own rows.',
],'Actual export controls; focus highlights the signals download link without changing the recording.'));
add(17,screenshot('Replay tutorial: inspect a recorded moment','replay-controls',[
 'Select a finished drive and click Play replay.', 'Click Pause replay to inspect the vehicle and its messages.', 'Drag Replay time to the moment you want to investigate.', 'The driver view and instruments follow the same selected time.',
]));
add(17,screenshot('Replay tutorial: rerun the saved configuration','rerun-configuration',[
 'Click Rerun configuration to drive again with the same settings.', 'It reuses the route, vehicle settings, random seed and scheduled faults.', 'This creates a new recording; CARLA captures driver frames automatically, even with no browser open.', 'Compare the new drive’s exports and image history with the original.',
],'Rerun button shown for a saved recording; no additional drive was started for these screenshots.'));
add(17,screenshot('CARLA replay: cameras and actors follow time','carla-recording',['Choose a finished CARLA recording.','Move the replay slider to inspect a moment.','The camera selects a frame at or before the cursor from that drive.','Replay never adds similarity observations.']));
add(17,detail('Module replacement example: the controller',list([
 'Stop the drive before replacing the controller’s decision code.',
 'Choose the included Python example by setting this line in <code>.env</code>:',
 '<code>CONTROLLER_COMMAND=python3 /app/examples/python/controller.py</code>',
 'Restart the controller with <code>docker compose up -d controller</code>.',
 'Start a new drive. The example caps acceleration at 1 m/s²; compare its behavior and exports.',
]), 'Existing functionality, not a proposed new SDK. The included Python example wraps the reference controller and caps acceleration at 1 m/s² while preserving the watchdog logic. A compiled C++ example is also included in the native image. Source: examples/python/controller.py, examples/cpp/controller.cpp, native/sdk.hpp, backend/sdv/sdk.py, compose.yaml and docs/extensions.md. The ECU application can be replaced while keeping its native adapter and CAN/SOME/IP contracts.', 'The replacement controller must send and receive the same message formats as the original.'));

add(19,detail('Research idea: how reliable are image matches?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Have people label pairs as the same view, related views or different scenes.','Try pHash match limits from 0 to 16 differing bits.','Compare pHash with DINOv2, a learned image-feature method.'])}</div><div><h3>What to measure</h3>${list(['How many reported matches are correct, and how many repeats are missed.','Errors when lighting, cropping or viewing direction changes.','Processing time and memory needed for each image.'])}</div></div>`,
 'Proposed research, not an implemented feature. Existing inputs: saved images, source metadata and pHashes. DINOv2 provides general visual representations; whether they improve repetition detection here must be tested, not assumed. Primary reference: Oquab et al., DINOv2: Learning Robust Visual Features without Supervision, https://arxiv.org/abs/2304.07193. Local baseline: backend/sdv/imagery.py and image capture database.', 'Proposed study · Baseline: current 64-bit pHash · Reference: <a href="https://arxiv.org/abs/2304.07193" target="_blank" rel="noopener">DINOv2 paper</a>.'));
add(19,detail('Research idea: which routes add new views?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Compare repeated drives with routes chosen to collect unfamiliar views.','Label exact photo repeats separately from similar scenes or locations.','Vary CARLA weather, camera direction and actor seeds; compare retained photo sources separately.'])}</div><div><h3>What to measure</h3>${list(['Useful new views collected per kilometre and per minute.','Share of repeated captures, and range of scene types collected.','Scene coverage, actor diversity and errors when the same location looks different.'])}</div></div>`,
 'Proposed research, not implemented route optimization. NetVLAD studies learned visual place recognition and is a candidate comparison method. No claim of geographic accuracy or improved routing is made for this platform. Primary reference: Arandjelović et al., NetVLAD: CNN Architecture for Weakly Supervised Place Recognition, CVPR 2016, https://arxiv.org/abs/1511.07247. Local sources: carla_backend.py, carla_imagery.py and the capture database. Legacy photo selection remains in mapillary.ts.', 'Proposed study · Reference: <a href="https://arxiv.org/abs/1511.07247" target="_blank" rel="noopener">NetVLAD paper</a> · Distinguish recognizing a location from collecting a new view.'));
add(19,detail('Research idea: which controller handles faults best?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Replace the controller while keeping the same message formats.','Run each version on the same route with the same seed and fault schedule.','Test late messages, lost messages, false values and stopped applications.'])}</div><div><h3>What to measure</h3>${list(['Time from a fault to braking and to the car actually stopping.','Stopping distance, highest speed and time to recover.','Energy used and whether the recording remained complete.'])}</div></div>`,
 'Proposed comparison of controller implementations, not a safety certification claim. Replay itself is observation playback; a new rerun is required to execute a controller. Reference and SDK boundary: examples/python/controller.py, examples/cpp/controller.cpp, backend/sdv/sdk.py, native/sdk.hpp, contracts/vehicle.dbc and backend/tests/test_live.py. Preserve route, profile, seed and fault schedule as experiment controls.', 'Proposed study · Judge success from the actual vehicle response and the complete recording.'));
add(19,detail('Research idea: how repeatable is message timing?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Measure the 50 ms update cycle while the computer is busy.','Compare today’s functional CAN delivery with detailed network timing.','Explore a shared virtual clock as a future design change.'])}</div><div><h3>What to measure</h3>${list(['How often updates run late, and how old received messages are.','Whether late delivery causes watchdog stop requests.','Differences between reruns, computers and software versions.'])}</div></div>`,
 'Proposed research, not an existing detailed bus or virtual-time feature. SIL Kit documents functional and detailed simulation, custom network simulators and optional time synchronization. This platform currently uses functional CAN and wall-time protocol timers. Primary sources: https://vectorgrp.github.io/sil-kit-docs/api/netsim.html and https://vectorgrp.github.io/sil-kit-docs/simulation/simulation.html. Local baseline: native/adapter.cpp, backend/sdv/api.py and dependencies.lock.json.', 'Proposed study · References: <a href="https://vectorgrp.github.io/sil-kit-docs/api/netsim.html" target="_blank" rel="noopener">SIL Kit network simulation</a> and <a href="https://vectorgrp.github.io/sil-kit-docs/simulation/simulation.html" target="_blank" rel="noopener">time synchronization</a>.'));

// Retain the exact main-slide content, including after this script has run once.
function sections(source){
 const parts=[];let depth=0,start=0;
 for(const token of source.matchAll(/<\/?section\b[^>]*>/g)){
  if(token[0].startsWith('</')){depth--;if(depth===0)parts.push(source.slice(start,token.index+token[0].length))}
  else{if(depth===0)start=token.index;depth++}
 }return parts;
}
const start=html.indexOf('<div class="slides">')+'<div class="slides">'.length;
const end=html.indexOf('</div></div><script',start);
const main=sections(html.slice(start,end)).map(outer=>{
 if(outer.includes('data-main-slide=')){
  const match=/<section\b[^>]*data-main-slide="\d+"[^>]*>/.exec(outer);
  return sections(outer.slice(match.index))[0];
 }return outer;
});
if(main.length!==19)throw new Error(`Expected 19 main slides, found ${main.length}`);
const content=main.map((slide,index)=>{
 const chapter=index+1;
 slide=slide.replace(/\sdata-main-slide="\d+"/,'').replace(/^<section/,`<section data-main-slide="${chapter}"`);
 const details=groups.get(chapter)||[];
 return details.length?`<section data-chapter="${chapter}">${slide}\n${details.join('\n')}</section>`:slide;
}).join('\n');
html=html.slice(0,start)+'\n'+content+'\n'+html.slice(end);
html=html.replace('← → slides · Esc overview · S notes · F fullscreen','← → topics · ↑ ↓ details · Esc overview · S notes');
await writeFile(deck,html);
const counts=Object.fromEntries([...groups].map(([chapter,details])=>[chapter,details.length]));
await writeFile(new URL('../public/presentation/details.json',import.meta.url),JSON.stringify({main_slides:19,detail_slides:[...groups.values()].reduce((sum,slides)=>sum+slides.length,0),chapters:counts},null,2));
console.log(JSON.stringify({main:19,details:[...groups.values()].reduce((sum,slides)=>sum+slides.length,0),chapters:counts}));
