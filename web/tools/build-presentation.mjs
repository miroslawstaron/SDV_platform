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
 const sourceNote=[`This screenshot shows ${source.kind}.`,source.run_id?`Recorded drive: ${source.run_id}${source.sample_time!==undefined?`, at ${source.sample_time} seconds`:''}.`:'',source.provider_image_id?`Mapillary image: ${source.provider_image_id}, reached at ${source.station_index*25} metres. Photo taken ${new Date(source.source_captured_at).toISOString().slice(0,10)}; location ${source.lat.toFixed(5)}, ${source.lng.toFixed(5)}. Visual fingerprint: ${source.phash}.`:'',source.description||'',`Screenshot captured on ${screenshots.captured_on}. The real UI displays saved vehicle state and messages; the screenshot workflow does not add drives, image captures or faults. Full source metadata: screenshots/provenance.json. Screenshot file: ${source.file}.`].filter(Boolean).join(' ');
 return detail(title,`<div class="screenshot-layout"><a class="screenshot-link" href="${source.file}" target="_blank" rel="noopener" aria-label="Open full screenshot: ${escape(title)}" data-help="Open this screenshot at its original resolution in a new tab."><img class="slide-screenshot" src="${source.file}" alt="${escape(title)}" loading="eager"></a><div class="screenshot-explanation">${list(explanation)}</div></div>`,
  sourceNote,caption||'Screenshot of the platform UI. Click the image to enlarge it.');
}
const groups=new Map();const add=(chapter,slide)=>{if(!groups.has(chapter))groups.set(chapter,[]);groups.get(chapter).push(slide)};

add(2,screenshot('Engineering dashboard: the test bench','engineering-overview',[
 'Choose the route, set the battery charge and start a drive.',
 'Inspect the control units and their messages, then introduce a fault to see the response.',
 'Replay the recording or export its data for later analysis.',
],'Actual engineering UI showing a saved Gothenburg drive.'));
add(2,screenshot('Engineering dashboard: following the drive','engineering-route',[
 'The map shows where the simulated car is on the route.',
 'The readings show its actual speed, battery charge and journey progress.',
 'View similarity shows whether this street image has appeared before.',
 'The speed chart compares actual speed with the sensor’s report.',
]));

