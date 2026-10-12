import {useEffect,useRef} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {Point,Route,VehicleState} from './types';

type Props={route?:Route;state?:VehicleState|null;onPick?:(p:Point)=>void;points?:Point[];compact?:boolean};
export function MapView({route,state,onPick,points=[],compact=false}:Props){
 const container=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),layers=useRef<L.Layer[]>([]),marker=useRef<L.Marker|null>(null),picker=useRef(onPick);picker.current=onPick;
 useEffect(()=>{
  const center=route?.start||{lat:57.701722908,lng:11.970532313};
  const instance=L.map(container.current!,{zoomControl:!compact,attributionControl:true}).setView([center.lat,center.lng],16);map.current=instance;
  if(navigator.onLine)L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(instance);
  instance.on('click',e=>picker.current?.({lat:e.latlng.lat,lng:e.latlng.lng}));
  const resize=new ResizeObserver(()=>instance.invalidateSize());resize.observe(container.current!);
  return()=>{resize.disconnect();instance.remove();map.current=null;marker.current=null;layers.current=[]};
 },[]);
 useEffect(()=>{
  const m=map.current;if(!m)return;layers.current.forEach(layer=>layer.remove());layers.current=[];
  (route?.roads||[]).forEach(road=>layers.current.push(L.polyline(road.map(p=>[p.lat,p.lng] as [number,number]),{color:'#8a99a6',weight:2,opacity:.6}).addTo(m)));
  if(route){const line=L.polyline(route.geometry.map(p=>[p.lat,p.lng] as [number,number]),{color:'#18a994',weight:5}).addTo(m);layers.current.push(line);m.fitBounds(line.getBounds(),{padding:[35,35]});}
  const endpoints=points.length?points:route?[route.start,route.destination]:[];
  endpoints.forEach((p,i)=>layers.current.push(L.circleMarker([p.lat,p.lng],{radius:8,color:i?'#ec945b':'#18a994',fillOpacity:1}).addTo(m)));
 },[route,points.map(p=>`${p.lat},${p.lng}`).join(';')]);
 useEffect(()=>{
  if(!state||!map.current)return;
  const icon=L.divIcon({className:'vehicle-marker',html:`<span style="transform:rotate(${state.heading}deg)">▲</span>`,iconSize:[28,28],iconAnchor:[14,14]});
  if(marker.current)marker.current.setLatLng([state.lat,state.lng]).setIcon(icon);else marker.current=L.marker([state.lat,state.lng],{icon}).addTo(map.current);
  if(compact)map.current.panTo([state.lat,state.lng],{animate:false});
 },[state,compact]);
 return <div className="map-wrap"><div ref={container} className="map"/></div>;
}
