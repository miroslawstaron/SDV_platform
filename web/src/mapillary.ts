import {distance,suitablePanorama} from './geo';
import type {Point} from './types';

export type StreetImage=Point & {id:string;pano:boolean;bearing?:number;capturedAt?:number};
export function bearingDelta(desired:number,current:number){return ((desired-current+540)%360+360)%360-180;}
export function panoramaCenter(center:number,currentBearing:number,heading:number){return ((center+bearingDelta(heading,currentBearing)/360)%1+1)%1;}
export function imageMatches(image:StreetImage,car:Point & {heading:number},road:Point[]){
 return suitablePanorama(car,image,road)&&(image.pano||(image.bearing!==undefined&&Math.abs(bearingDelta(car.heading,image.bearing))<=60));
}
export function selectImage(images:StreetImage[],car:Point & {heading:number},road:Point[]){
 return images.filter(image=>imageMatches(image,car,road)).sort((a,b)=>
  Number(b.pano)-Number(a.pano)||distance(car,a)-distance(car,b)||String(a.id).localeCompare(String(b.id)))[0];
}
export class ImageryError extends Error{
 constructor(message:string,public status:number=0,public retryAfter:number=5){super(message)}
}
export async function nearbyImages(car:Point,accessToken:string,signal:AbortSignal):Promise<StreetImage[]>{
 const latitude=50/111320,longitude=latitude/Math.max(.01,Math.cos(car.lat*Math.PI/180));
 const url=new URL('https://graph.mapillary.com/images');
 url.searchParams.set('bbox',[car.lng-longitude,car.lat-latitude,car.lng+longitude,car.lat+latitude].join(','));
 url.searchParams.set('fields','id,geometry,computed_geometry,compass_angle,computed_compass_angle,is_pano,captured_at');
 url.searchParams.set('limit','1000');
 const response=await fetch(url,{headers:{Authorization:`OAuth ${accessToken}`},signal});
 const body=await response.json().catch(()=>null);
 if(!response.ok||body?.error){
  const code=body?.error?.code;
  if([401,403].includes(response.status)||code===190)throw new ImageryError('Mapillary rejected the token. Check MAPILLARY_ACCESS_TOKEN and restart the platform.',401);
  if(response.status===429||[4,17,613].includes(code))throw new ImageryError('Mapillary rate limit reached. Retrying shortly.',429,Math.max(1,Math.min(60,Number(response.headers.get('Retry-After'))||10)));
  throw new ImageryError('Mapillary is temporarily unavailable. Retrying shortly.',response.status);
 }
 if(!Array.isArray(body?.data))throw new ImageryError('Mapillary returned an invalid response. Retrying shortly.');
 return body.data.flatMap((image:any)=>{
  const coordinates=(image.computed_geometry||image.geometry)?.coordinates;
  if(!Array.isArray(coordinates)||!coordinates.slice(0,2).every(Number.isFinite)||coordinates.length<2||typeof image.id!=='string')return [];
  const bearing=image.computed_compass_angle??image.compass_angle;
  return [{id:image.id,lat:coordinates[1],lng:coordinates[0],pano:image.is_pano===true,bearing:typeof bearing==='number'&&Number.isFinite(bearing)?bearing:undefined,capturedAt:Number.isFinite(image.captured_at)&&Math.abs(image.captured_at)<8.64e15?image.captured_at:undefined}];
 });
}