const nativeProvenance='Built here as sdv-native:local on Ubuntu 24.04. SIL Kit 5.0.7 carries CAN messages; vSomeIP 3.7.6 provides navigation services. Python runs our vehicle-control code.';
const pythonProvenance='Built here as sdv-python:local on Ubuntu 24.04. Our Python code uses FastAPI 0.115.12 to handle requests and uvicorn 0.34.2 to serve them.';
const containers=[
 ['api','Platform coordinator',pythonProvenance,['Advances the simulation and manages drives, faults and replay.','Sends dashboard updates and answers image-history requests.','Saves images and their visual fingerprints in a database.'], 'uvicorn sdv.api:app','backend/Dockerfile; backend/sdv/api.py; backend/sdv/imagery.py; /data/images.sqlite; Pillow 11.3.0 (MIT-CMU).'],
 ['registry','Communication directory',nativeProvenance,['Helps the vehicle’s message adapters find one another.','Starts the SIL Kit directory on port 8500.','Provides the connection setup for CAN communication.'],'sil-kit-registry','native/Dockerfile; compose.yaml; upstream https://github.com/vectorgrp/sil-kit/releases/tag/v5.0.7.'],
 ['plant','Road and vehicle simulator',nativeProvenance,['Uses SUMO 1.18.0 to simulate the road and electric car.','Moves the car according to drive, brake and lane commands.','Calculates its actual position, speed and battery energy.'],'ROLE=plant → sdv.worker','backend/sdv/simulator.py; backend/sdv/worker.py; SUMO Ubuntu 1.18.0+dfsg-3build5 (EPL-2.0 / GPL-2.0); native/adapter.cpp; TraCI Python interface.'],
 ['sensor','Vehicle sensor reports',nativeProvenance,['Reads the car’s actual state from the simulator.','Reports speed, position, road conditions and lane to the controller.','Fault tests can delay, remove, freeze or replace these reports.'],'ROLE=sensor → sdv.application','backend/sdv/application.py (sensor); backend/sdv/worker.py; native/adapter.cpp; contracts/vehicle.dbc; Sensors 0x100.'],
 ['bms','Battery management',nativeProvenance,['Reports battery charge, remaining energy and power use.','Shows a warning below 10% charge and reduces drive power below 5%.','Tracks energy consumed and recovered during the drive.'],'ROLE=bms → sdv.application','backend/sdv/application.py (bms); backend/sdv/worker.py; contracts/vehicle.dbc; Battery 0x110. PropulsionLimit=max(0,min(1,charge/5)).'],
 ['navigation','Route guidance',nativeProvenance,['Reads the prepared route and the car’s current surroundings.','Chooses the desired speed and lane, and reports distance left.','Sends this guidance to the controller through SOME/IP.'],'ROLE=navigation → sdv.application','backend/sdv/application.py (navigation); backend/sdv/worker.py; contracts/catalog.json; vSomeIP 3.7.6; service 0x1234/event 0x8001.'],
 ['controller','Driving decisions',nativeProvenance,['Combines route guidance with sensor and battery reports.','Decides how much to accelerate, brake or change lane.','Requests a stop when essential input is more than 200 ms old.'],'ROLE=controller → sdv.application','backend/sdv/application.py (controller); Commands 0x200. CONTROLLER_COMMAND can replace its application. Python/C++ examples: examples/python/controller.py and examples/cpp/controller.cpp.'],
 ['powertrain','Applying drive power',nativeProvenance,['Reads the controller’s acceleration request.','Reduces that request when the battery limits drive power.','Sends the permitted acceleration to the simulator.'],'ROLE=powertrain → sdv.application','backend/sdv/application.py (powertrain); contracts/vehicle.dbc; inputs Commands 0x200/Battery 0x110; output Propulsion 0x210. Missing battery or stale commands reduce positive propulsion to zero.'],
 ['brake','Applying the brakes',nativeProvenance,['Reads how strongly the controller wants to slow down.','Sends the braking action to the simulator.','Requests normal braking if controller commands stop arriving.'],'ROLE=brake → sdv.application','backend/sdv/application.py (brake); contracts/vehicle.dbc; Commands 0x200/Braking 0x220. A failed brake application cannot be assumed to provide its watchdog response.'],
 ['lane','Applying lane changes',nativeProvenance,['Reads the controller’s requested lane change.','Passes the lane action to the simulator.','Requests can mean right (−1), no change (0) or left (+1).'],'ROLE=lane → sdv.application','backend/sdv/application.py (lane); backend/sdv/simulator.py; contracts/vehicle.dbc; Commands 0x200/LaneAction 0x230. This is a lane change model, not continuous steering dynamics.'],
 ['recorder','Saving the experiment',pythonProvenance,['Saves the drive settings, actual vehicle state and message history.','Records each message being sent and each receiver seeing it.','Provides the recording used for replay and downloadable exports.'],'uvicorn sdv.recorder:app','backend/sdv/recorder.py; /data/recordings.sqlite on the persistent sdv-data volume. Python standard-library SQLite and CSV/JSON serialization.'],
 ['maps','Preparing roads and routes',pythonProvenance,['Downloads roads for the selected OpenStreetMap area.','Converts them into a road network SUMO can simulate.','Checks that the endpoints connect and saves the prepared route.'],'uvicorn sdv.maps:app','backend/sdv/maps.py; backend/Dockerfile; official eclipse-sumo 1.18.0 netconvert; pyproj 3.7.1 and rtree 1.4.0. SUMO simulator and isolated release converter are distinct installations; OpenStreetMap data carries ODbL attribution.'],
 ['kuksa','Standard vehicle-signal store','The original KUKSA databroker 0.7.1 image is used unchanged (Apache-2.0). Signal names come from COVESA’s Vehicle Signal Specification, VSS 6.1 (MPL-2.0).', ['Makes reported values available under standard Vehicle.* names.','Receives speed, position and battery updates from our gateway.','Lets other software read these values through a common interface.'],'kuksa-databroker --vss /contracts/vss.json','compose.yaml; contracts/vss.json; backend/dependencies.json. Local configuration uses --insecure. Upstream: https://github.com/eclipse-kuksa/kuksa-databroker and https://github.com/COVESA/vehicle_signal_specification.'],
 ['gateway','Translating vehicle signals',pythonProvenance,['Reads the values reported by the vehicle’s control units.','Copies speed, position and battery readings into KUKSA.','Converts speed to km/h and remaining energy to kWh.'],'python3 -m sdv.gateway','backend/sdv/gateway.py; kuksa-client 0.4.3 (Apache-2.0); broker port 55555; 200 ms publishing loop. It mirrors ECU reports, not independent ground truth.'],
 ['instruments','The driver’s instrument panel','Built here as sdv-instruments:local. nginx 1.27 Alpine serves our display’s HTML, CSS and JavaScript; nginx uses the BSD-2-Clause license.', ['Reads the selected drive’s actual state directly from the platform.','Shows speed, battery, journey progress and similarity warnings.','Works inside the driver window or separately on port 8081.'],'nginx → instruments/public/','instruments/Dockerfile; instruments/nginx.conf; instruments/public/dashboard.js; instruments/manifest.json; original user-supplied Metriczone logo.'],
 ['web','Dashboards and presentation','Our React 19.1.0 app is built with Node 22 and served by nginx 1.27. Leaflet 1.9.4 shows maps, MapillaryJS 4.1.2 shows street images and reveal.js 6.0.2 displays this deck.', ['Provides the engineering dashboard, driver view and image gallery.','Connects browser requests to the API and instrument service.','Serves this presentation and its screenshots locally.'],'nginx → web/dist/','web/Dockerfile; web/nginx.conf; web/package.json; web/public/presentation/vendor/README.txt; THIRD_PARTY_NOTICES.md. Node is a build dependency, not the running web server.'],
];
for(const [name,title,provenance,content,entry,source] of containers){
 add(3,detail(`Container: ${name} · ${title}`,`<div class="two-columns"><div><h3>What it does</h3>${list(content)}<p class="entrypoint"><code>${escape(entry)}</code></p></div><div><h3>Where its software comes from</h3><p>${escape(provenance)}</p></div></div>`,`${source} Container definition: compose.yaml. Exact built image IDs, pinned base digests and package versions: dependencies.lock.json. Local application and native adapter code are platform-owned reference implementations, not upstream ECU products. SIL Kit uses MIT and vSomeIP MPL-2.0. The shared native image includes gRPC/protobuf and the local message adapter.`, 'Each service runs independently, even when several services use the same base image.'));
}

