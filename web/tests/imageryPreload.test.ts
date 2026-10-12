import {it,expect,vi,afterEach} from 'vitest';
import {ImageryPreloader} from '../src/imageryPreload';
import {ImageryError} from '../src/mapillary';
import type {ImageStation} from '../src/imageryRoute';

const origin={lat:57.7,lng:11.97};
const stations=[0,1,2].map(index=>({...origin,lat:origin.lat+index*.000225,heading:0,index,metres:index*25}));
const road=[origin,{...origin,lat:origin.lat+.002}];
afterEach(()=>vi.useRealTimers());
it('warms future station image bytes before the vehicle enters their interval',async()=>{
 vi.useFakeTimers();
 const lookup=vi.fn(async(station:ImageStation)=>[{...station,id:String(station.index),pano:true}]);
 const warm=vi.fn(async image=>image),cache=new ImageryPreloader(stations,road,lookup,warm,()=>{});
 cache.setCursor(0);await vi.advanceTimersByTimeAsync(2200);
 expect(cache.entries.map(entry=>entry.status)).toEqual(['ready','ready','ready']);
 expect(warm).toHaveBeenCalledTimes(3);
 cache.setCursor(1);cache.setCursor(0);await vi.advanceTimersByTimeAsync(1000);
 expect(lookup).toHaveBeenCalledTimes(3);cache.dispose();
});
it('prioritizes a replay destination and distinguishes missing coverage',async()=>{
 vi.useFakeTimers();
 const lookup=vi.fn(async(_station:ImageStation)=>[]),cache=new ImageryPreloader(stations,road,lookup,vi.fn(),()=>{});
 cache.setCursor(2);await vi.advanceTimersByTimeAsync(1);
 expect(lookup.mock.calls[0][0].index).toBe(2);expect(cache.entries[2].status).toBe('missing');cache.dispose();
});
it('backs off provider rate limits and stops on rejected credentials',async()=>{
 vi.useFakeTimers();
 const lookup=vi.fn().mockRejectedValueOnce(new ImageryError('rate limited',429,2)).mockRejectedValueOnce(new ImageryError('token rejected',401));
 const cache=new ImageryPreloader(stations,road,lookup,vi.fn(),()=>{});
 cache.setCursor(0);await vi.advanceTimersByTimeAsync(1000);expect(lookup).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(1500);expect(cache.blocked).toBe(true);
 await vi.advanceTimersByTimeAsync(5000);expect(lookup).toHaveBeenCalledTimes(2);cache.dispose();
});
