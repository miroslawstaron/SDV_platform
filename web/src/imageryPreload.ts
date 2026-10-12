import {ImageryError,selectImage} from './mapillary';
import type {StreetImage} from './mapillary';
import type {ImageStation} from './imageryRoute';
import type {Point} from './types';

export type PreloadEntry={station:ImageStation;status:'pending'|'loading'|'ready'|'missing'|'error';image?:StreetImage;error?:string;attempts:number;retryAt:number};
export class ImageryPreloader{
 readonly entries:PreloadEntry[];
 error='';blocked=false;
 private cursor=0;private active=0;private lastLookup=-Infinity;private pauseUntil=0;
 private timer:ReturnType<typeof setTimeout>|undefined;private stopped=false;
 private controllers=new Set<AbortController>();
 constructor(stations:ImageStation[],private road:Point[],private lookup:(station:ImageStation,signal:AbortSignal)=>Promise<StreetImage[]>,private warm:(image:StreetImage,signal:AbortSignal)=>Promise<StreetImage>,private update:()=>void){
  this.entries=stations.map(station=>({station,status:'pending',attempts:0,retryAt:0}));
 }
 setCursor(index:number){this.cursor=index;this.pump()}
 private pump(){
  if(this.stopped||this.blocked)return;
  clearTimeout(this.timer);const now=performance.now();
  const queue=this.entries.filter(e=>e.status==='pending'||(e.status==='error'&&e.attempts<3)).sort((a,b)=>{
   const score=(entry:PreloadEntry)=>entry.station.index>=this.cursor?entry.station.index-this.cursor:this.entries.length+this.cursor-entry.station.index;
   return score(a)-score(b);
  });
  const entry=queue.find(e=>e.retryAt<=now);
  const wait=Math.max(this.pauseUntil-now,1000-(now-this.lastLookup));
  if(entry&&this.active<2&&wait<=0){this.lastLookup=now;this.load(entry);}
  if(queue.length)this.timer=setTimeout(()=>this.pump(),Math.max(100,Math.min(1000,wait>0?wait:250)));
 }
 private async load(entry:PreloadEntry){
  entry.status='loading';entry.attempts++;this.active++;this.update();
  const controller=new AbortController();this.controllers.add(controller);
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
   const images=await this.lookup(entry.station,controller.signal);
   if(this.stopped)return;
   const selected=selectImage(images,entry.station,this.road);
   if(!selected){entry.status='missing';return;}
   const warmed=await this.warm(selected,controller.signal);
   if(this.stopped)return;
   if(!selectImage([warmed],entry.station,this.road)){entry.status='missing';return;}
   entry.image=warmed;entry.status='ready';entry.error=undefined;
  }catch(error){
   if(this.stopped)return;
   const failure=error instanceof ImageryError?error:new ImageryError('Mapillary preload could not complete. Retrying shortly.');
   entry.status='error';entry.error=failure.message;entry.retryAt=performance.now()+failure.retryAfter*1000;
   if(failure.status===401){this.blocked=true;this.error=failure.message;}
   if(failure.status===429){this.pauseUntil=entry.retryAt;this.error=failure.message;}
  }finally{
   clearTimeout(timeout);this.controllers.delete(controller);this.active--;
   if(!this.stopped){this.update();this.pump();}
  }
 }
 dispose(){this.stopped=true;clearTimeout(this.timer);for(const controller of this.controllers)controller.abort();this.controllers.clear();}
}