const frames=new Map();
for(const match of dbc.matchAll(/BO_\s+(\d+)\s+(\w+):\s+(\d+)\s+(\w+)\r?\n([\s\S]*?)(?=\r?\nBO_|$)/g)){
 const rows=[...match[5].matchAll(/SG_\s+(\w+)\s*:\s*[^\n]*?"([^"]*)"\s*([^\r\n]*)/g)].map(signal=>[signal[1],signal[2]||'unitless',signal[3].trim()]);
 frames.set(Number(match[1]),{name:match[2],bytes:match[3],producer:match[4],rows});
}
const signalMeanings={Speed:'Reported vehicle speed',Latitude:'North–south location',Longitude:'East–west location',Heading:'Direction of travel',Remaining:'Distance left on the route',SpeedLimit:'Current road’s speed limit',LightDistance:'Distance to the traffic light',RedLight:'Whether the traffic light is red',LaneIndex:'Current lane number',Sequence:'Update counter: identifies successive messages',Charge:'Battery charge remaining',Energy:'Electrical energy remaining',Power:'Current battery power use',Consumed:'Energy used during this drive',Regenerated:'Energy recovered during this drive',PropulsionLimit:'Allowed fraction of drive power (0–1)',LowBattery:'Whether charge is below 10%',Acceleration:'How quickly to increase speed',Deceleration:'How quickly to reduce speed',LaneRequest:'Right (−1), no change (0) or left (+1)',TargetSpeed:'Desired vehicle speed'};
function signalSlide(id,offset,count,title='',explanation=''){
 const frame=frames.get(id),binding=`0x${id.toString(16)}`;
 const recipients=catalog.messages.find(m=>m.id===id).consumers.join(', ');
 return detail(title,table(['Signal and unit','What it means','Receiver'],frame.rows.slice(offset,offset+count).map(([name,unit,receiver])=>[`${name}${unit==='unitless'?'':` (${unit})`}`,signalMeanings[name]||name,receiver.replaceAll(',',', ')])).replace('detail-table','detail-table signal-table'),
  `Exact field names and receivers from contracts/vehicle.dbc, frame ${binding} ${frame.name} (${frame.bytes} bytes); message-level intended consumers from contracts/catalog.json; applied behavior from backend/sdv/application.py and backend/sdv/simulator.py. CAN is broadcast, so other adapters may also record receptions. All six CAN messages are produced every 50 ms. Sequence is a uint16 counter. ${explanation}`,
  `${frame.name} ${binding} · ${frame.producer} → ${recipients} · ${explanation||'20 updates per second; inputs older than 200 ms trigger a fallback.'}`);
}
add(4,signalSlide(256,0,4,'Sensor feedback: speed and position'));
add(4,signalSlide(256,4,6,'Sensor feedback: road and journey'));
add(4,signalSlide(272,0,5,'Battery feedback: charge and energy'));
add(4,signalSlide(272,5,3,'Battery feedback: limits and warnings'));
add(4,signalSlide(512,0,5,'Controller requests: how the car should move','Receiver names follow the DBC message definition. The simulator moves the car using the applied actions below.'));
add(4,signalSlide(528,0,2,'Drive power: acceleration actually applied','The battery limit scales the controller’s request. Missing battery feedback prevents acceleration.'));
add(4,signalSlide(544,0,2,'Brakes: slowing the car down','A working brake unit requests normal braking when controller commands stop arriving.'));
add(4,signalSlide(560,0,2,'Lane changes: moving left or right','An old controller command leads to no lane change.'));
add(4,detail('Route guidance: what navigation sends',table(['Message field','What it means'],[
 ['version','Message format version (currently 1)'],['sequence','Update counter: identifies successive messages'],['target_speed','Desired speed, in metres per second'],['lane_request','Right (−1), no change (0) or left (+1)'],['remaining','Distance left on the route, in metres'],
]), 'Source: contracts/catalog.json, backend/sdv/application.py and native/adapter.cpp. Service 0x1234, instance 0x0001, event 0x8001, event group 0x0001; GetIntent method 0x0001. JSON UTF-8 serialization. Data transport: UDP 30509; service discovery multicast 224.224.224.245:30490; sequence is uint16.', 'navigation → controller via SOME/IP · service 0x1234, event 0x8001 · Guidance older than 200 ms triggers a stop request.'));

