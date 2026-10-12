# ECU and simulator extension guide

## Replace a reference application

Each worker starts the native adapter, then an application subprocess using `APPLICATION_COMMAND`. The supervisor sends a JSON line containing:

```json
{
  "sequence": 42,
  "vehicle": {"max_accel": 2.5, "normal_decel": 3, "max_speed": 36.111},
  "network": {
    "frames": {"256": {"age": 0.002, "signals": {"Speed": 10.0}}},
    "intent": {"version": 1, "sequence": 42, "target_speed": 12.0, "lane_request": 0},
    "intent_age": 0.002,
    "available": true
  },
  "lane_request": 0
}
```

The actual vehicle profile and decoded DBC signals contain all declared fields. `age` is seconds since observed reception, not producer simulation time. Treat inputs older than 0.2 seconds as stale. The sensor, navigation, and BMS roles also receive `truth`, containing simulator state; controllers and actuator ECUs do not.

`truth.route_lane_offset` reports the signed offset from the current lane to a lane that continues along the prepared route: positive means left, negative means right, and zero means no change. It is zero inside junctions. The reference navigation application requests one adjacent lane per tick through SOME/IP `intent.lane_request`, unless a nonzero manual `lane_request` is present. The controller forwards this through CAN to the lane ECU. SUMO's automatic lane changes remain disabled, so replacing or failing the navigation, controller, or lane application can still affect whether the vehicle follows a turn.

Scenario `modules` accepts a configuration object per role, for example `"modules": {"controller": {"my_gain": 0.8}}`. The supervisor delivers that role's object as `configuration` in each tick. Interpretation belongs to the replaceable application. GET `/api/v1/modules` exposes validated reference manifests.

A controller returns:

```json
{"can": [[512, {"Acceleration": 1.0, "Deceleration": 0.0, "LaneRequest": 0, "TargetSpeed": 12.0, "Sequence": 42}]]}
```

Native transport emission happens after configured adapter faults. Navigation returns an `intent` object matching the SOME/IP catalog. The supervisor requires a response within one second; a hung application is terminated and its failure is recorded. The platform continues observing the network, allowing peer watchdogs to react.

## Custom image

```dockerfile
FROM sdv-native:local
COPY my-controller.py /app/my-controller.py
ENV APPLICATION_COMMAND="python3 /app/my-controller.py"
```

```yaml
# compose.custom.yaml
services:
  controller:
    image: my-controller:1.0
    environment:
      APPLICATION_COMMAND: python3 /app/my-controller.py
```

```powershell
docker build -t my-controller:1.0 -f MyController.Dockerfile .
docker compose -f compose.yaml -f compose.custom.yaml up -d controller
```

Keep the standard supervisor entrypoint and health endpoint. Keep transport layouts compatible or version both the catalog and every affected participant. `contracts/modules.json` documents publishers, consumers, commands, and endpoints; changing the executable/image does not require edits to platform source. Extra roles beyond the seven reference slots require registering their orchestration phase in the API and adding their Compose service.

For direct gRPC access, use `sdv.sdk.Transport` in Python or `native/sdk.hpp` in C++. Generate protobuf C++ bindings with the supplied CMake target. CAN bytes can be generated from the DBC using `cantools generate_c_source`; keep physical-unit conversion and stale checks in your application. Avoid writing to stdout except for the supervisor contract.

## New simulator

Implement `SimulatorBackend` in `backend/sdv/simulator.py`, covering capabilities, route validation, world load, spawn, actuator application, step advancement, state retrieval, and shutdown. The platform operates on geography, speed, lane intent, battery state, and applied acceleration/deceleration. Expose backend-specific capabilities when steering, sensors, or maps differ.

A later CARLA backend needs explicit matching between prepared routes and available CARLA worlds. It cannot assume arbitrary OSM streets can be rendered unchanged. Mapillary remains an optional location visualization independent of the simulator.

## Imagery adapter

`web/src/mapillary.ts` implements a bounded 50 m Graph API bounding-box lookup, metadata normalization, same-road filtering and camera-heading selection. Search fields include corrected GPS and compass angle where available. Panoramas are preferred; ordinary photographs must face within 60° of the vehicle. A bounded query considers up to 1,000 nearby images. Geometry filtering rejects imagery beyond 50 m from the route station or 20 m from the route; this is a proximity heuristic and cannot prove matching road identity at crossings or parallel roads.

`web/src/mapillaryViewer.ts` wraps the official MapillaryJS viewer with `moveTo`, a heading method, and disposal. Panorama heading changes use the current SDK camera bearing and normalized image center, respecting its image orientation rather than assuming every panorama's center faces north. Ordinary photos retain their captured camera view. Direction and sequence navigation controls are disabled so users cannot accidentally move imagery away from the simulated car; pan/zoom remains available and automatically releases follow mode. The SDK's attribution component stays enabled.

`web/src/imageryRoute.ts` clips the road geometry to the snapped endpoints, then samples it at every 25 m of the route's driving distance. The authoritative remaining distance selects the interval with `floor((route.distance - remaining) / 25)`, including reverse replay; proximity to a past road segment cannot cause a false switch on loops. A final partial interval keeps its preceding image.

