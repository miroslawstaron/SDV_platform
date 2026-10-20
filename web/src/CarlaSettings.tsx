import {useEffect,useState} from 'react';
import type {CarlaRendering} from './types';

const key='sdv-carla-rendering';
const changed='sdv-carla-rendering-changed';
const defaults:CarlaRendering={graphics:'high',resolution:'1080p'};

function savedRendering():CarlaRendering{
 try{
  const value=JSON.parse(localStorage.getItem(key)||'{}');
  return {graphics:value?.graphics==='low'?'low':'high',resolution:value?.resolution==='720p'?'720p':'1080p'};
 }catch{return defaults}
}

export function useCarlaRendering(){
 const [rendering,setRendering]=useState<CarlaRendering>(savedRendering);
 useEffect(()=>{
  const refresh=()=>setRendering(savedRendering());
  window.addEventListener('storage',refresh);window.addEventListener(changed,refresh);
  return()=>{window.removeEventListener('storage',refresh);window.removeEventListener(changed,refresh)};
 },[]);
 function update(value:CarlaRendering){
  setRendering(value);
  try{localStorage.setItem(key,JSON.stringify(value));window.dispatchEvent(new Event(changed))}catch{/* Keep controls usable when browser storage is unavailable. */}
 }
 return [rendering,update] as const;
}

export function CarlaSettings({value,onChange,disabled=false}:{value:CarlaRendering;onChange:(value:CarlaRendering)=>void;disabled?:boolean}){
 return <fieldset className="carla-render-settings" disabled={disabled}>
  <legend>CARLA graphics & previews</legend>
  <div className="carla-render-fields"><label>Graphics quality<select aria-label="CARLA graphics quality" value={value.graphics} onChange={e=>onChange({...value,graphics:e.target.value as CarlaRendering['graphics']})}><option value="low">Low graphics</option><option value="high">High graphics</option></select></label>
  <label>Preview resolution<select aria-label="CARLA preview resolution" value={value.resolution} onChange={e=>onChange({...value,resolution:e.target.value as CarlaRendering['resolution']})}><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option></select></label></div>
  <p>{disabled?'Stop the drive to change graphics and previews.':'Applies to the next drive. Low graphics and 720p reduce rendering load.'} Saved recordings keep their original images.</p>
 </fieldset>;
}

export function CarlaRenderingSummary({value}:{value?:CarlaRendering}){
 if(!value)return <span>Graphics settings were not recorded for this drive</span>;
 return <span className="carla-render-summary">{value.graphics==='low'?'Low':'High'} graphics · {value.resolution} previews</span>;
}
