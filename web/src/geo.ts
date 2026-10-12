import type {Point} from './types';
export function distance(a:Point,b:Point){const rad=Math.PI/180;const dy=(b.lat-a.lat)*rad,dx=(b.lng-a.lng)*rad;const s=Math.sin(dy/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dx/2)**2;return 6371000*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));}
export function distanceToRoad(point:Point,geometry:Point[]){
  const kx=111320*Math.cos(point.lat*Math.PI/180),ky=111320;let best=Infinity;
  for(let i=1;i<geometry.length;i++){const a=geometry[i-1],b=geometry[i];const ax=(a.lng-point.lng)*kx,ay=(a.lat-point.lat)*ky,bx=(b.lng-point.lng)*kx,by=(b.lat-point.lat)*ky;const dx=bx-ax,dy=by-ay;const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));}return best;
}
export function shouldLookup(current:Point,last:Point|undefined,now:number,lastAt:number){return now-lastAt>=1000&&(!last||distance(current,last)>=10);}
export function suitablePanorama(car:Point,pano:Point,geometry:Point[]){return distance(car,pano)<=50&&distanceToRoad(pano,geometry)<=20;}
