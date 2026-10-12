import {test,expect,type Page,type Route,type WebSocketRoute} from '@playwright/test';

const origin={lat:57.701722908,lng:11.970532313};
const run={id:'mock',status:'completed',time:20,route:{id:'mock',name:'Gothenburg test',geometry:[origin,{...origin,lat:origin.lat+.002}],start:origin,destination:{...origin,lat:origin.lat+.002},distance:220,attribution:'Test route'},configuration:{},results:[],recording_valid:true};
const viewerModule=`
window.__moves=[];window.__viewers=[];window.__images={};window.__positions={};window.__buffers=[];
export const TransitionMode={Instantaneous:1};
export class GraphDataProvider{
 getImages(ids){return Promise.resolve(ids.map(id=>{const i=window.__images[id];return {node_id:id,node:{computed_geometry:window.__positions[id]||{lat:i.computed_geometry.coordinates[1],lng:i.computed_geometry.coordinates[0]},thumb:{url:'image:'+id},mesh:{url:'mesh:'+id},camera_type:i.is_pano?'spherical':'perspective',captured_at:i.captured_at,compass_angle:i.computed_compass_angle}}}))}
 getImageBuffer(url){window.__buffers.push(url);return Promise.resolve(new ArrayBuffer(8))}
 getMesh(){return Promise.resolve({})}
}
export class Viewer{
 constructor(options){this.container=options.container;this.center=.5;this.bearing=0;this.id='';window.__viewers.push(this);this.container.innerHTML='<div class="mapillary-attribution-container">Mapillary · test contributor</div>'}
 moveTo(id){this.id=id;window.__moves.push({id,station:document.querySelector('[data-testid=panorama]').dataset.station});return Promise.resolve({id,computedLngLat:window.__positions[id]})}
 getBearing(){return Promise.resolve(this.bearing)}getCenter(){return Promise.resolve([this.center,.5])}
 setCenter(center){this.bearing=((this.bearing+(center[0]-this.center)*360)%360+360)%360;this.center=center[0]}
 remove(){this.container.replaceChildren()}
}
`;
async function setup(page:Page,live=false){
 const selectedRun=live?{...run,status:'running'}:run;
 const sockets:WebSocketRoute[]=[];
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:'test-client-token'}}));
 await page.route('**/api/v1/runs/mock',route=>route.fulfill({json:selectedRun}));
 await page.route('**/assets/mapillary.module-*.js',route=>route.fulfill({contentType:'application/javascript',body:viewerModule}));
 await page.routeWebSocket('**/api/v1/runs/mock/stream',ws=>{sockets.push(ws)});
 return (travelled:number,heading=0,type='tick')=>{for(const socket of sockets)socket.send(JSON.stringify({type,run:type==='replay'?{...selectedRun,status:'completed'}:selectedRun,state:{...origin,lat:origin.lat+.002*travelled/220,time:travelled/10,heading,speed:5,remaining:220-travelled,distance:220,progress:travelled/220,charge_pct:80,energy_wh:48000}}))};
}
function station(route:Route){const bbox=new URL(route.request().url()).searchParams.get('bbox')!.split(',').map(Number);return Math.round(((bbox[1]+bbox[3])/2-origin.lat)/.002*220/25)}
function image(index:number,pano=true){return {id:'p'+index,computed_geometry:{coordinates:[origin.lng,origin.lat+.002*index*25/220]},is_pano:pano,computed_compass_angle:0,captured_at:1700000000000}}
async function respond(page:Page,route:Route,index:number,pano=true){
 const data=image(index,pano);await page.evaluate(value=>{(window as any).__images[value.id]=value},data);await route.fulfill({json:{data:[data]}});
}
const current=(page:Page)=>page.evaluate(()=>{const viewer=(window as any).__viewers.find((value:any)=>value.container.classList.contains('visible'));return viewer?{id:viewer.id,bearing:viewer.bearing}:null});

