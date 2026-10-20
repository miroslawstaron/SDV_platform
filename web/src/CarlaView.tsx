import {useEffect,useRef,useState} from 'react';
import {api,useStream} from './api';
import {Brand} from './Brand';
import {ImageSimilarity} from './ViewSimilarity';
import {imageStationIndex} from './imageryRoute';
import {CarlaSettings,CarlaRenderingSummary,useCarlaRendering} from './CarlaSettings';
import {DrivingScenarios,RecordedScenario,useDrivingScenario} from './DrivingScenarios';
import type {Packet,Route,Run,VehicleState,XY} from './types';
import './carla.css';

export function CarlaMap({route,state}:{route?:Route;state?:VehicleState|null}){
 const roads=route?.carla_roads||[],path=route?.carla_geometry||[];
 const points=[...roads.flat(),...path];
 if(!points.length)return <div className="carla-map carla-await"><span className="carla-city-icon">▥</span><h3>Town10 · City streets</h3><p>Start the city drive to load CARLA’s roads and live actors.</p><span>Population and speed follow the selected drive scenario.</span></div>;
 const minX=Math.min(...points.map(p=>p.x))-20,minY=Math.min(...points.map(p=>p.y))-20;
 const width=Math.max(100,Math.max(...points.map(p=>p.x))-minX+20),height=Math.max(100,Math.max(...points.map(p=>p.y))-minY+20);
 const line=(p:XY[])=>p.map(v=>`${v.x},${v.y}`).join(' ');
 return <div className="carla-map"><svg viewBox={`${minX} ${minY} ${width} ${height}`} role="img" aria-label="CARLA city map with live vehicle and pedestrian positions">
  <rect x={minX} y={minY} width={width} height={height} fill="#eaf2ef"/>
  {roads.map((road,i)=><polyline key={i} points={line(road)} fill="none" stroke="#bbc9c6" strokeWidth="7" strokeLinecap="round"/>)}
  <polyline points={line(path)} fill="none" stroke="#07866d" strokeWidth="3.5" strokeLinejoin="round"/>
  {path.length>0&&<><circle cx={path[0].x} cy={path[0].y} r="4" fill="#07866d"/><circle cx={path[path.length-1].x} cy={path[path.length-1].y} r="4" fill="#c8772b"/></>}
  {state?.carla_actors?.map(actor=><circle key={actor.id} cx={actor.x} cy={actor.y} r={actor.kind==='pedestrian'?2:3} fill={actor.kind==='pedestrian'?'#bd6726':'#617b8d'}><title>{actor.kind} {actor.id}</title></circle>)}
  {state?.carla_x!==undefined&&<g transform={`translate(${state.carla_x} ${state.carla_y}) rotate(${state.carla_yaw||0})`}><circle r="7" fill="#fff" opacity=".8"/><path d="M7 0L-5 -4L-3 0L-5 4Z" fill="#006b58"/></g>}
 </svg><div className="carla-map-key"><span>● Ego & route</span><span>● Pedestrians</span><span>● Traffic</span><small>CARLA road topology · no external map</small></div></div>;
}

