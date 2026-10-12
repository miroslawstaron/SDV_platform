import {useEffect,useState} from 'react';
import {similarityText} from './imageSimilarity';
import type {ImageSimilarityResult} from './imageSimilarity';

export function ImageSimilarity({runId,index,error='',available=true,captureHistory=false}:{runId?:string;index:number;error?:string;available?:boolean;captureHistory?:boolean}){
 const key=`${runId}:${index}:${available}:${captureHistory}`;
 const [result,setResult]=useState<{key:string;value?:ImageSimilarityResult;error?:string}>();
 useEffect(()=>{
  if(!runId||!available)return;
  let controller:AbortController;let timer:ReturnType<typeof setTimeout>;let stopped=false;
  async function poll(){
   controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),10000);
   try{
    const endpoint=captureHistory?`/api/v1/image-captures/${encodeURIComponent(runId!)}/${index}/similarity`:`/api/v1/runs/${encodeURIComponent(runId!)}/images/${index}/similarity`;
    const response=await fetch(endpoint,{signal:controller.signal});
    if(!response.ok)throw new Error('Similarity check unavailable');
    const value:ImageSimilarityResult=await response.json();
    if(!stopped)setResult({key,value});
   }catch{if(!stopped)setResult({key,error:'Similarity check unavailable'})}
   finally{clearTimeout(timeout);if(!stopped)timer=setTimeout(poll,1000)}
  }
  poll();return()=>{stopped=true;clearTimeout(timer);controller?.abort()};
 },[key,runId,index,available,captureHistory]);
 const current=result?.key===key?result:undefined;
 const value=current?.value,problem=error||current?.error;
 return <section className="image-similarity" aria-label="Image similarity" data-testid="image-similarity">
  <div className="similarity-heading"><strong>VIEW SIMILARITY</strong><small>{index*25} m point</small></div>
  <div role="status">{problem||(!available?'Waiting for street imagery':value?similarityText(value):runId?'Checking captured images…':'Start a drive to compare images')}</div>
  {value?.status==='ready'&&!problem&&<small>Matching street images · pHash distance ≤ {value.max_distance}/{value.hash_bits}</small>}
  {value?.status==='ready'&&value.too_similar&&!problem&&<div className="similarity-warning" role="alert"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 21H2z"/><path d="M12 9v5m0 3v1"/></svg><span>Too much similarity · Drive to another place</span></div>}
 </section>;
}