test('preloads 25 m image bytes and frames, swaps only at boundaries and reuses replay cache',async({page})=>{
 const send=await setup(page);let lookups=0;
 await page.route('https://graph.mapillary.com/images?*',route=>{lookups++;return respond(page,route,station(route))});
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect(page.getByTestId('panorama')).toHaveAttribute('data-preloaded','9',{timeout:15000});
 await expect.poll(()=>current(page)).toMatchObject({id:'p0'});
 const prepared=await page.evaluate(()=>(window as any).__moves.find((value:any)=>value.id==='p1'));
 expect(prepared.station).toBe('0');expect(await page.evaluate(()=>(window as any).__buffers)).toContain('image:p1');
 send(24.99);await expect(page.getByTestId('panorama')).toHaveAttribute('data-station','0');expect((await current(page))?.id).toBe('p0');
 send(25);await expect.poll(()=>current(page)).toMatchObject({id:'p1'});expect(lookups).toBe(9);
 send(26,90);await expect.poll(()=>current(page)).toMatchObject({id:'p1',bearing:90});
 await page.getByTestId('panorama').dispatchEvent('pointerdown');
 await page.evaluate(()=>{const v=(window as any).__viewers.find((value:any)=>value.container.classList.contains('visible'));v.bearing=30});send(27,180);
 await page.waitForTimeout(100);expect((await current(page))?.bearing).toBe(30);
 await page.getByRole('button',{name:'Follow vehicle',exact:true}).click();await expect.poll(async()=>(await current(page))?.bearing).toBeCloseTo(180);
 await expect(page.locator('.panorama-slot.visible').getByText('Mapillary · test contributor')).toBeVisible();
 send(50);await expect.poll(()=>current(page)).toMatchObject({id:'p2'});
 send(10,0,'replay');await expect.poll(()=>current(page)).toMatchObject({id:'p0'});expect(lookups).toBe(9);
});

test('a late preload for an earlier station cannot replace the vehicle current image',async({page})=>{
 const send=await setup(page);let first:Route|undefined;
 await page.route('https://graph.mapillary.com/images?*',route=>{const index=station(route);if(index===0){first=route;return}return respond(page,route,index)});
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect.poll(()=>!!first).toBe(true);send(25);
 await expect.poll(()=>current(page)).toMatchObject({id:'p1'});
 await respond(page,first!,0);await page.waitForTimeout(200);expect((await current(page))?.id).toBe('p1');
});

test('a missing 25 m station shows the ground-truth map rather than a future image',async({page})=>{
 const send=await setup(page);
 await page.route('https://graph.mapillary.com/images?*',route=>station(route)===2?route.fulfill({json:{data:[]}}):respond(page,route,station(route)));
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect(page.getByTestId('panorama')).toHaveAttribute('data-preloaded','8',{timeout:15000});send(50);
 await expect(page.getByText('Mapillary imagery unavailable here',{exact:true}).first()).toBeVisible();
 await expect(page.getByTestId('panorama')).toHaveClass(/hidden/);
});

test('aligned photos remain supported and incorrect SDK positions are rejected during preload',async({page})=>{
 const send=await setup(page);
 await page.route('https://graph.mapillary.com/images?*',async route=>{
  const index=station(route);if(index===1)await page.evaluate(p=>{(window as any).__positions.p1={...p,lng:p.lng+.01}},origin);
  await respond(page,route,index,false);
 });
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect(page.getByText(/Street photograph · limited camera view/)).toBeVisible();
 await page.waitForTimeout(1200);send(25);
 await expect(page.getByText('Mapillary imagery unavailable here',{exact:true}).first()).toBeVisible();
});

test('route preloading respects rate limits and stops on invalid credentials',async({page})=>{
 const send=await setup(page);let count=0;
 await page.route('https://graph.mapillary.com/images?*',route=>{count++;return count===1?route.fulfill({status:429,headers:{'Retry-After':'2','Access-Control-Expose-Headers':'Retry-After'},json:{error:{code:4}}}):route.fulfill({status:401,json:{error:{code:190}}})});
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect(page.getByText('Mapillary rate limit reached. Retrying shortly.',{exact:true}).first()).toBeVisible();
 await page.waitForTimeout(1000);expect(count).toBe(1);
 await expect(page.getByText(/Mapillary rejected the token/).first()).toBeVisible({timeout:6000});
 await page.waitForTimeout(1200);expect(count).toBe(2);
});

