import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const id='f2fd6b37-145d-4759-a432-552cedd0ee2c';
const route={id:'carla-city',backend:'carla',name:'CARLA city',distance:500,geometry:[],start:{lat:0,lng:0},destination:{lat:0,lng:0},attribution:'CARLA',carla_geometry:[{x:0,y:0},{x:100,y:0},{x:100,y:100}],carla_roads:[[{x:0,y:0},{x:100,y:0}],[{x:100,y:0},{x:100,y:100}]]};
const run={id,status:'running',time:5,route,recording_valid:true,configuration:{vehicle:{capacity_wh:60000},route_id:'carla-city'},results:[]};
const state={time:5,lat:0,lng:0,heading:90,speed:4,speed_limit:6.94,charge_pct:80,energy_wh:48000,power_w:2000,remaining:450,distance:500,progress:.1,lane_index:0,carla_x:50,carla_y:0,carla_yaw:0,pedestrian_count:48,traffic_count:8,carla_actors:[{id:1,x:55,y:5,kind:'pedestrian'}]};
const image=readFileSync(new URL('./fixtures/tiny.png',import.meta.url));
const similarity={status:'ready',run_id:id,station_index:2,database_images:8,database_captures:12,similar_count:5,too_similar:true,nearest_similarity_pct:96.875,hash_bits:64,max_distance:8,warning_count:5};

test('live cameras keep the displayed image on conditional HTTP 304 responses',async({page})=>{
 await page.route('**/api/v1/config',r=>r.fulfill({json:{backend:'carla'}}));
 await page.route(`**/api/v1/runs/${id}`,r=>r.fulfill({json:run}));
 await page.routeWebSocket(`**/api/v1/runs/${id}/stream`,socket=>socket.send(JSON.stringify({type:'snapshot',run,state})));
 let unchanged=0;
 await page.route('**/carla/camera/**',r=>{
  if(r.request().headers()['if-none-match']==='"camera-frame"'){
   unchanged++;return r.fulfill({status:304,headers:{ETag:'"camera-frame"','X-CARLA-Simulation-Time':'4.8'}});
  }
  return r.fulfill({body:image,contentType:'image/png',headers:{ETag:'"camera-frame"','X-CARLA-Simulation-Time':'4.8'}});
 });
 await page.goto(`/driver/${id}`);
 await expect(page.getByAltText('CARLA first-person driver camera')).toBeVisible();
 await expect.poll(()=>unchanged).toBeGreaterThan(1);
 await expect(page.getByAltText('CARLA first-person driver camera')).toBeVisible();
 await expect(page.locator('.carla-frame-note')).toHaveCount(0);
});

test('CARLA driver uses actual cameras and keeps independent instruments without map providers',async({page})=>{
 const external:string[]=[];
 page.on('request',request=>{if(/mapillary|tile\.openstreetmap/.test(request.url()))external.push(request.url())});
 await page.route('**/api/v1/config',r=>r.fulfill({json:{mapillary_access_token:'',backend:'carla'}}));
 await page.route(`**/api/v1/runs/${id}`,r=>r.fulfill({json:run}));
 await page.route('**/carla/camera/**',r=>r.fulfill({body:image,contentType:'image/png',headers:{'X-CARLA-Simulation-Time':'4.8'}}));
 await page.route('**/images/*/similarity',r=>r.fulfill({json:similarity}));
 await page.routeWebSocket(`**/api/v1/runs/${id}/stream`,socket=>socket.send(JSON.stringify({type:'snapshot',run,state})));
 await page.goto(`/driver/${id}`);
 await expect(page.getByAltText('CARLA first-person driver camera')).toBeVisible();
 await expect(page.getByRole('link',{name:'CARLA portal'})).toHaveAttribute('href',`/carla?run=${id}`);
 await expect(page.frameLocator('iframe').getByTestId('instrument-speed')).toHaveText('14');
 const comparisons=page.frameLocator('iframe').getByRole('region',{name:'Image similarity'});
 await expect(comparisons).toBeVisible();
 await expect(comparisons).toContainText('96.9% closest match');
 await expect(comparisons).toContainText('5 similar captures');
 await expect(comparisons.getByRole('alert')).toContainText('Drive to another place');
 const instrument=await page.locator('.instrument-pane').boundingBox(),scene=await page.locator('.driver-scene').boundingBox();
 expect(instrument!.width).toBeCloseTo(scene!.width,0);
 expect(external).toEqual([]);
});

test('CARLA portal shows actors and requests camera frames at the replay cursor',async({page})=>{
 const finished={...run,status:'stopped'};
 await page.route('**/api/v1/carla/status',r=>r.fulfill({json:{status:'idle',renderer:'software',pedestrians:48,traffic_vehicles:8}}));
 await page.route('**/api/v1/runs?summary=true',r=>r.fulfill({json:[{id}]}));
 await page.route(`**/api/v1/runs/${id}`,r=>r.fulfill({json:finished}));
 await page.route('**/carla/camera/**',r=>r.fulfill({body:image,contentType:'image/png',headers:{'X-CARLA-Simulation-Time':'4.8'}}));
 await page.route('**/images/*/similarity',r=>r.fulfill({json:similarity}));
 let send:(value:string)=>void=()=>{};
 await page.routeWebSocket(`**/api/v1/runs/${id}/stream`,socket=>{send=value=>socket.send(value);send(JSON.stringify({type:'snapshot',run:finished,state}))});
 await page.route(`**/api/v1/runs/${id}/replay`,async r=>{const at=r.request().postDataJSON().at;send(JSON.stringify({type:'replay',run:finished,state:{...state,time:at},cursor:at}));await r.fulfill({json:{state:{...state,time:at}}})});
 await page.goto(`/carla?run=${id}`);
 await expect(page.getByRole('heading',{name:'A city in motion.'})).toBeVisible();
 await expect(page.getByRole('button',{name:'▶ Start city drive'})).toHaveCSS('background-color','rgb(0, 63, 77)');
 await expect(page.getByAltText('CARLA third-person chase camera')).toBeVisible();
 await expect(page.getByTestId('image-similarity')).toContainText('96.9% closest match');
 await expect(page.getByRole('link',{name:'Inspect captured images & comparisons'})).toHaveAttribute('href',`/image-similarity?run=${id}`);
 await expect(page.getByRole('img',{name:'CARLA city map with live vehicle and pedestrian positions'})).toBeVisible();
 const requested=page.waitForRequest(request=>request.url().includes('/carla/camera/chase?at=2'));
 await page.getByRole('slider',{name:'CARLA replay time'}).fill('2');
 await requested;
 await expect(page.getByText('2.00 s',{exact:true}).last()).toBeVisible();
});
