import {distance} from './geo';
import type {Point,Route,VehicleState} from './types';

export const IMAGE_INTERVAL=25;
export type ImageStation=Point & {index:number;metres:number;heading:number};
export function routeStations(route:Route):ImageStation[]{
 const points=route.geometry.length>1?route.geometry:[route.start,route.destination];
 const lengths=[0];for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+distance(points[i-1],points[i]));
 function project(point:Point,last=false){
  let best=Infinity,along=0;const kx=Math.cos(point.lat*Math.PI/180);
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i],dx=(b.lng-a.lng)*kx,dy=b.lat-a.lat;
   const t=Math.max(0,Math.min(1,((point.lng-a.lng)*kx*dx+(point.lat-a.lat)*dy)/(dx*dx+dy*dy||1)));
   const error=Math.hypot((a.lng+t*(b.lng-a.lng)-point.lng)*kx,a.lat+t*(b.lat-a.lat)-point.lat);
   if(error<best-1e-9||(last&&Math.abs(error-best)<=1e-9)){best=error;along=lengths[i-1]+t*(lengths[i]-lengths[i-1]);}
  }return along;
 }
 const start=project(route.start),finish=project(route.destination,true),end=finish>start?finish:lengths.at(-1)!;
 return Array.from({length:Math.floor(route.distance/IMAGE_INTERVAL)+1},(_,index)=>{
  const metres=index*IMAGE_INTERVAL,offset=start+(end-start)*metres/Math.max(1,route.distance);
  let segment=1;while(segment<points.length-1&&lengths[segment]<offset)segment++;
  const a=points[segment-1],b=points[segment],fraction=Math.max(0,Math.min(1,(offset-lengths[segment-1])/(lengths[segment]-lengths[segment-1]||1)));
  const lat=a.lat+(b.lat-a.lat)*fraction,lng=a.lng+(b.lng-a.lng)*fraction;
  const rad=Math.PI/180,dLng=(b.lng-a.lng)*rad;
  const heading=(Math.atan2(Math.sin(dLng)*Math.cos(b.lat*rad),Math.cos(a.lat*rad)*Math.sin(b.lat*rad)-Math.sin(a.lat*rad)*Math.cos(b.lat*rad)*Math.cos(dLng))/rad+360)%360;
  return {index,metres,lat,lng,heading};
 });
}
export function imageStationIndex(state:VehicleState|null,route:Route){
 const travelled=state?Math.max(0,Math.min(route.distance,route.distance-state.remaining)):0;
 return Math.min(Math.floor(route.distance/IMAGE_INTERVAL),Math.floor((travelled+1e-7)/IMAGE_INTERVAL));
}
