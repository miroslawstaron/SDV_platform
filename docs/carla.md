# CARLA city scenario

Start with `Start-Sdv.cmd`, then open [the engineering dashboard](http://localhost:8080) or [the CARLA portal](http://localhost:8080/carla). CARLA is now the default simulator and visual source. No Mapillary token, OpenStreetMap download or tile server is used for CARLA drives.

Choose **Start city drive** in the portal or **Start drive** in engineering. A drive owns one CARLA world; both controls use the same run API and a second active drive is rejected. **Stop** also works while the world is loading, with cleanup after the current CARLA operation returns.

- **Engineering dashboard:** true and reported speed, ECU health, fault injection, raw CAN/SOME/IP communication, architecture, sequence diagram, recording, replay and exports.
- **Driver’s view:** independent vehicle instruments on the left and CARLA’s first-person RGB camera on the right, with a small map of actual CARLA roads and actor positions.
- **CARLA portal:** a chase camera attached to the ego car, city overview, pedestrians, traffic, speed, simulation time, battery estimate, run selector and replay slider. Windows can be closed independently without stopping the drive.

The bundled preset uses **Town10HD_Opt**, a Tesla Model 3 ego car, a roughly 500 m connected waypoint route, up to **48 walking pedestrians**, **eight traffic vehicles**, clear daytime weather and a **25 km/h** target limit. Spawn failures reduce the actual population; the portal reports actual counts after startup. Walkers are preferentially placed near the route and use CARLA walker AI. Other cars use CARLA Traffic Manager. The ego car does not use autopilot: propulsion and braking are applied from the powertrain and brake ECU CAN frames. The plant implements waypoint steering in the prepared lane; manual lane changes are rejected and recorded. Its route has no arbitrary geographic start/destination picker.

The sensor ECU publishes `ObstacleDistance` and `PedestrianHazard` in the existing 32-byte `Sensors` frame. A walker ahead within a 3 m lateral corridor constrains the controller’s stopping distance. These are simple simulation perception signals, not a validated autonomous-driving perception system. Existing traffic-light and destination stopping logic remains active. Collision events are recorded. The battery is an explicitly estimated EV model using vehicle mass, aerodynamic drag, rolling resistance, auxiliary load and propulsion/regeneration efficiencies; CARLA does not supply these battery measurements.

## Runtime and rendering

The default Windows launcher downloads the official [CARLA 0.9.16 Windows release](https://github.com/carla-simulator/carla/releases/tag/0.9.16) to `%LOCALAPPDATA%/SDV/CARLA/0.9.16`, extracts it once, and starts its shipping executable with **Vulkan on the NVIDIA GPU** (`-vulkan -preferNvidia`). It creates a hidden window surface: `-RenderOffScreen` fails with `VK_ERROR_SURFACE_LOST_KHR` in this Windows Vulkan build. Sound is disabled. The launcher prepares Microsoft’s signed legacy DirectX dependency DLLs beside the executable without a system-wide installer; these dependencies do not select the rendering API. The first launch needs a 7.3 GiB download; interrupted downloads resume.

The SDV services stay in Docker. The CARLA SDK runs beside the Windows simulator, using loopback ports 2000 and 2001 so raw camera images never cross Docker Desktop's slower host connection. `scripts/Start-CarlaClient.ps1` uses Windows Python 3.12 (`py -3.12`) and creates an isolated environment at `%USERPROFILE%/.sdv/carla-client-0.9.16`. It installs the SDK wheel bundled with the simulator and a small set of pinned service/image dependencies without changing global Python packages. The native client listens only on `127.0.0.1:2003`.

Docker's `carla-client` service sends control/state requests to that bridge via `host.docker.internal:2003` and receives JPEGs on a separate background connection. Images retain JPEG quality 93 and 4:4:4 chroma sampling. Bounded queues keep camera transfers out of the simulation tick without allowing unbounded image backlogs. The Docker bridge writes the usual `/data/carla` archive and pairs frames with recorded state for the shared pHash library. The plant still uses `/data/carla-service.sock`; CAN, SOME/IP, ECU logic, and recorder transactions remain in Docker. The simulation clock stays at 50 ms per tick. The native cameras capture at 10 Hz; browsers poll every 100 ms, skip overlapping requests, and use ETags to receive HTTP 304 without another JPEG download when the frame is unchanged. The server viewport remains 640×360, camera motion blur is disabled, and timestamps identify any camera lag. Camera archives grow at twice the previous 5 Hz rate. The live display may skip intermediate frames, while the camera archive retains them.

The engineering dashboard and CARLA portal have **Graphics quality** (Low / High) and **Preview resolution** (720p / 1080p) controls. Defaults remain High and 1080p. Choices are remembered in this browser and shared between its open dashboard windows. Choose them before starting a drive; they are disabled during that drive. Each recording stores its own `configuration.carla`, and the driver view shows the settings used. Rerun configuration preserves the recorded choices. Preview resolution sets both camera sensors to 1280×720 or 1920×1080, including their saved camera frames and driver-image captures; replay retains the original images.

With the native Windows runtime, High launches CARLA's Epic preset and Low launches its Low preset. The monitor restarts a warm server when the next drive requests a different preset and acknowledges readiness for that specific drive before the SDV client connects. The API needs `CARLA_RUNTIME=windows` (the Compose default) for this handshake. The optional Docker server's graphics preset is still selected by its Compose startup command; dashboard graphics selection requires the Windows monitor.

The Windows launcher also starts a small background monitor. After a drive finishes or is stopped, it closes both the native CARLA server and native SDK service after 10 idle seconds, releasing scene RAM, GPU allocations and client processes. Each completed drive also discards the SDK worker's native Traffic Manager connections before the server goes idle. Starting another CARLA drive automatically launches both services again; scene startup takes several seconds. Replay uses saved images and does not start CARLA. If the API is unreachable, the monitor leaves an existing server alone until it can verify that no drive is active. `scripts/Stop-Sdv.ps1` stops the server, client and monitor. Monitor events and client stdout/stderr logs are under `%LOCALAPPDATA%/SDV/CARLA/0.9.16`.

For the older Linux SDK path with a native Windows server, set `CARLA_CLIENT_RUNTIME=linux` in `.env` and recreate `api` and `carla-client`. This retains the raw camera transfer overhead and 5 Hz capture rate. The optional native-Docker server configuration below automatically selects the Linux SDK instead of the Windows bridge.

The original `carlasim/carla:0.9.16` image is retained under the optional `carla-docker` Compose profile, with NVIDIA runtime, host networking, both NVIDIA variables set to `all`, offscreen rendering and no sound, following [CARLA’s Docker instructions](https://carla.readthedocs.io/en/0.9.16/build_docker/). It has no port mappings. On this Windows Docker Desktop installation the unmodified image fell back to CPU `lavapipe`. Tests with Mesa Dozen 25.2.8 and 26.2.5 exposed the RTX 4090 to Vulkan but failed loading Town10 with `VK_ERROR_DEVICE_LOST`; the active setup therefore uses Windows Vulkan directly. For a compatible Linux GPU host, set `CARLA_RUNTIME=docker`, `CARLA_HOST=127.0.0.1`, `CARLA_RENDERER=nvidia` and `COMPOSE_PROFILES=carla-docker`. For software diagnostics use `CARLA_RENDERER=software`. CARLA SDK work runs in an isolated child process so slow extension calls do not block health endpoints or the native transport adapter.

Only the SDV plant advances the synchronous CARLA world. Do not attach another client that ticks the same world. Stop a drive before restarting the simulator or replacing its backend. A seed controls requested actor choices, navigation sampling and Traffic Manager, but reproducibility also depends on CARLA physics and the server platform.

## Performance verification

Measurements on 2026-10-20 used the RTX 4090, Core Ultra 9 285K, seed 42, Town10HD, 48 pedestrians, eight traffic vehicles, the same graphics/resolution presets, and two repeats per preset. Times below cover 12 simulated seconds and exclude scene setup/cleanup:

| Preset | Previous wall time | Optimized wall time | Speedup |
| --- | ---: | ---: | ---: |
| High / 1080p | 33.56 s | 12.20 s | 2.75× |
| Low / 720p | 15.30 s | 12.24 s | 1.25× |

The optimized runs also doubled camera capture from 5 Hz to 10 Hz and retained 120 frames per camera. High/1080p world-tick p95 fell from about 758 ms to 10 ms. A separate High/1080p drive with driver and portal cameras open completed 20 simulated seconds in 20.55–20.63 wall seconds and retained 200 frames per camera. The live browser displayed roughly seven distinct full-HD frames per second across each camera, with unchanged frames returning 304. These are simulation-throughput measurements, not a claim of 60 FPS rendering. The orchestration loop intentionally paces the fixed 20 Hz simulation near real time.

A synthetic 64 MiB transfer measured 14.5 MiB/s into Docker versus 269.1 MiB/s within Windows. Moving raw camera traffic to Windows loopback, encoding JPEGs there, and transferring cameras independently removed the largest stalls. The recorder now retains its SQLite writer connection to avoid checkpointing the WAL on every tick; FULL synchronization and atomic state/event commits remain enabled. An application-specific NVIDIA maximum-power experiment changed clocks but did not improve throughput; that driver change was restored.

Every new run records `performance.stages` and `performance.carla` timing summaries in its metadata. Means/maxima cover the drive; percentile samples retain the most recent 2048 observations per stage. The native client drains bounded progress and frame queues, and camera writes still use atomic replacement. Reproduce the benchmark against an idle platform:

```powershell
docker compose run --rm --no-deps -v "${PWD}/artifacts:/bench" api python3 -m sdv.benchmark_carla --duration 12 --repeats 2 --output /bench/carla-benchmark.json
```

The benchmark saves run IDs, simulation/wall time, actor and frame counts, CAN/SOME/IP observations, and stage timings. Setup/cleanup time is reported separately. Session evidence is in `artifacts/carla-baseline.json`, `artifacts/carla-final.json`, and `artifacts/carla-performance-report.json`. Validation included 107 backend checks, ten browser tests, and four real CARLA acceptance cases covering both presets, replay, pHash capture, ECU transport, rain/night, and zero-actor scenarios.

## Scenarios from a text prompt

Both driving dashboards include **Your driving scenarios**. Expand **Describe a scenario from a text prompt**, enter a name and an English description, then choose **Preview scenario**. Review the settings and choose **Save & use scenario** before starting the drive. Saved scenarios can be selected, updated, copied with **Save as new**, or deleted. Choose **Default city** to return to the original preset. Graphics and camera resolution remain separate choices.

For example: “Drive in heavy rain at night with 12 pedestrians and 6 cars, at 25 km/h, for 500 m and 2 minutes.” The local interpreter supports pedestrian and traffic counts, speed caps (km/h or mph), requested route length (m, km or miles), duration (seconds or minutes), seed, clear/cloudy/wet/light rain/rain/heavy rain/fog, day/sunset/night, and normal/no/frequent pedestrian crossings. Counts range from 0–100 pedestrians and 0–40 traffic vehicles, speed caps from 5–80 km/h, route lengths from 100–2000 m, and time budgets from 1–900 seconds. Road speed limits can further reduce speed. Requested counts can be lower when spawning fails, and the connected lane route can be shorter than requested.

This is a bounded English interpreter, with no external model, API key, code generation, or prompt execution. The preview lists unrecognized words; saving a partial interpretation requires **Use recognized settings only**. It does not generate named destinations, custom maps, scripted turns, or precisely timed actor maneuvers. Crossing frequency adjusts CARLA's pedestrian crossing factor rather than scheduling a crossing. [CARLA weather](https://carla.readthedocs.io/en/0.9.16/python_api/#carla.WeatherParameters) changes scene appearance; tire grip is unchanged. Night and sunset scenarios enable vehicle position lights and low beams.

The library persists in `/data/driving-scenarios.sqlite` on `sdv-data`. The selected template is remembered in the browser. Every recording stores an immutable `configuration.scenario` copy with its prompt and interpreted settings. Editing or deleting the template never changes existing recordings; **Rerun configuration** uses the recorded copy. The recorded scenario appears in both dashboards, and the driver view shows its name. Replay remains tied to the recorded images and vehicle state.

```text
GET    /api/v1/scenarios
POST   /api/v1/scenarios/preview       {"name":"Rain at night","prompt":"12 pedestrians, 6 cars, rain at night, 25 km/h, 500 m, 2 minutes"}
POST   /api/v1/scenarios               {"name":"Rain at night","prompt":"12 pedestrians, 6 cars, rain at night, 25 km/h, 500 m, 2 minutes"}
PUT    /api/v1/scenarios/{id}          {"name":"Rain at night","prompt":"8 pedestrians, 4 cars, rain at night"}
DELETE /api/v1/scenarios/{id}
POST   /api/v1/runs                   {"route_id":"carla-city","scenario_id":"SCENARIO_ID","carla":{"graphics":"low","resolution":"720p"}}
```

## Recording and replay

Both camera sensors save JPEG frames under `/data/carla/RUN_ID/driver` and `chase` on the same persistent `sdv-data` volume. Timestamps are relative to that drive’s simulation origin. Vehicle and actor state is recorded through the existing recorder. Replay chooses the latest camera frame **at or before** the replay cursor; before the first frame, the viewer explicitly waits. It never substitutes frames from another drive or a future time. Images can lag telemetry because CARLA camera sensors render asynchronously. Closing the browser does not stop camera capture.

Camera files are separate from JSONL/CSV telemetry exports. Removing a recording through the dashboard also removes that recording’s CARLA camera archive. The first driver-camera frame at each 25 m station enters the existing shared pHash library automatically, even with every browser closed. Similarity percentages, match counts and the five-match warning appear in the independent instruments, engineering dashboard and CARLA portal. The image similarity dashboard shows CARLA captures alongside retained Mapillary captures and uploaded references. Each drive/station counts once; chase frames and replay do not add observations. Full screen on either camera enlarges its original resolution. Per-drive preview resolution takes precedence over `CARLA_CAMERA_WIDTH` and `CARLA_CAMERA_HEIGHT`, which remain fallbacks for legacy clients without rendering settings. To restore missing comparisons from earlier retained CARLA recordings, run `docker compose exec -T api python3 -m sdv.carla_imagery --backfill`; this is idempotent and skips active drives. Older SUMO/Mapillary recordings and their existing viewers remain readable; set `SIMULATOR_BACKEND=sumo` to expose the legacy route picker for new SUMO experiments.

The preset is in `scenarios/carla-city.json`. API access:

```text
GET  /api/v1/config
GET  /api/v1/carla/status
POST /api/v1/runs                       {"route_id":"carla-city"}
POST /api/v1/runs                       {"route_id":"carla-city","carla":{"graphics":"low","resolution":"720p"}}
POST /api/v1/runs/{id}/start
POST /api/v1/runs/{id}/stop
GET  /api/v1/runs/{id}/carla/camera/driver
GET  /api/v1/runs/{id}/carla/camera/chase?at=5.0
POST /api/v1/runs/{id}/replay           {"at":5.0}
```
