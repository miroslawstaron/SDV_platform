import {useEffect,useRef,useState} from 'react';
import 'mapillary-js/dist/mapillary.css';
import {api,useStream} from './api';
import {MapView} from './MapView';
import {Brand} from './Brand';
import {CarlaDriver} from './CarlaView';
import {distance} from './geo';
import {imageMatches,nearbyImages} from './mapillary';
import type {StreetImage} from './mapillary';
import {createViewerGroup,moveToImage} from './mapillaryViewer';
import type {ImageryViewer} from './mapillaryViewer';
import {routeStations,imageStationIndex,IMAGE_INTERVAL} from './imageryRoute';
import {ImageryPreloader} from './imageryPreload';
import {captureStreetImage} from './imageSimilarity';
import type {Run,VehicleState} from './types';

type Slot={viewer:ImageryViewer;index:number;ready:boolean;image?:StreetImage;busy:boolean;version:number;abort?:AbortController;failedIndex?:number};
const missingToken='Add your Mapillary client token to enable street imagery';
export function Driver({id,accessToken}:{id:string;accessToken:string}){
 const [run,setRun]=useState<Run>(),[state,setState]=useState<VehicleState|null>(null),[follow,setFollow]=useState(true),[revision,setRevision]=useState(0),[setupError,setSetupError]=useState(''),[activeSlot,setActiveSlot]=useState(-1),[message,setMessage]=useState(`Preparing ${IMAGE_INTERVAL} m imagery…`);
 const holders=useRef<(HTMLDivElement|null)[]>([]),slots=useRef<Slot[]>([]),cache=useRef<ImageryPreloader|undefined>(undefined),truth=useRef<VehicleState|null>(null),followRef=useRef(true),headingBusy=useRef(false),alive=useRef(true);
 const viewerGroup=useRef<Awaited<ReturnType<typeof createViewerGroup>>|undefined>(undefined),captures=useRef(new Map<string,number>()),captureControllers=useRef(new Set<AbortController>()),replaying=useRef(false);
 const [captureError,setCaptureError]=useState<{index:number;message:string}>();
 truth.current=state;followRef.current=follow;
 const bump=()=>{if(alive.current)setRevision(value=>value+1)};
 const connected=useStream(id,packet=>{replaying.current=packet.type==='replay';if(packet.run.route)setRun(packet.run);else setRun(old=>old?{...old,...packet.run}:old);truth.current=packet.state;setState(packet.state)});
 useEffect(()=>()=>{for(const controller of captureControllers.current)controller.abort();captures.current.clear()},[id]);
 useEffect(()=>{alive.current=true;api<Run>(`/runs/${id}`).then(setRun).catch(error=>setSetupError(error.message));return()=>{alive.current=false}},[id]);
 useEffect(()=>{
  if(!accessToken||!run?.route||run.route.backend==='carla')return;
  let dead=false;let group:Awaited<ReturnType<typeof createViewerGroup>>|undefined;
  setSetupError('');setActiveSlot(-1);
  const route=run.route,stations=routeStations(route);
  createViewerGroup(holders.current.filter(Boolean) as HTMLElement[],accessToken).then(created=>{
   if(dead){created.remove();return}group=created;viewerGroup.current=created;
   slots.current=created.viewers.map(viewer=>({viewer,index:-1,ready:false,busy:false,version:0}));
   cache.current=new ImageryPreloader(stations,route.geometry,(station,signal)=>nearbyImages(station,accessToken,signal),created.preloadImage,bump);
   cache.current.setCursor(imageStationIndex(truth.current,route));bump();
  }).catch(()=>{if(!dead)setSetupError('Mapillary viewer unavailable. Check browser WebGL support and reload.')});
  return()=>{dead=true;cache.current?.dispose();cache.current=undefined;viewerGroup.current=undefined;for(const slot of slots.current){slot.version++;slot.abort?.abort()}slots.current=[];group?.remove()};
 },[accessToken,id,run?.route.id]);
 const index=run?imageStationIndex(state,run.route):0;
 // Warm all distance stations, prioritizing the current station and those ahead.
 // Only the current and next two stations hold decoded/GPU-rendered viewers.
 useEffect(()=>{
  const preload=cache.current;if(!preload||!run)return;
  preload.setCursor(index);
  const wanted=[index,index+1,index+2].filter(value=>value<preload.entries.length);
  for(const desired of wanted){
   if(slots.current.some(slot=>slot.index===desired))continue;
   const entry=preload.entries[desired];if(entry.status!=='ready'||!entry.image)continue;
   const slot=slots.current.find(candidate=>candidate!==slots.current[activeSlot]&&!candidate.busy&&!wanted.includes(candidate.index)&&candidate.failedIndex!==desired);
   if(!slot)continue;
   slot.abort?.abort();slot.abort=new AbortController();slot.index=desired;slot.ready=false;slot.busy=true;slot.image=entry.image;
   const token=++slot.version,controller=slot.abort,timeout=setTimeout(()=>controller.abort(),15000);
   moveToImage(slot.viewer,entry.image.id,controller.signal).then(async loaded=>{
    if(token!==slot.version||!alive.current)return;
    const point=loaded.computedLngLat||loaded.lngLat;
    const selected={...entry.image!};if(point){selected.lat=point.lat;selected.lng=point.lng;}
    if(!imageMatches(selected,entry.station,run.route.geometry))throw new Error('Mapillary image is on another road');
    await slot.viewer.setHeading(entry.station.heading,selected.pano,()=>token===slot.version);
    // Allow hidden canvases to draw before the distance boundary swap.
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    if(token!==slot.version||!alive.current)return;
    slot.image=selected;slot.ready=true;slot.failedIndex=undefined;
   }).catch(()=>{if(token===slot.version){slot.index=-1;slot.failedIndex=desired;slot.ready=false}})
    .finally(()=>{clearTimeout(timeout);if(token===slot.version){slot.busy=false;bump()}});
  }
  const prepared=slots.current.findIndex(slot=>slot.index===index&&slot.ready);
  setActiveSlot(prepared);
  const entry=preload.entries[index];
  if(prepared>=0)setMessage(slots.current[prepared].image?.pano?'360° Mapillary panorama':'Street photograph · limited camera view');
  else if(preload.blocked)setMessage(preload.error);
  else if(entry.status==='missing')setMessage('Mapillary imagery unavailable here');
  else if(entry.error)setMessage(entry.error);
  else if(slots.current.some(slot=>slot.failedIndex===index))setMessage(`Mapillary imagery could not load at this ${IMAGE_INTERVAL} m point`);
  else setMessage(`Preparing ${IMAGE_INTERVAL} m imagery…`);
 },[index,revision,run,activeSlot]);
 useEffect(()=>{
  const slot=slots.current[activeSlot],car=truth.current;
  if(!slot?.ready||!slot.image||!car||!follow||headingBusy.current)return;
  const version=slot.version;
  headingBusy.current=true;
  slot.viewer.setHeading(car.heading,slot.image.pano,()=>followRef.current&&slot.version===version&&slot.index===(run?imageStationIndex(truth.current,run.route):-1)&&slot.ready)
   .catch(()=>{}).finally(()=>headingBusy.current=false);
 },[state,activeSlot,follow,revision]);
 const image=slots.current[activeSlot]?.image,available=activeSlot>=0&&!!image&&slots.current[activeSlot]?.index===index&&slots.current[activeSlot]?.ready;
 useEffect(()=>{
  const group=viewerGroup.current,car=truth.current;
  if(!available||!image||!group||!car||run?.status!=='running'||replaying.current)return;
  const key=`${id}:${index}`;if(captures.current.has(key))return;
  captures.current.set(key,1);const controller=new AbortController();captureControllers.current.add(controller);
  const timeout=setTimeout(()=>controller.abort(),20000);
  // Archive only images actually reached by the driver, never future preloads.
  // A boundary change leaves this upload running so visited stations are retained.
  group.imageBytes(image).then(bytes=>captureStreetImage(id,index,image,car.time,bytes,controller.signal))
   .then(()=>{if(alive.current)setCaptureError(old=>old?.index===index?undefined:old)})
   .catch(()=>{if(alive.current&&!controller.signal.aborted)setCaptureError({index,message:'Image could not be saved. Retry capture.'});else if(alive.current)setCaptureError({index,message:'Image capture timed out. Retry capture.'})})
   .finally(()=>{clearTimeout(timeout);captureControllers.current.delete(controller)});
 },[id,index,available,image?.id,run?.status,revision]);
 const offset=state&&image?distance(state,image):undefined;
 const entries=cache.current?.entries||[],preloaded=entries.filter(entry=>entry.status==='ready').length;
 const status=!accessToken?missingToken:setupError||message;
 if(!run)return <div className="startup">{setupError||'Loading drive…'}</div>;
 if(run.route.backend==='carla')return <CarlaDriver id={id} run={run} state={state} connected={connected} replaying={replaying.current}/>;
 return <div className="driver-shell"><header><Brand subtitle="DRIVER’S VIEW"/><span className={`pill ${connected?'good':''}`}>{connected?'Connected':'Reconnecting'}</span><nav className="driver-nav"><a href="/presentation/" target="_blank" rel="noreferrer">How it works ↗</a><a href="/" target="_blank" rel="noreferrer">Engineering dashboard ↗</a></nav></header>
 <main className="driver-stage"><section className="instrument-pane" aria-label="Vehicle instrument dashboard"><iframe title="Vehicle instrument dashboard" src={`/instruments/?run=${encodeURIComponent(id)}`}/><a className="instrument-link" href={`/instruments/?run=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Open instruments separately ↗</a></section><section className="driver-scene" aria-label="Map and street imagery"><div className={`panorama ${available?'':'hidden'}`} data-testid="panorama" data-station={index} data-preloaded={preloaded} onPointerDown={()=>setFollow(false)} onWheel={()=>setFollow(false)}>{[0,1,2].map(value=><div ref={element=>{holders.current[value]=element}} key={value} className={`panorama-slot ${value===activeSlot?'visible':''}`}/>)}</div><div className={`driver-fallback ${available?'driver-location-map':''}`} aria-label="Authoritative vehicle location"><MapView route={run?.route} state={state} compact/>{!available&&<div className="fallback-label">{status}</div>}</div>
 <div className="driver-controls"><button className={follow?'primary':''} onClick={()=>setFollow(!follow)}>{follow?'Following vehicle':'Follow vehicle'}</button><span>{status}{offset!==undefined?` · ${offset.toFixed(0)} m imagery offset`:''}{image?.capturedAt?` · Captured ${new Date(image.capturedAt).toISOString().slice(0,10)}`:''}<br/><small>{IMAGE_INTERVAL} m image steps · {index*IMAGE_INTERVAL} m point · Preloaded {preloaded}/{entries.length} positions</small></span><span>{run?.status} · {(state?.time||0).toFixed(1)} s</span>{captureError?.index===index&&<div className="capture-feedback" role="alert"><span>{captureError.message}</span><button onClick={()=>{captures.current.delete(`${id}:${index}`);setCaptureError(undefined);bump()}}>Retry capture</button></div>}</div></section></main>
 <footer>Mapillary images switch at {IMAGE_INTERVAL} m intervals. Panoramas follow heading; flat photographs have a fixed camera view. Imagery does not show simulated traffic, obstacles, or signal states. Instruments and the location map follow ground truth. {run?.route.attribution}</footer></div>;
}
