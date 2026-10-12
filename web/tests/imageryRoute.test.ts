import {it,expect} from 'vitest';
import {routeStations,imageStationIndex} from '../src/imageryRoute';
import type {Route,VehicleState} from '../src/types';

const start={lat:57.7,lng:11.97},destination={lat:57.702,lng:11.97};
const route={id:'test',distance:220,start,destination,geometry:[start,destination]} as Route;
it('samples fixed 25 metre points and omits an extra partial final interval',()=>{
 const stations=routeStations(route);
 expect(stations.map(point=>point.metres)).toEqual([0,25,50,75,100,125,150,175,200]);
 expect(stations[0]).toMatchObject(start);expect(stations[1].lat).toBeCloseTo(start.lat+.002*25/220,7);
 expect(stations.every(point=>point.heading===0)).toBe(true);
});
it('clips full SUMO edge geometry to the snapped start and destination',()=>{
 const stations=routeStations({...route,geometry:[{...start,lat:57.699},start,destination,{...destination,lat:57.703}]});
 expect(stations[0].lat).toBeCloseTo(start.lat,7);
 expect(stations[1].lat).toBeCloseTo(start.lat+.002*25/220,7);
});
it('changes station only at travelled-distance boundaries, including reverse replay',()=>{
 const state=(travelled:number)=>({remaining:220-travelled} as VehicleState);
 expect(imageStationIndex(state(24.99),route)).toBe(0);expect(imageStationIndex(state(25),route)).toBe(1);
 expect(imageStationIndex(state(199),route)).toBe(7);expect(imageStationIndex(state(220),route)).toBe(8);
 expect(imageStationIndex(state(20),route)).toBe(0);
});