export function CarlaCamera({id,view,at,live=true}:{id:string;view:'driver'|'chase';at?:number;live?:boolean}){
 const [source,setSource]=useState(''),[stamp,setStamp]=useState<number>(),[error,setError]=useState(''),[age,setAge]=useState(0),[dimensions,setDimensions]=useState('');
 const camera=useRef<HTMLDivElement>(null);
 const url=useRef(''),updated=useRef(0),lastStamp=useRef('');
 useEffect(()=>{
  let dead=false,busy=false,etag='';const controller=new AbortController();
  const refresh=async()=>{if(busy||dead)return;busy=true;try{
   const response=await fetch(`/api/v1/runs/${encodeURIComponent(id)}/carla/camera/${view}${!live&&at!==undefined?`?at=${at}`:''}`,{signal:controller.signal,cache:'no-store',headers:etag?{'If-None-Match':etag}:{}});
   if(response.status===304){setError('');return}
   if(!response.ok)throw new Error('Waiting for a camera frame at this simulation time');
   const blob=await response.blob();if(dead)return;
   etag=response.headers.get('ETag')||'';
   const next=URL.createObjectURL(blob);if(url.current)URL.revokeObjectURL(url.current);url.current=next;
   const timestamp=response.headers.get('X-CARLA-Simulation-Time')||'';
   setSource(next);setStamp(Number(timestamp));setError('');if(timestamp!==lastStamp.current){lastStamp.current=timestamp;updated.current=Date.now();}
  }catch(e){if(!dead)setError((e as Error).message)}finally{busy=false}};
  if(!live){setSource('');setStamp(undefined)}
  refresh();const timer=setInterval(()=>{if(live)refresh();setAge(updated.current?(Date.now()-updated.current)/1000:0)},100);
  return()=>{dead=true;controller.abort();clearInterval(timer)};
 },[id,view,live,live?undefined:at]);
 useEffect(()=>()=>{if(url.current)URL.revokeObjectURL(url.current)},[]);
 return <div className="carla-camera" ref={camera} data-testid={`carla-camera-${view}`}>
  {source?<img src={source} onLoad={e=>setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} alt={`CARLA ${view==='driver'?'first-person driver':'third-person chase'} camera`}/>:<div className="carla-camera-wait"><span className="camera-pulse"/><strong>{error||'Preparing CARLA camera…'}</strong><p>The scene loads on the simulator. This view updates when a rendered frame arrives.</p></div>}
  <div className="carla-camera-label"><span>{view==='driver'?'DRIVER CAMERA':'CHASE CAMERA'}{dimensions&&` · ${dimensions}`}</span><span>{stamp!==undefined?`${stamp.toFixed(2)} s · ${live?'LIVE':'RECORDING'}`:'WAITING'}</span><button aria-label={`Enlarge ${view} camera`} onClick={()=>{const action=document.fullscreenElement?document.exitFullscreen():camera.current?.requestFullscreen();action?.catch(()=>setError('Full screen unavailable in this window'))}}>⛶ Full screen</button></div>
  {source&&(error||(live&&age>10))&&<div className="carla-frame-note">{error||`Last image received ${age.toFixed(0)} seconds ago · simulator rendering slowly`}</div>}
 </div>;
}

export function CarlaDriver({id,run,state,connected,replaying}:{id:string;run:Run;state:VehicleState|null;connected:boolean;replaying:boolean}){
 return <div className="driver-shell"><header><Brand subtitle="DRIVER’S VIEW"/><span className={`pill ${connected?'good':''}`}>{connected?'Connected':'Reconnecting'}</span><nav className="driver-nav"><a href={`/carla?run=${id}`} target="_blank" rel="noreferrer">CARLA portal ↗</a><a href="/" target="_blank" rel="noreferrer">Engineering dashboard ↗</a></nav></header>
 <main className="driver-stage"><section className="instrument-pane" aria-label="Vehicle instrument dashboard"><iframe title="Vehicle instrument dashboard" src={`/instruments/?run=${id}`}/><a className="instrument-link" href={`/instruments/?run=${id}`} target="_blank" rel="noreferrer">Open instruments separately ↗</a></section>
 <section className="driver-scene carla-driver-scene" aria-label="CARLA first-person driver view"><CarlaCamera id={id} view="driver" live={['running','starting'].includes(run.status)&&!replaying} at={state?.time}/><div className="carla-driver-map"><CarlaMap route={run.route} state={state}/></div><div className="carla-driver-status"><span>{state?.pedestrian_hazard?'⚠ Pedestrian ahead · braking':`${state?.pedestrian_count??run.route.scenario?.pedestrians??48} pedestrians in the city`}</span><span>{run.status} · {(state?.time||0).toFixed(2)} s</span></div></section></main>
 <footer>{run.configuration.scenario&&<span title={run.configuration.scenario.prompt}>Scenario: {run.configuration.scenario.name} · </span>}<CarlaRenderingSummary value={run.configuration.carla}/> · Live CARLA scenery and actors · Instruments use the same recorded vehicle state as the engineering dashboard · EV battery values are estimated.</footer></div>;
}