`web/src/imageryPreload.ts` prepares all sampled points in the background, prioritizing the current and future points. It limits nearby-image searches to one per second, allows two preload jobs, retries transient failures at most three times, honors rate limits, and stops requests when a token is rejected. Image positions returned by the SDK are checked against the sampled point before marking assets ready.

`web/src/mapillaryViewer.ts` supplies a shared `GraphDataProvider` subclass that coalesces metadata, image-buffer, mesh and geometry-cell requests. Image buffers use a 64 MiB LRU memory cache; metadata, meshes and cells have bounded entry counts. Actual thumbnail bytes are downloaded during preload, not merely image IDs or metadata. Three official viewers decode and render the current and next two frames offscreen. High-resolution progressive tiles are disabled. At a distance boundary `Driver.tsx` switches which prepared canvas is visible, preserving attribution and independent look-around controls. Delayed earlier loads can populate their cache entry but cannot replace the current interval's displayed image. Replay reuses cached entries, and viewer loading is bounded and cancelled on disposal.

`Driver.tsx` subscribes independently to ground truth and the shared replay cursor. No ECU or simulation step waits for preloading. A missing, failed or not-yet-rendered point uses the location map. Unlike the earlier moving-lookup policy, the selected image stays in place for a full 25 m interval; the live car-to-image offset may exceed the 50 m selection radius. Heading tracking continues for panoramas. Search uses a browser client token in the Authorization header; the SDK authorizes its own resources. Caches remain in browser memory and are cleared when the driver window closes. No provider imagery or token enters the recording database.

## Scenario API

```json
{
  "route_id": "gothenburg-demo",
  "seed": 42,
  "duration": 30,
  "vehicle": {"charge_pct": 80},
  "faults": [{"module": "sensor", "kind": "drop", "at": 5, "duration": 3}],
  "assertions": [{"kind": "max_speed", "value": 15}, {"kind": "no_recorder_loss"}]
}
```

POST to `/api/v1/runs`, then POST `/api/v1/runs/{id}/start`. Scenario fault timing is simulation time; transport delay is wall time. Message faults filter CAN publishes or SOME/IP navigation intent notifications, optionally by `message_id`. Native SOME/IP diagnostic request/response exchanges remain observable; use service withdrawal to test loss of the complete service. Substitution and freezing filter a named physical signal. Direct ECU process stop and SOME/IP withdrawal are distinct fault types. Export recordings to compare behavior across images and configurations.

## Inspect and export communication

`GET /api/v1/contracts` combines the versioned catalog with signal names, units, per-signal DBC receivers, and VSS mappings. The architecture view uses these contracts rather than duplicating signal definitions in browser code. Message consumers identify functional consumption; all participants can still observe a CAN broadcast.

`GET /api/v1/runs/{id}/timeline?at=2.5&window=0.05` returns ground truth and **all recorded observations** in the inclusive interval `[2.45, 2.5]`. The diagram orders these by recorder event ID within simulation time; it does not compare native clocks across participants. Wider windows can contain more than the 120 diagram rows shown: use node/transport filters or export to inspect everything. Native `monotonic_ns` is monotonic time with an unspecified epoch, local to each adapter; control events from the orchestrator use its own monotonic clock.

Exports stream a consistent SQLite read snapshot, including during an active simulation:

- `GET /api/v1/runs/{id}/export?format=jsonl`: metadata/configuration, every ground-truth state, and every raw event, including faults and health.
- `GET /api/v1/runs/{id}/export?format=csv`: one row per event, preserving raw and complete decoded payloads.
- `GET /api/v1/runs/{id}/export?format=signals`: one row per decoded CAN/SOME/IP signal observation, with endpoints, direction, sequence, physical value, units, and VSS mapping. Download filename: `{id}.signals.csv`.

In the signal CSV, CAN TX has destination `CAN bus`; CAN RX has the actual observing module as destination. Do not treat a broadcast TX as proof that every intended consumer received it. A TX and its observed receptions have distinct event IDs; match protocol/message ID, sequence, raw payload, and nearby simulation time when studying delivery. Duplicated messages and repeated receptions remain in exports. Payloads that cannot be decoded remain in the raw event exports. The export endpoints have no event-page limit; `GET /events?after=...&limit=5000` is separately paginated. Downloads during a run contain only the snapshot so far; download after completion for the full result.

## Replace the driver instrument component

`instruments` is an observer service, separate from the engineering/imagery web image. Its display URL is `/?run={run_id}`, health URL is `/health`, and read-only subscriptions are `GET /api/v1/runs/{run_id}` and `WebSocket /api/v1/runs/{run_id}/stream`. The stream contains `run`, authoritative `state`, and replay packets; both viewers subscribe independently to the server's cursor. See `instruments/manifest.json`. A replacement image must expose port 80, serve its assets under relative URLs so `/instruments/` works, and proxy `/api/` to `api:8000` including WebSocket upgrades. Swap `services.instruments.image` in a Compose override and recreate that service. No CAN/ECU changes are needed.

The reference display is plain HTML/CSS/JavaScript under `instruments/public`, with no separate npm dependency tree. `web/src/Brand.tsx` and `web/src/metriczone.css` supply the common Metriczone identity. The original logo is `web/public/assets/metriczone-logo.png`; Docker copies that unchanged into both images. The reveal.js deck is editable HTML at `web/public/presentation/index.html`, with locally vendored reveal.js 6.0.2 runtime and license.