add(6,screenshot('Driver example: instruments beside the street view','driver-view',[
 'The left panel shows the car’s actual recorded state.', 'The street image on the right changes every 25 metres.', 'The map shows the car’s location; the photo may have been taken nearby.',
],'Saved drive shown in the driver view. The street photo shows scenery from its original capture date.'));
add(6,screenshot('Driver example: reading the vehicle instruments','driver-instruments',[
 'Speed and battery readings come directly from the simulator.', 'Power shows whether the car is using energy or recovering it while slowing down.', 'During replay, readings and warnings follow the selected recording time.',
]));

add(7,screenshot('Street imagery: what the driver sees','imagery-example',[
 'The same photo stays visible until the car reaches the next 25 m point.', 'The status shows when the photo was taken and how far its location is from the car.', 'Drag to look around. Click Follow vehicle to face the direction of travel again.',
]));
const image=screenshots.assets['image-provenance'];
add(7,detail('Image provenance: where this photo came from',`<div class="two-columns"><div><h3>The original photo</h3>${list([`Mapillary image ID: <code>${escape(image.provider_image_id)}</code>.`,`Taken on ${new Date(image.source_captured_at).toISOString().slice(0,10)}.`,`Photo location: ${image.lat.toFixed(5)}, ${image.lng.toFixed(5)} (latitude, longitude).`])}</div><div><h3>Where we encountered it</h3>${list([`Drive ${escape(image.run_id.slice(0,8))}, at the ${image.station_index*25} m point.`,`Visual fingerprint (pHash): <code>${escape(image.phash)}</code>.`,'The photo is stored once; each drive’s encounter is recorded separately.'])}</div></div>`,
 `Example source metadata from screenshots/provenance.json and /api/v1/image-captures, not an invented photograph. Capture date belongs to the original provider image, not the simulated drive. The official viewer preserves provider/contributor attribution. Contributor name is not a field currently stored in the capture database; use the provider image ID and viewer attribution to trace the source. Code: web/src/mapillaryViewer.ts, web/src/mapillary.ts and backend/sdv/imagery.py.`, 'The street photo comes from Mapillary; the map comes from OpenStreetMap. Its photo date and location can differ from the drive.'));
