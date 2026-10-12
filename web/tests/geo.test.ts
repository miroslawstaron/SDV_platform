import {describe,it,expect} from 'vitest';
import {distance,shouldLookup,suitablePanorama} from '../src/geo';
const p={lat:57.7017,lng:11.9705};
describe('Driver imagery position policy',()=>{
 it('measures geographic offsets',()=>expect(distance(p,{...p,lat:p.lat+.001})).toBeCloseTo(111.19,1));
 it('loads immediately, then caps movement and replay lookups',()=>{expect(shouldLookup(p,undefined,500,-Infinity)).toBe(true);expect(shouldLookup(p,undefined,500,0)).toBe(false);expect(shouldLookup(p,p,2000,0)).toBe(false);expect(shouldLookup({...p,lat:p.lat+.0002},p,500,0)).toBe(false);expect(shouldLookup({...p,lat:p.lat+.0002},p,2000,0)).toBe(true)});
 it('rejects distant and different-road imagery',()=>{const road=[p,{...p,lat:p.lat+.001}];expect(suitablePanorama(p,{...p,lat:p.lat+.0001},road)).toBe(true);expect(suitablePanorama(p,{...p,lat:p.lat+.001},road)).toBe(false);expect(suitablePanorama(p,{...p,lng:p.lng+.0006},road)).toBe(false)});
});
