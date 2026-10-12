import {describe,it,expect,vi,afterEach} from 'vitest';
import {bearingDelta,panoramaCenter,selectImage,nearbyImages,ImageryError} from '../src/mapillary';
import type {StreetImage} from '../src/mapillary';
import type {VehicleState} from '../src/types';

const origin={lat:57.7017,lng:11.9705};
const car={...origin,heading:90} as VehicleState;
const road=[origin,{...origin,lat:origin.lat+.001}];
afterEach(()=>vi.unstubAllGlobals());
describe('Mapillary selection and heading',()=>{
 it('prefers suitable panoramas while rejecting other roads and distant imagery',()=>{
  const candidates:StreetImage[]=[
   {...origin,id:'photo',pano:false,bearing:90},
   {...origin,id:'panorama',pano:true,lat:origin.lat+.0001},
   {...origin,id:'wrong-road',pano:true,lng:origin.lng+.0005},
   {...origin,id:'too-far',pano:true,lat:origin.lat+.001},
  ];
  expect(selectImage(candidates,car,road)?.id).toBe('panorama');
  expect(selectImage(candidates.slice(2),car,road)).toBeUndefined();
 });
 it('rejects opposite-facing photographs and missing photo headings',()=>{
  expect(selectImage([{...origin,id:'opposite',pano:false,bearing:270},{...origin,id:'unknown',pano:false}],car,road)).toBeUndefined();
  expect(selectImage([{...origin,id:'aligned',pano:false,bearing:110}],car,road)?.id).toBe('aligned');
 });
 it('wraps heading around north and uses current viewer bearing to orient panoramas',()=>{
  expect(bearingDelta(5,355)).toBe(10);
  expect(bearingDelta(355,5)).toBe(-10);
  expect(panoramaCenter(.5,0,90)).toBe(.75);
  expect(panoramaCenter(.98,355,5)).toBeCloseTo(.00777778);
 });
 it('uses a bounded bbox, client authorization and corrected image coordinates',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'123',geometry:{coordinates:[11.9,57.7]},computed_geometry:{coordinates:[origin.lng,origin.lat]},is_pano:true,computed_compass_angle:90}]})));
  vi.stubGlobal('fetch',fetch);
  const images=await nearbyImages(car,'client-token',new AbortController().signal);
  expect(images[0]).toMatchObject({...origin,id:'123',pano:true,bearing:90});
  const [url,options]=fetch.mock.calls[0];
  expect(url.hostname).toBe('graph.mapillary.com');
  expect(url.searchParams.has('access_token')).toBe(false);
  const bbox=url.searchParams.get('bbox').split(',').map(Number);
  expect(bbox[0]).toBeLessThan(car.lng);expect(bbox[2]).toBeGreaterThan(car.lng);
  expect(options.headers.Authorization).toBe('OAuth client-token');
 });
 it('distinguishes missing coverage from authentication and rate-limit failures',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{"data":[]}')).mockResolvedValueOnce(new Response('{"error":{"code":190}}',{status:400})).mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'3'}})));
  expect(await nearbyImages(car,'token',new AbortController().signal)).toEqual([]);
  await expect(nearbyImages(car,'token',new AbortController().signal)).rejects.toMatchObject({status:401});
  await expect(nearbyImages(car,'token',new AbortController().signal)).rejects.toMatchObject({status:429,retryAfter:3});
 });
 it('handles malformed responses and provider failures without accepting imagery',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('not JSON',{status:503})).mockResolvedValueOnce(new Response('{}')));
  await expect(nearbyImages(car,'token',new AbortController().signal)).rejects.toBeInstanceOf(ImageryError);
  await expect(nearbyImages(car,'token',new AbortController().signal)).rejects.toThrow('invalid response');
 });
});