test('missing credentials retain map-only guidance through replay without preloading',async({page})=>{
 const send=await setup(page);let requests=0;
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 page.on('request',request=>{if(request.url().includes('mapillary.com'))requests++});
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(50);
 await expect(page.getByText('Add your Mapillary client token to enable street imagery').first()).toBeVisible();send(0,0,'replay');
 await expect(page.getByTestId('panorama')).toHaveAttribute('data-station','0');
 await expect(page.getByText('Add your Mapillary client token to enable street imagery').first()).toBeVisible();expect(requests).toBe(0);
});

test('captures only reached live images, warns at five matches and clears on a different view',async({page},testInfo)=>{
 const send=await setup(page,true);const captured:number[]=[];
 const result=(index:number)=>({status:captured.includes(index)?'ready':'awaiting_capture',run_id:'mock',station_index:index,database_images:7,
  similar_count:index===0?4:index===1?5:0,too_similar:index===1,nearest_similarity_pct:index<2?96.875:55,
  hash_bits:64,max_distance:8,warning_count:5});
 await page.route('**/api/v1/runs/mock/images/**',async route=>{
  const url=new URL(route.request().url()),index=Number(url.pathname.split('/')[6]);
  if(route.request().method()==='POST'){
   expect(url.searchParams.get('provider_image_id')).toBe('p'+index);
   expect(route.request().postDataBuffer()?.length).toBe(8);
   expect(route.request().url()).not.toContain('test-client-token');captured.push(index);
  }
  await route.fulfill({json:result(index)});
 });
 await page.route('https://graph.mapillary.com/images?*',route=>respond(page,route,station(route)));
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 const card=page.getByTestId('image-similarity'),frame=page.frameLocator('iframe[title="Vehicle instrument dashboard"]');
 await expect(card).toContainText('4 similar captures');await expect(card.getByRole('alert')).toHaveCount(0);
 await expect(page.getByTestId('panorama')).toHaveAttribute('data-preloaded','9',{timeout:15000});expect(captured).toEqual([0]);
 send(25);await expect(card.getByRole('alert')).toContainText('Drive to another place');
 await expect(frame.locator('#similarity-warning')).toBeVisible();await expect(frame.locator('#similarity-value')).toContainText('5 similar captures');
 expect(await frame.locator('#similarity-warning').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
 await expect(card).toContainText('5 similar captures');
 await page.screenshot({path:testInfo.outputPath('similarity-warning.png'),fullPage:true});
 send(50);await expect(card).toContainText('0 similar captures');await expect(card.getByRole('alert')).toHaveCount(0);
 await expect(frame.locator('#similarity-warning')).toBeHidden();expect(captured).toEqual([0,1,2]);
 send(0,0,'replay');await expect(card).toContainText('4 similar captures');await page.waitForTimeout(1100);expect(captured).toEqual([0,1,2]);
});

test('failed captures show a retry and recover without blocking imagery',async({page})=>{
 const send=await setup(page,true);let uploads=0,saved=false;
 await page.route('**/api/v1/runs/mock/images/**',async route=>{
  if(route.request().method()==='POST'){
   uploads++;if(uploads===1){await route.fulfill({status:503,json:{detail:'Storage unavailable'}});return}saved=true;
  }
  await route.fulfill({json:{status:saved?'ready':'awaiting_capture',run_id:'mock',station_index:0,database_images:saved?1:0,similar_count:0,too_similar:false,nearest_similarity_pct:null,hash_bits:64,max_distance:8,warning_count:5}});
 });
 await page.route('https://graph.mapillary.com/images?*',route=>respond(page,route,station(route)));
 await page.goto('/driver/mock');await expect(page.getByText('Connected',{exact:true})).toBeVisible();send(0);
 await expect(page.getByRole('button',{name:'Retry capture'})).toBeVisible();await expect(page.getByTestId('panorama')).not.toHaveClass(/hidden/);
 await page.getByRole('button',{name:'Retry capture'}).click();await expect(page.getByTestId('image-similarity')).toContainText('No other captures yet');expect(uploads).toBe(2);
});