add(7,detail('How the platform chooses street photos',table(['Selection rule','What the platform does'],[
 ['When to change photos','At 0, 25, 50… metres along the drive'],['Close to the route point','Accept photos taken within 50 m'],['Close to the road','Require the photo to be within 20 m of the road'],['Ordinary photo direction','Require the camera to face within 60° of travel'],['No suitable photo ready','Continue the drive and show the car on the map'],
]),'Source: web/src/mapillary.ts, web/src/geo.ts, web/src/imageryRoute.ts and web/src/imageryPreload.ts. Panorama preference is based on candidate type and route suitability; no panorama coverage guarantee is implied. SDK metadata corrects geometry/heading where available. The offset can exceed 50 m while an image is held between stations.', 'Photos are loaded ahead of time. They enter capture history only when reached during a drive with the driver view open.'));

add(8,screenshot('Similarity dashboard: browsing saved drives','similarity-dashboard',[
 'Choose one drive or browse images from all drives.', 'Click an image to see its fingerprint, source date and location.', 'The comparison list searches all drives, including those hidden by your filter.',
]));
add(8,screenshot('Similarity example: exact repeats across drives','similarity-exact',[
 '100% means the visual fingerprints match. Same image also confirms an identical file.', 'Seeing the photo on another drive counts as another capture.', 'Lower scores help you inspect views that did not qualify as matches.', 'Matching only keeps scores of 87.5% or higher.',
],'Saved comparisons across drives. The selected capture is not compared with itself.'));
const warning=screenshots.assets['driver-similarity-warning'];
add(10,screenshot('Similarity warning on the driver’s dashboard','driver-similarity-warning',[
 'View similarity appears in the instrument panel and over the street image.', 'At least five other matching captures show “Drive to another place.”', 'The warning clears when the next view has fewer than five matches.',
],warning.kind.startsWith('illustrative')?'Illustrative warning: a five-match response shown on a saved drive.':'Actual saved capture matches shown on the driver’s instruments.'));

add(12,screenshot('Normal drive: actual and reported speed','truth-normal',[
 'The teal line shows actual speed calculated by the simulator.', 'The orange line shows the speed sent by the sensor unit.', 'Use this normal drive as a baseline before introducing faults.',
]));
add(12,screenshot('Sensor fault: a false speed report','truth-substituted',[
 'This test makes the sensor report 80 m/s (288 km/h).', 'The car’s actual speed remains visible in the teal line.', 'The orange line and message values show what the controller was told.',
],'A saved drive with false sensor-speed reports.'));
add(13,screenshot('Fault example: configuring sensor substitution','fault-configuration',[
 'Select sensor, substitute and Speed, then enter the false value.', 'Set the duration and click Inject fault while a drive is running.', 'The recorded example used 80 m/s for two seconds.',
],'Fault settings used in the saved example.'));
add(13,screenshot('Fault example: controller application outage','controller-outage',[
 'The FAULT row marks when the controller application stopped.', 'Replay later moments to check commands, braking and actual speed.', 'The message adapter can stay connected while the decision code is stopped.',
],'Saved controller-outage test, with the message list filtered to show fault events.'));
add(13,detail('Watchdogs: what happens when updates stop?',table(['Missing or old information','Response from a working control unit'],[
 ['Sensor or navigation update is over 200 ms old','Controller requests braking and zero acceleration'],['Drive command is over 200 ms old','Powertrain removes drive power'],['Brake command is over 200 ms old','Brake unit requests normal braking'],['Brake application itself has failed','The braking request may never reach the simulator'],
]), 'Reference behavior from backend/sdv/application.py and backend/tests/test_live.py. Default normal deceleration is 3 m/s². Stopping is evaluated from ground-truth state, not merely the presence of a stop command. A failed brake application is different from missing controller commands at a working brake application.', 'A watchdog checks for missing updates. Verify the car actually slowed down, as well as checking that a stop was requested.'));

