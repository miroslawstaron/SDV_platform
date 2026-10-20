import {useEffect,useState} from 'react';
import {api} from './api';
import type {DrivingScenario,DrivingScenarioSettings} from './types';

const key='sdv-driving-scenario',changed='sdv-driving-scenario-changed';
function savedSelection():DrivingScenario|undefined{
 try{const value=JSON.parse(localStorage.getItem(key)||'null');return value?.id&&value?.settings&&value?.name?value:undefined}catch{return undefined}
}
export function useDrivingScenario(){
 const [value,setValue]=useState<DrivingScenario|undefined>(savedSelection);
 useEffect(()=>{const refresh=()=>setValue(savedSelection());window.addEventListener('storage',refresh);window.addEventListener(changed,refresh);return()=>{window.removeEventListener('storage',refresh);window.removeEventListener(changed,refresh)}},[]);
 function select(next:DrivingScenario|undefined){setValue(next);try{if(next)localStorage.setItem(key,JSON.stringify(next));else localStorage.removeItem(key);window.dispatchEvent(new Event(changed))}catch{/* Selection still works without browser storage. */}}
 return [value,select] as const;
}

type Preview={settings:DrivingScenarioSettings;unrecognized:string[];notes:string[]};
const examples=[
 {name:'Rain at night',prompt:'Drive in heavy rain at night with 12 pedestrians and 6 cars, at 25 km/h, for 500 m and 2 minutes.'},
 {name:'Quiet daytime',prompt:'Drive in clear daytime with 5 pedestrians and 2 cars, at 20 km/h, for 800 m and 3 minutes.'},
 {name:'Busy crossings',prompt:'Drive with 80 pedestrians, 16 cars and frequent pedestrian crossings, at 15 km/h, for 400 m and 3 minutes.'},
];

export function ScenarioSettings({settings}:{settings:DrivingScenarioSettings}){
 return <dl className="scenario-preview">
  {([['Pedestrians',settings.pedestrians],['Traffic vehicles',settings.traffic_vehicles],['Speed cap',`${settings.speed_kmh} km/h`],['Requested route',`${settings.distance_m} m`],['Time budget',`${settings.duration_seconds} s`],['Weather',settings.weather.replaceAll('_',' ')],['Time of day',settings.time_of_day],['Crossings',settings.crossings],['Seed',settings.seed]] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
 </dl>;
}

export function DrivingScenarios({value,onChange,disabled=false}:{value?:DrivingScenario;onChange:(value:DrivingScenario|undefined)=>void;disabled?:boolean}){
 const [library,setLibrary]=useState<DrivingScenario[]>([]),[name,setName]=useState('My city drive'),[prompt,setPrompt]=useState(''),[preview,setPreview]=useState<Preview>(),[accept,setAccept]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const refresh=()=>api<DrivingScenario[]>('/scenarios').then(setLibrary).catch(e=>setError(e.message));
 useEffect(()=>{refresh();const onFocus=()=>refresh();window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus)},[]);
 useEffect(()=>{setName(value?.name||'My city drive');setPrompt(value?.prompt||'');setPreview(value?{settings:value.settings,unrecognized:value.unrecognized||[],notes:[]}:undefined);setAccept(!!value?.unrecognized?.length);setMessage('');setError('')},[value?.id,value?.prompt]);
 function edit(text:string){setPrompt(text);setPreview(undefined);setAccept(false);setError('');setMessage('')}
 async function perform(action:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await action()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function save(asNew=false){await perform(async()=>{const saved=await api<DrivingScenario>(value&&!asNew?`/scenarios/${encodeURIComponent(value.id)}`:'/scenarios',value&&!asNew?'PUT':'POST',{name,prompt,accept_unrecognized:accept});onChange(saved);await refresh();setMessage('Scenario saved and selected for the next drive.')})}
 return <fieldset className="driving-scenarios" disabled={disabled||busy}>
  <legend>Your driving scenarios</legend>
  <label className="scenario-select">Scenario for the next drive<select aria-label="Driving scenario" value={value?.id||''} onChange={e=>onChange(library.find(s=>s.id===e.target.value))}><option value="">Default city · 48 pedestrians · 8 vehicles</option>{value&&!library.some(s=>s.id===value.id)&&<option value={value.id}>{value.name}</option>}{library.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
  <p>{disabled?'Scenario selection is locked while driving.':'Choose a saved scenario, or describe one below and save it for the next drive.'}</p>
  <details className="scenario-editor"><summary>Describe a scenario from a text prompt</summary>
   <p>Local English interpreter · traffic, pedestrians, speed, weather, time of day, route length, duration and seed. Review the settings before saving.</p>
   <div className="scenario-examples" aria-label="Scenario examples">{examples.map(example=><button type="button" key={example.name} onClick={()=>{setName(example.name);edit(example.prompt)}}>{example.name}</button>)}</div>
   <label>Scenario name<input aria-label="Scenario name" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
   <label>Describe your drive<textarea aria-label="Driving scenario prompt" rows={4} maxLength={2000} value={prompt} placeholder={examples[0].prompt} onChange={e=>edit(e.target.value)}/></label>
   <div className="scenario-actions"><button type="button" disabled={!prompt.trim()} onClick={()=>perform(async()=>{setPreview(await api<Preview>('/scenarios/preview','POST',{name:name.trim()||'My city drive',prompt}))})}>{busy?'Working…':'Preview scenario'}</button><button type="button" className="primary" disabled={!preview||!name.trim()||!!preview.unrecognized.length&&!accept} onClick={()=>save()}>{value?'Update & use scenario':'Save & use scenario'}</button>{value&&<><button type="button" disabled={!preview||!name.trim()||!!preview.unrecognized.length&&!accept} onClick={()=>save(true)}>Save as new</button><button type="button" onClick={()=>perform(async()=>{await api(`/scenarios/${encodeURIComponent(value.id)}`,'DELETE');onChange(undefined);await refresh();setMessage('Scenario deleted. Existing recordings are unchanged.')})}>Delete scenario</button></>}</div>
   {preview&&<section aria-label="Interpreted driving scenario"><h3>What CARLA will run</h3><ScenarioSettings settings={preview.settings}/>{!!preview.unrecognized.length&&<div className="scenario-unrecognized" role="alert"><strong>Instructions not interpreted</strong><p>{preview.unrecognized.join(', ')}</p><label><input type="checkbox" checked={accept} onChange={e=>setAccept(e.target.checked)}/> Use recognized settings only</label></div>}<ul className="scenario-notes">{preview.notes.map(note=><li key={note}>{note}</li>)}</ul></section>}
  </details>
  {error&&<p className="scenario-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {value&&<div className="scenario-selected"><strong>Selected: {value.name}</strong><span>{value.settings.pedestrians} pedestrians · {value.settings.traffic_vehicles} vehicles · {value.settings.speed_kmh} km/h · {value.settings.weather.replaceAll('_',' ')} · {value.settings.time_of_day}</span></div>}
 </fieldset>;
}

export function RecordedScenario({value}:{value?:DrivingScenario}){
 if(!value)return null;
 return <details className="recorded-scenario"><summary>Recorded scenario: {value.name}</summary><p>{value.prompt}</p><ScenarioSettings settings={value.settings}/>{!!value.unrecognized?.length&&<p>Not interpreted: {value.unrecognized.join(', ')}</p>}</details>;
}
