 

# Metriczone · SDV measurement lab

A containerized electric passenger car test bench with a live engineering dashboard, independent driver window, CAN FD and SOME/IP ECU communication, fault injection, and recorded replay.

## Start on Windows

Requirements: Docker Desktop in Linux container mode, Docker Compose 2.17 or later, and PowerShell. Docker needs internet access for the first image build. Allow roughly 4 GB of disk space for dependencies and images. No host Python, SUMO, SocketCAN, GPU, or privileged containers are required.

Double-click **Start-Sdv.cmd** in the project folder, or run:

```powershell
.\Start-Sdv.cmd
```

The launcher starts Docker Desktop if needed, starts the complete platform, waits for the dashboard and vehicle services to be ready, and opens the dashboard. It uses the project's folder even when launched from another directory. An existing active drive is kept running. If startup fails, the launcher displays the error and keeps its window open.

For command-line use, `./scripts/Start-Sdv.ps1 -NoBrowser` starts without opening a browser; add `-NoBuild` to reuse existing images. Startup does not automatically start a driving experiment: use **Start drive** on the dashboard.

Restart recovery loads only unfinished drives. The recording dropdown loads compact summaries and fetches a full recording when selected; saved configuration, replay and exports retain the complete data.

## Manage the environment

Open **Management** in the engineering dashboard header, or go to [the management dashboard](http://localhost:8080/management). It shows saved recordings, image storage, uploaded references, prepared routes and live service health.

- **Recording history:** search by run ID or status, select recordings, export JSONL, and delete selected recordings or clear all history. Captured images stay available unless **Also remove their image observations** is selected. Images shared with another drive or an uploaded reference are kept.
- **Images & reference library:** upload JPEG, PNG or WebP files, download originals, delete selected images or clear the image database. Each stored image can have one uploaded reference observation. A 100% pHash match reuses the stored file and any existing library reference, even when the uploaded bytes, format or metadata differ. Reference images have no supplied geographic position or original capture date and are identified as uploads in the gallery. Uploads are limited to 12 MiB and 20 million pixels per file.
- **Vehicle services:** inspect health and reset the simulator and ECUs to clear transient application state and injected faults while retaining saved data. This resets services through their existing reset API; Docker startup and container restarts remain available through `Start-Sdv.cmd`.
- **Prepared routes:** remove custom routes and their cached road files. The bundled Gothenburg route is kept. Existing recordings can still be replayed, but a removed route must be prepared again before rerunning its configuration.

Deletion and reset controls show a confirmation with the affected scope. Stop an active drive before importing images, cleaning storage or resetting services; the API also enforces this restriction. Deletion cannot be undone, so export recordings or download images you want to keep. SQLite reuses deleted database pages for future data; the allocated database file does not immediately shrink. Hover over a control or reading for three seconds for its explanation.

Open [the dashboard](http://localhost:8080). The default is a bundled **371 m Gothenburg route along Nya Allén**, prepared from genuine OpenStreetMap roads and usable offline. Click **Start drive**. **Open driver’s view** opens an independent browser window with vehicle instruments on the left and map/street imagery on the right; its direct link also works when popups are blocked. The API documentation is at [localhost:8000/docs](http://localhost:8000/docs).

The dashboard and driver's location map use **OpenStreetMap with Leaflet**. To enable **Mapillary street imagery**, obtain a free **client access token**:

1. Create an account or sign in at [Mapillary](https://www.mapillary.com/app/?login=true).
2. Open the [developer dashboard](https://www.mapillary.com/dashboard/developers) and register an application, for example **Personal SDV Lab**. If requested, use `http://localhost:8080` as the website.
3. Copy the application's **client access token**, not an application secret or a user/upload token. See the [official MapillaryJS setup guide](https://mapillary.github.io/mapillary-js/docs/intro/try/).
4. Set the following in `.env`, then rerun `scripts/Start-Sdv.ps1` and refresh both browser windows:

```dotenv
MAPILLARY_ACCESS_TOKEN=your-client-access-token
```

Mapillary is [free to use](https://help.mapillary.com/hc/en-us/articles/8348198426396-Mapillary-FAQ); no Google billing account or Maps API key is used. The client token is delivered to the browser to authorize the official viewer and nearby-image searches. A legacy `GOOGLE_MAPS_API_KEY` entry is ignored. Without a token, the driver window still shows the vehicle on a map, with speed, battery and progress. Optional online OSM tiles do not determine whether the bundled simulation runs. Keep the client token in `.env`; it is not written to recordings or exports.

The driver window **preloads imagery at 0, 25, 50, 75… metres along the route** and changes the displayed image only when the vehicle enters the next 25 m interval. Route distances use ground-truth driving progress; geometry is clipped to the snapped endpoints. All route image data loads in the background, prioritizing the current point and the points ahead. Three bounded viewer buffers keep the current view and the next two views rendered in advance, so crossing a prepared boundary switches the visible viewer without a cold image request. The window shows the current distance point and preload progress. A point with missing or unprepared imagery shows the location map; simulation never waits for images.

Nearby **360° panoramas** are preferred, with heading tracking throughout each interval. Ordinary street photographs are accepted when their camera heading is within 60° of the route direction at the 25 m point; these are labelled as a limited camera view. Selection requires imagery within 50 m of its sampled route point and 20 m of the prepared road geometry. The image is held for the entire interval, so its offset from the moving car can exceed 50 m before the next switch; the live offset and ground-truth location map remain visible. Dragging or zooming imagery releases heading tracking; **Follow vehicle** restores it. Provider and contributor attribution stays visible.

Coverage and capture age vary along Gothenburg roads; imagery does not show simulated traffic, obstacles, or signal states. Metadata searches are limited to one per second, with two preload jobs in flight and bounded retry/backoff. Decoded/rendered views are limited to three viewers, and image bytes use a shared 64 MiB memory cache. Standard SDK thumbnails (2048-pixel panoramas and 1024-pixel photos) are preloaded; progressive high-resolution tile loading is disabled to avoid delays during switches. Replay reuses the prepared route images and memory cache, reloading evicted data when necessary. Tokens are never archived in recordings, image storage or exports. Captured street images are kept in the separate similarity database described below. Closing the window clears the in-memory preload cache. The viewer requires WebGL support.

## Captured image similarity

During a live drive, keep the driver's view open to capture each displayed 25 m image. Future preloads and replay do not create captures. The API stores the original SDK image bytes, a 64-bit DCT pHash, provider image ID, image location, capture date and run/station observation in `/data/images.sqlite` on the persistent `sdv-data` volume. A panorama is hashed as its full source image; rotating or zooming the viewer does not create a new image. New images with identical pHashes (100% similarity, zero differing bits) reuse the first stored image file. Their incoming bytes are not stored again, even when encoding or metadata differs. Each reached run/station still records a lightweight observation pointing to the shared image, so repeated drives continue to increase the similarity count. Previously stored files are retained; this policy applies to new captures and imports. Repeated windows and upload retries are idempotent.

**View similarity** appears in the engineering dashboard and below the speedometer in the independent instrument panel, including when embedded in the driver's view. The street image has no similarity overlay. It reports the closest other captured observation as `100 × (1 − Hamming distance / 64)`, the number of matching captures, unique stored images and total captures. A match has a Hamming distance of **8 bits or fewer**. When **at least five other captured observations** match, a warning icon says **Too much similarity · Drive to another place**. Only the current run/station capture is excluded. Earlier captures of the same image are retained as 100% matches, so repeated drives increase the similarity count. Each run/station counts once; duplicate uploads and replay never create additional observations. The default threshold is an initial heuristic; visually inspect results before adjusting `MAX_DISTANCE` in `backend/sdv/imagery.py` for a particular dataset. Hash similarity is a visual comparison, not a confidence score or a geographic-distance estimate.

Use **Open image similarity dashboard** on the engineering dashboard, or open [the image similarity dashboard](http://localhost:8080/image-similarity), to browse stored source images after driving. Filter by drive, select a captured station, inspect its pHash and metadata, and review ranked comparisons across all drives. **Matching only** restricts the list to the 8-bit threshold. **Refresh images** reloads history after a drive. Unique image bytes and capture observations have separate totals. The gallery also works for retained captures after a vehicle recording is deleted. `GET /api/v1/image-captures` provides paginated capture history and drive counts; `GET /api/v1/image-captures/{run_id}/{station_index}/similarity` provides paginated comparisons independently of vehicle recordings.

The displays follow the current 25 m station, clear old results at boundaries, and show unavailable/waiting states when no capture or comparison is available. Replay reads saved captures without adding images. A failed upload shows **Retry capture** in the driver's view. Storage is independent of vehicle recording and survives deleting a run; image bytes and hashes are excluded from vehicle recording exports. `GET /api/v1/images` lists stored images and pHashes with pagination; `GET /api/v1/images/{image_id}` returns an original image; `GET /api/v1/runs/{run_id}/images/{station_index}/similarity` returns the current comparison. The driver submits binary image data to `POST /api/v1/runs/{run_id}/images/{station_index}`. The API rejects invalid images and uploads larger than 12 MiB.

```powershell
.\scripts\Stop-Sdv.ps1
```

Stopping preserves the `sdv-platform_sdv-data` Docker volume, including maps and recordings. Delete individual recordings in the dashboard. Do not remove this volume if you want to retain your data.

## Metriczone presentation and vehicle instruments

The UI matches the Metriczone teal-and-white identity used in the 5G simulator, with the supplied original logo and “Measure. Understand. Improve.” tagline. The engineering header links to [How the SDV platform works](http://localhost:8080/presentation/), a reveal.js presentation with 19 main slides and 52 vertical detail slides, including captured-image storage, pHash distance and similarity percentages, repeated-drive counters, the five-match warning and browsing saved comparisons. Details include dashboard screenshots, every Compose container’s contents and provenance, ECU signal contracts, imagery sources, route/replay/export tutorials and proposed research. Screenshot source metadata and any illustrative states are recorded in `web/public/presentation/screenshots/provenance.json`; click a screenshot to open its original resolution. `web/tools/capture-presentation.mjs` captures read-only saved-run examples and `web/tools/build-presentation.mjs` regenerates detail slides while preserving the main slides. Its runtime, speaker notes and MIT license are served locally; left/right arrow keys move between the 19 main topics, up/down explore their detail slides, Esc opens the overview, S opens notes, and the Print / PDF link prepares printable slides.

Hover over a control, reading, map, diagram or warning for three seconds to see its explanation. The same help is available in the engineering dashboard, driver window, standalone instruments and presentation; focusing a control with the keyboard also shows help after three seconds. Moving away, clicking, scrolling or pressing Esc dismisses the explanation. Native tooltips are replaced with delayed help so they do not appear early.

The driver window keeps an equal left/right split. The left side is a conventional EV instrument display: speedometer, battery, power/regeneration, road speed limit, journey progress, remaining and travelled distance, elapsed simulation time, lane, heading and warnings. It uses authoritative state so faults in reported speed or battery remain distinguishable on the engineering test bench. Delayed or disconnected updates are marked instead of silently presenting old values as current.

The instrument dashboard is a separate `sdv-instruments:local` Docker image and `instruments` Compose service. It independently reads the versioned run REST/WebSocket endpoints and follows the same replay stream; the driver browser does not forward state to it. `/instruments/?run=RUN_ID` embeds it through the web proxy. [The standalone instrument service](http://localhost:8081) is available on localhost port 8081; append `?run=RUN_ID`, or use **Open instruments separately** in the driver window. Closing either browser leaves simulation running. The instrument service has no ECU control role and can be replaced without changing the ECUs or simulator. Its interface is documented in `instruments/manifest.json`.

## Test workflow

1. Select the bundled route, or click two map points and **Prepare route**. Inspect the snapped endpoints and route before starting. Imported driving distances must be 100 m–5 km.
2. Set the initial battery charge and start. The controller receives navigation intent over SOME/IP and sensor feedback over CAN. Navigation uses route lane connectivity to request the lane needed for upcoming turns; these requests pass through the controller and lane ECU before moving the vehicle. Manual lane requests take precedence for that tick. Actuator ECUs send applied commands over CAN to the SUMO plant.
3. Inspect raw payloads, decoded signals, ECU health, ground truth, and reported values. Use **E/E architecture** to select nodes and contracts: it shows producers, consumers, CAN IDs, SOME/IP service, individual signals, units, VSS mappings, and current values. The **Sequence diagram** follows the live simulation or replay cursor and reads complete recorded events, with time-window, node, and transport filters. Solid arrows mean transmit; dashed arrows mean observed receive. A CAN transmit does not imply reception; reception is recorded at each participating adapter. Enable **Include every CAN receiver** to see observations beyond the declared contract consumers.
4. Inject a fault, or create a scheduled scenario through the API. Try dropping sensor messages or stopping the controller for five seconds. Remove the fault or let its duration expire.
5. Stop or complete the run. Select the recording to replay or scrub. The driver window and sequence diagram follow the same replay cursor. **Rerun configuration** starts a new run with the saved profile, seed, module configuration, and scheduled faults. **Full recording JSONL** exports configuration, ground truth, faults, and every event. **All events CSV** includes raw and decoded messages. **All signals CSV** provides one row per decoded signal observation, including run/event IDs, simulation and native monotonic time, source, destination, observer, protocol, direction, message ID, sequence, raw payload, value, unit, and VSS mapping. Transmit and each reception are kept separate, including duplicates. Exports during a live run are consistent snapshots; download again after completion for the full journey. Export sizes are not limited by display or event pagination.

The dashboard intentionally samples live events; recording is complete and transactional. Recorder failures or native observation queue overflow invalidate a run. Failed ECUs remain visible and their effects are preserved.

## Services and contracts

`compose.yaml` defines separate navigation, controller, powertrain, brake, lane, sensor, and BMS containers, plus a plant adapter, registry, recorder, map worker, API, KUKSA broker/gateway, web server, and independent `instruments` server. ECU containers contain a native adapter and a separately supervised application process. Stopping an ECU application leaves its transport observation available.

- `contracts/vehicle.dbc`: real little endian CAN FD layouts and units.
- `contracts/catalog.json`: message ownership, consumers, VSS mappings, and SOME/IP service definitions.
- `contracts/adapter.proto`: local native-adapter gRPC interface.
- `contracts/modules.json`: reference module manifests.
- `contracts/schemas/`: JSON schemas for modules, scenarios, and route requests.
- `backend/dependencies.json`: upstream references, licenses, adaptations, and energy parameters.
- `dependencies.lock.json`: resolved images, digests, packages, and fixture checksums produced by the launcher. Provenance is stored with subsequent runs.

The functional CAN bus uses SIL Kit 5.0.7. SOME/IP uses vSomeIP 3.7.6, including a documented one-condition Docker compatibility patch that honors disabled multicast-route notifications. The modified upstream file and its MPL license are shipped under `/usr/share/sdv/upstream` in the native image. Both discovery and data remain actual vSomeIP UDP traffic.

SUMO is pinned to the Ubuntu 24.04 package version recorded in the dependency lock (1.18.0). Road conversion uses the official `eclipse-sumo==1.18.0` release binary, installed separately from the simulator, because Ubuntu's converter aborts on some valid OSM junction angles ([upstream issue](https://github.com/eclipse-sumo/sumo/issues/14917)). Its older battery parameter names are used explicitly. KUKSA uses the unmodified VSS 6.1 release tree; speed is converted from internal m/s to the VSS km/h unit.

## Replace an ECU

The quickest path is to change `CONTROLLER_COMMAND` in `.env`:

```dotenv
CONTROLLER_COMMAND=python3 /app/examples/python/controller.py
# or:
CONTROLLER_COMMAND=/usr/local/bin/example-controller
```

Then recreate the controller:

```powershell
docker compose up -d controller
```

Both examples limit acceleration to 1 m/s² and preserve the reference watchdog behavior. For a different container image, build from `sdv-native:local`, copy your application, and set `APPLICATION_COMMAND` in a Compose override. See [the extension guide](docs/extensions.md). All ECU roles can be replaced this way.

Custom ECU applications receive a line of JSON per tick on stdin and return one JSON action object on stdout. Sensor, BMS, and navigation receive plant environment data; the controller and actuator roles receive observations from their native network adapter. Application stdout is reserved for the process contract; use stderr for diagnostics. Python and C++ gRPC helpers are included for direct adapter integration.

## Verify

```powershell
.\scripts\Test-Sdv.ps1
.\scripts\Test-Sdv.ps1 -Live -Browser
```

The second command runs real Docker acceptance scenarios and Chromium tests; it takes several minutes and requires the platform to be idle. Routine browser tests mock Mapillary metadata and viewer responses. A real Mapillary smoke test requires your client token: drive a covered route, check heading at a turn, imagery offset and capture date, look around a panorama, restore **Follow vehicle**, then scrub the recording. Verify provider attribution remains visible. Ordinary photographs have a fixed camera direction; coverage is not guaranteed for the bundled route. Do not commit tokens or archive provider images in test artifacts.

Frontend development and browser tests also require Node.js 22 or 24. The launcher itself uses only PowerShell and Docker.

To use an existing Chromium executable for browser tests, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its absolute path; the test script then skips the browser download.

## Limits

One user, one vehicle, one active run, maximum fifteen simulated minutes, normal speed live execution, and no background traffic. Lane actions are lane changes, not steering-angle dynamics. The EV energy model is illustrative; it does not model battery temperature, electrochemistry, charging workflows, or realistic brake blending.

Timing is software timing: CAN arbitration and electrical effects are excluded. SOME/IP and ECU watchdogs use wall time; simulator time and monotonic timestamps are recorded separately. Overruns are visible. Replay displays recorded observations rather than executing ECU software again.

Imagery road matching uses a 50 m route-station-distance bound and 20 m route-geometry bound. Closely parallel or stacked roads can still be ambiguous. Coverage and panoramas can change between live viewing and replay.

## Troubleshooting

If simulation time advances while the car stays still, inspect whether the communication trace contains CAN receptions at `plant`, especially Propulsion `0x210`, Braking `0x220` and LaneAction `0x230`. Control-unit transmissions alone do not prove delivery. The native services depend on `registry` with `restart: true`, so an explicit Compose update or restart of the registry reconnects all its participants, including the simulator. See [Docker's dependency restart behavior](https://docs.docker.com/compose/how-tos/startup-order/). Restart communication services only after stopping the active drive.

Use `docker compose ps` and `docker compose logs --tail 80 SERVICE`. Custom route downloads use the configured `OVERPASS_URL` first, then try the public VK Maps, Private.coffee and FOSSGIS Overpass providers without duplicates, with two bounded rounds for timeouts, connection failures and temporary provider errors. The default is VK Maps; the former `overpass.kumi.systems` endpoint timed out during verification. Failed jobs display the provider error and retain your pins so you can retry **Prepare route**. You can change `OVERPASS_URL` in `.env` and run `docker compose up -d --no-deps maps` to use a different primary provider. The bundled route and previously imported road regions work offline. A Mapillary authentication, quota, WebGL, or coverage failure affects visualization only. If the token is rejected, verify that it is the application's client token, edit `.env`, rerun the launcher, and reload the driver window. Missing BMS feedback blocks propulsion; stale controller commands cause the brake watchdog to request a controlled stop. A failed brake ECU can prevent that stop.

Ports bind to localhost by default. For access through the machine's hostname, set `SDV_WEB_BIND=0.0.0.0` in `.env` and run `docker compose up -d --no-deps web`. In an Administrator PowerShell window, run `.\scripts\Enable-DashboardFirewall.ps1` to allow inbound TCP 8080. Open `http://HOSTNAME:8080`; the web server also proxies the API and instrument panel, so ports 8000 and 8081 can remain local. ECU, broker and storage services have no published ports. This is a trusted personal lab; use remote access only on a network you trust.