export function CarlaPortal(){
 const [carlaRendering,setCarlaRendering]=useCarlaRendering();
 const [drivingScenario,setDrivingScenario]=useDrivingScenario();
 const [id,setId]=useState(new URLSearchParams(location.search).get('run')||''),[run,setRun]=useState<Run>(),[state,setState]=useState<VehicleState|null>(null),[status,setStatus]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[replaying,setReplaying]=useState(false),[history,setHistory]=useState<Run[]>([]);
 const connected=useStream(id||undefined,(packet:Packet)=>{if(packet.run.route)setRun(packet.run);else setRun(old=>old?{...old,...packet.run}:old);if(packet.state)setState(packet.state);setReplaying(packet.type==='replay')});
 const loadHistory=()=>api<Array<{id:string}>>('/runs?summary=true').then(async rows=>{const values=await Promise.all(rows.slice(0,30).map(row=>api<Run>(`/runs/${row.id}`)));setHistory(values.filter(value=>value.route.backend==='carla'))}).catch(e=>setError(e.message));
 useEffect(()=>{loadHistory();let dead=false;const refresh=()=>api('/carla/status').then(value=>{if(!dead)setStatus(value)}).catch(e=>{if(!dead)setError(e.message)});refresh();const timer=setInterval(refresh,4000);if(!id)api('/health').then(async health=>{if(health.active_run){const active=await api<Run>(`/runs/${health.active_run}`);if(active.route.backend==='carla')setId(active.id)}}).catch(e=>setError(e.message));return()=>{dead=true;clearInterval(timer)}},[]);
 useEffect(()=>{if(!id)return;setState(null);setRun(undefined);setReplaying(false);historyUpdate(id);api<Run>(`/runs/${id}`).then(setRun).catch(e=>setError(e.message))},[id]);
 const live=!!run&&['starting','running'].includes(run.status);
 async function start(){setBusy(true);setError('');try{const created=await api<Run>('/runs','POST',{route_id:'carla-city',vehicle:{charge_pct:80},carla:carlaRendering,scenario_id:drivingScenario?.id});setId(created.id);setRun(created);await api(`/runs/${created.id}/start`,'POST');setRun(old=>old?{...old,status:'starting'}:old);loadHistory()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function stop(){if(!id)return;try{await api(`/runs/${id}/stop`,'POST');setStatus((old:any)=>({...old,status:'stopping'}))}catch(e){setError((e as Error).message)}}
 const cameraLive=live&&!replaying;
 return <div className="dashboard carla-portal"><header><Brand subtitle="CARLA SIMULATION PORTAL"/><nav><a href="/">Engineering dashboard</a><span className="nav-active">CARLA world</span><a href="/management">Management</a></nav><span className={`pill ${connected?'good':''}`}>{id?(connected?'Connected':'Reconnecting'):'Ready'}</span></header>
 <main><div className="page-title"><div><div className="eyebrow">CITY SCENARIO / TOWN10HD</div><h1>A city in motion.</h1><p>See the car, the people, and the decisions behind the drive.</p></div><div className="title-actions"><button className="primary" disabled={live||busy} onClick={start}>{busy?'Starting…':'▶ Start city drive'}</button><button disabled={!live} onClick={stop}>■ Stop</button>{id&&<a className="carla-link-button" href={`/driver/${id}`} target="_blank" rel="noreferrer">Open driver’s view ↗</a>}</div></div>
 {error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
 <DrivingScenarios value={live?run?.configuration.scenario:drivingScenario} onChange={setDrivingScenario} disabled={live||busy}/>
 <RecordedScenario value={run?.configuration.scenario}/>
 <CarlaSettings value={live&&run?.configuration.carla?run.configuration.carla:carlaRendering} onChange={setCarlaRendering} disabled={live||busy}/>
 {run?.configuration.carla&&<div className="carla-run-rendering">Selected drive: <CarlaRenderingSummary value={run.configuration.carla}/></div>}
 <div className={`carla-notice ${status?.renderer==='software'?'':'ready'}`}><span className="carla-notice-dot"/><span><strong>{status?.status==='populating'?'Building the city scene':status?.status==='connecting'?'Connecting to CARLA':status?.renderer==='software'?'Software rendering · slower than real time':'CARLA city simulation'}</strong> · Simulation time and camera timestamps stay visible. {status?.notice}</span></div>
 <div className="carla-portal-grid"><section className="card carla-world-panel"><div className="section-heading"><h2>01 <span>Inside the simulation</span></h2><span className="pill">{run?.status?.toUpperCase()||'READY'}</span></div>{id?<CarlaCamera id={id} view="chase" at={state?.time} live={cameraLive}/>:<div className="carla-empty-world"><span>CARLA / TOWN10HD</span><h2>People. Crossings. City traffic.</h2><p>{drivingScenario?`${drivingScenario.name} · ${drivingScenario.settings.pedestrians} pedestrians · ${drivingScenario.settings.traffic_vehicles} vehicles`:'One electric car, 48 walking pedestrians and eight surrounding vehicles.'}</p><button className="primary" onClick={start} disabled={busy}>Start city drive</button></div>}<div className="carla-world-caption"><span>Third-person camera attached to the SDV car</span><a href="/">Inspect CAN & SOME/IP ↗</a></div></section>
 <section className="card carla-traffic-panel"><div className="section-heading"><h2>02 <span>City overview</span></h2><span className="tiny-label">ACTUAL ACTOR POSITIONS</span></div><CarlaMap route={run?.route} state={state}/></section></div>
 <div className="carla-stat-grid">{[['VEHICLE SPEED',`${((state?.speed||0)*3.6).toFixed(1)} km/h`],['PEDESTRIANS',String(state?.pedestrian_count??run?.route.scenario?.pedestrians??drivingScenario?.settings.pedestrians??48)],['TRAFFIC VEHICLES',String(state?.traffic_count??run?.route.scenario?.traffic_vehicles??drivingScenario?.settings.traffic_vehicles??8)],['SIMULATION TIME',`${(state?.time||0).toFixed(2)} s`],['PEDESTRIAN RESPONSE',state?.pedestrian_hazard?'Yielding':'Monitoring'],['BATTERY · ESTIMATED',`${(state?.charge_pct??80).toFixed(1)} %`]].map(([label,value])=><div className="card" key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
 <ImageSimilarity runId={id||undefined} index={run?imageStationIndex(state,run.route):0}/>
 {id&&<p className="carla-similarity-link">Driver-camera captures every 25 m · <a href={`/image-similarity?run=${id}`} target="_blank" rel="noreferrer">Inspect captured images & comparisons ↗</a></p>}
 <section className="card carla-session"><div className="section-heading"><h2>03 <span>Drive & recording</span></h2><span>{run?run.id.slice(0,8):'No drive selected'}</span></div><div className="carla-session-controls"><select aria-label="CARLA recording" value={id} onChange={e=>setId(e.target.value)}><option value="">Choose a CARLA drive</option>{run&&!history.some(value=>value.id===id)&&<option value={id}>{id.slice(0,8)} · {run.status}</option>}{history.map(value=><option key={value.id} value={value.id}>{value.id.slice(0,8)} · {value.status}</option>)}</select><label>Replay time<input aria-label="CARLA replay time" type="range" min="0" max={run?.time||1} step=".05" value={state?.time||0} disabled={!run||live} onChange={e=>api(`/runs/${id}/replay`,'POST',{at:Number(e.target.value)}).catch(e=>setError(e.message))}/></label><span>{(state?.time||0).toFixed(2)} s</span><button onClick={loadHistory}>Refresh recordings</button></div>{run?.error&&<p className="carla-error" role="alert">{run.error}</p>}<p>Camera frames and actor positions follow the recorded simulation time during replay. The engineering dashboard, independent instruments and driver window share this drive.</p></section>
 <div className="carla-about"><div><h3>The vehicle stays on the test bench.</h3><p>The SDV controller commands propulsion and braking over CAN. CARLA handles physics, route steering, collisions, traffic lights, pedestrians and cameras. Pedestrians in the driving corridor are reported by the sensor ECU and the controller slows or stops.</p></div><div><h3>Designed for this machine.</h3><p>The native Windows server uses Vulkan on the RTX 4090. Two recorded cameras show the same town as the SDV vehicle physics. Battery and energy readings use an explicit EV estimate. Frame timestamps distinguish rendering from simulation progress.</p></div></div>
 </main><footer>Metriczone · CARLA 0.9.16 · Town10HD simulated city · Cameras, road topology and actors from CARLA</footer></div>;
}

function historyUpdate(id:string){const url=new URL(location.href);url.searchParams.set('run',id);window.history.replaceState(null,'',url)}