add(15,screenshot('Route tutorial: choose two map pins','route-pins',[
 'Stop the current drive before choosing a new route.', 'Click the map once for the start and again for the destination.', 'Click Reset pins if you want to change those choices.', 'Click Prepare route to load the roads and check the journey.',
],'Illustrative map-pin selection in the actual UI; no new route download was submitted.'));
add(15,detail('Route tutorial: preparation and validation',list([
 'After Prepare route, the progress display shows each preparation stage.',
 'The platform downloads the nearby OpenStreetMap roads and converts them for the simulator.',
 'It moves each pin onto a suitable car lane no more than 100 m away.',
 'The selected roads must connect, and the journey must be 100 m to 5 km long.',
 'If preparation fails, read the error, adjust your pins if needed and retry.',
]),'Source: backend/sdv/maps.py, contracts/schemas/route-request.schema.json and web/src/Dashboard.tsx. Initial download margin is 1 km, bounded area 100 km² and at most two expansions. Provider retry behavior is documented in README.md. This explains the actual preparation pipeline; the screenshot tutorial did not create an additional route.', 'Click Cancel to stop preparation. Review a successfully prepared route before starting the drive.'));
add(15,screenshot('Route tutorial: review and start the prepared route','route-prepared',[
 'Check the adjusted start and destination, route line and distance.', 'Choose the battery charge at the start of the drive.', 'Click Start drive, then open the driver’s view.', 'Keep that view open so reached street images are saved.',
],'The bundled prepared Gothenburg route is shown as the review example.'));
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
 'Click Rerun configuration to drive again with the same settings.', 'It reuses the route, vehicle settings, random seed and scheduled faults.', 'This creates a new recording; reached photos are captured if the driver view is open.', 'Compare the new drive’s exports and image history with the original.',
],'Rerun button shown for a saved recording; no additional drive was started for these screenshots.'));
add(17,detail('Module replacement example: the controller',list([
 'Stop the drive before replacing the controller’s decision code.',
 'Choose the included Python example by setting this line in <code>.env</code>:',
 '<code>CONTROLLER_COMMAND=python3 /app/examples/python/controller.py</code>',
 'Restart the controller with <code>docker compose up -d controller</code>.',
 'Start a new drive. The example caps acceleration at 1 m/s²; compare its behavior and exports.',
]), 'Existing functionality, not a proposed new SDK. The included Python example wraps the reference controller and caps acceleration at 1 m/s² while preserving the watchdog logic. A compiled C++ example is also included in the native image. Source: examples/python/controller.py, examples/cpp/controller.cpp, native/sdk.hpp, backend/sdv/sdk.py, compose.yaml and docs/extensions.md. The ECU application can be replaced while keeping its native adapter and CAN/SOME/IP contracts.', 'The replacement controller must send and receive the same message formats as the original.'));

add(19,detail('Research idea: how reliable are image matches?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Have people label pairs as the same view, related views or different scenes.','Try pHash match limits from 0 to 16 differing bits.','Compare pHash with DINOv2, a learned image-feature method.'])}</div><div><h3>What to measure</h3>${list(['How many reported matches are correct, and how many repeats are missed.','Errors when lighting, cropping or viewing direction changes.','Processing time and memory needed for each image.'])}</div></div>`,
 'Proposed research, not an implemented feature. Existing inputs: saved images, source metadata and pHashes. DINOv2 provides general visual representations; whether they improve repetition detection here must be tested, not assumed. Primary reference: Oquab et al., DINOv2: Learning Robust Visual Features without Supervision, https://arxiv.org/abs/2304.07193. Local baseline: backend/sdv/imagery.py and image capture database.', 'Proposed study · Baseline: current 64-bit pHash · Reference: <a href="https://arxiv.org/abs/2304.07193" target="_blank" rel="noopener">DINOv2 paper</a>.'));
add(19,detail('Research idea: which routes add new views?',`<div class="two-columns"><div><h3>What to try</h3>${list(['Compare repeated drives with routes chosen to collect unfamiliar views.','Label exact photo repeats separately from similar scenes or locations.','Check the effects of photo age, viewing direction and location errors.'])}</div><div><h3>What to measure</h3>${list(['Useful new views collected per kilometre and per minute.','Share of repeated captures, and range of scene types collected.','Wrong-road selections and gaps where street photos are unavailable.'])}</div></div>`,
 'Proposed research, not implemented route optimization. NetVLAD studies learned visual place recognition and is a candidate comparison method. No claim of geographic accuracy or improved routing is made for this platform. Primary reference: Arandjelović et al., NetVLAD: CNN Architecture for Weakly Supervised Place Recognition, CVPR 2016, https://arxiv.org/abs/1511.07247. Local sources: mapillary.ts, geo.ts, imageryRoute.ts and captures.', 'Proposed study · Reference: <a href="https://arxiv.org/abs/1511.07247" target="_blank" rel="noopener">NetVLAD paper</a> · Distinguish recognizing a location from collecting a new view.'));
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
