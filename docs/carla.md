# CARLA city scenario

Start with `Start-Sdv.cmd`, then open [the engineering dashboard](http://localhost:8080) or [the CARLA portal](http://localhost:8080/carla). CARLA is now the default simulator and visual source. No Mapillary token, OpenStreetMap download or tile server is used for CARLA drives.

Choose **Start city drive** in the portal or **Start drive** in engineering. A drive owns one CARLA world; both controls use the same run API and a second active drive is rejected. **Stop** also works while the world is loading, with cleanup after the current CARLA operation returns.

- **Engineering dashboard:** true and reported speed, ECU health, fault injection, raw CAN/SOME/IP communication, architecture, sequence diagram, recording, replay and exports.
- **Driver’s view:** independent vehicle instruments on the left and CARLA’s first-person RGB camera on the right, with a small map of actual CARLA roads and actor positions.
- **CARLA portal:** a chase camera attached to the ego car, city overview, pedestrians, traffic, speed, simulation time, battery estimate, run selector and replay slider. Windows can be closed independently without stopping the drive.

The bundled preset uses **Town10HD_Opt**, a Tesla Model 3 ego car, a roughly 500 m connected waypoint route, up to **48 walking pedestrians**, **eight traffic vehicles**, clear daytime weather and a **25 km/h** target limit. Spawn failures reduce the actual population; the portal reports actual counts after startup. Walkers are preferentially placed near the route and use CARLA walker AI. Other cars use CARLA Traffic Manager. The ego car does not use autopilot: propulsion and braking are applied from the powertrain and brake ECU CAN frames. The plant implements waypoint steering in the prepared lane; manual lane changes are rejected and recorded. Its route has no arbitrary geographic start/destination picker.

The sensor ECU publishes `ObstacleDistance` and `PedestrianHazard` in the existing 32-byte `Sensors` frame. A walker ahead within a 3 m lateral corridor constrains the controller’s stopping distance. These are simple simulation perception signals, not a validated autonomous-driving perception system. Existing traffic-light and destination stopping logic remains active. Collision events are recorded. The battery is an explicitly estimated EV model using vehicle mass, aerodynamic drag, rolling resistance, auxiliary load and propulsion/regeneration efficiencies; CARLA does not supply these battery measurements.

## Runtime and rendering

The default Windows launcher downloads the official [CARLA 0.9.16 Windows release](https://github.com/carla-simulator/carla/releases/tag/0.9.16) to `%LOCALAPPDATA%/SDV/CARLA/0.9.16`, extracts it once, and starts its shipping executable with **Vulkan on the NVIDIA GPU** (`-vulkan -preferNvidia`). It creates a hidden window surface: `-RenderOffScreen` fails with `VK_ERROR_SURFACE_LOST_KHR` in this Windows Vulkan build. Sound is disabled. The launcher prepares Microsoft’s signed legacy DirectX dependency DLLs beside the executable without a system-wide installer; these dependencies do not select the rendering API. No host Python is required. The first launch needs a 7.3 GiB download; interrupted downloads resume.

The SDV services and CARLA Python client stay in Docker. The native server listens on port 2000 and streams on 2001; the client uses `host.docker.internal`. The client service sends commands and state to the native plant through `/data/carla-service.sock` on the shared volume. Browser clients use only the existing SDV API proxy. The server viewport is 640×360, RGB cameras are 1920×1080 with high-quality JPEG encoding and motion blur disabled, and the simulation clock remains a fixed 50 ms per tick. Camera timestamps and slow-frame warnings distinguish rendering delays from simulation progress.

The Windows launcher also starts a small background monitor. After a drive finishes or is stopped, it closes the native CARLA server after 10 idle seconds, releasing the loaded scene's RAM and GPU allocations. Starting another CARLA drive automatically launches the server again; scene startup takes several seconds. Replay uses saved images and does not start CARLA. If the API is unreachable, the monitor leaves an existing server alone until it can verify that no drive is active. `scripts/Stop-Sdv.ps1` stops both the native server and this monitor. Monitor events are recorded in `%LOCALAPPDATA%/SDV/CARLA/0.9.16/sdv-watch.log`.

The original `carlasim/carla:0.9.16` image is retained under the optional `carla-docker` Compose profile, with NVIDIA runtime, host networking, both NVIDIA variables set to `all`, offscreen rendering and no sound, following [CARLA’s Docker instructions](https://carla.readthedocs.io/en/0.9.16/build_docker/). It has no port mappings. On this Windows Docker Desktop installation the unmodified image fell back to CPU `lavapipe`. Tests with Mesa Dozen 25.2.8 and 26.2.5 exposed the RTX 4090 to Vulkan but failed loading Town10 with `VK_ERROR_DEVICE_LOST`; the active setup therefore uses Windows Vulkan directly. For a compatible Linux GPU host, set `CARLA_RUNTIME=docker`, `CARLA_HOST=127.0.0.1`, `CARLA_RENDERER=nvidia` and `COMPOSE_PROFILES=carla-docker`. For software diagnostics use `CARLA_RENDERER=software`. CARLA SDK work runs in an isolated child process so slow extension calls do not block health endpoints or the native transport adapter.

Only the SDV plant advances the synchronous CARLA world. Do not attach another client that ticks the same world. Stop a drive before restarting the simulator or replacing its backend. A seed controls requested actor choices, navigation sampling and Traffic Manager, but reproducibility also depends on CARLA physics and the server platform.

## Recording and replay

Both camera sensors save JPEG frames under `/data/carla/RUN_ID/driver` and `chase` on the same persistent `sdv-data` volume. Timestamps are relative to that drive’s simulation origin. Vehicle and actor state is recorded through the existing recorder. Replay chooses the latest camera frame **at or before** the replay cursor; before the first frame, the viewer explicitly waits. It never substitutes frames from another drive or a future time. Images can lag telemetry because CARLA camera sensors render asynchronously. Closing the browser does not stop camera capture.

Camera files are separate from JSONL/CSV telemetry exports. Removing a recording through the dashboard also removes that recording’s CARLA camera archive. The first driver-camera frame at each 25 m station enters the existing shared pHash library automatically, even with every browser closed. Similarity percentages, match counts and the five-match warning appear in the independent instruments, engineering dashboard and CARLA portal. The image similarity dashboard shows CARLA captures alongside retained Mapillary captures and uploaded references. Each drive/station counts once; chase frames and replay do not add observations. Full screen on either camera enlarges its original resolution. Override `CARLA_CAMERA_WIDTH` and `CARLA_CAMERA_HEIGHT` to change the sensor resolution for new drives. To restore missing comparisons from earlier retained CARLA recordings, run `docker compose exec -T api python3 -m sdv.carla_imagery --backfill`; this is idempotent and skips active drives. Older SUMO/Mapillary recordings and their existing viewers remain readable; set `SIMULATOR_BACKEND=sumo` to expose the legacy route picker for new SUMO experiments.

The preset is in `scenarios/carla-city.json`. API access:

```text
GET  /api/v1/config
GET  /api/v1/carla/status
POST /api/v1/runs                       {"route_id":"carla-city"}
POST /api/v1/runs/{id}/start
POST /api/v1/runs/{id}/stop
GET  /api/v1/runs/{id}/carla/camera/driver
GET  /api/v1/runs/{id}/carla/camera/chase?at=5.0
POST /api/v1/runs/{id}/replay           {"at":5.0}
```
