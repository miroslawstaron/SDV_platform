// Read-only capture of CARLA recordings. No run, replay, image or fault writes.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const assets=fileURLToPath(new URL('../public/presentation/screenshots/',import.meta.url));
await mkdir(assets,{recursive:true});
const origin=process.env.SDV_WEB_URL||'http://localhost:8080',api=origin+'/api/v1';
async function get(path){const response=await fetch(api+path);if(!response.ok)throw new Error(`Read failed: ${path} (${response.status})`);return response.json()}
const summaries=await get('/runs?summary=true');
let run;
for(const summary of summaries.filter(value=>!['running','starting','created','failed'].includes(value.status)&&value.time>=8).slice(0,30)){
 if(process.env.SDV_PRESENTATION_RUN&&summary.id!==process.env.SDV_PRESENTATION_RUN)continue;
 const candidate=await get(`/runs/${summary.id}`);
 if(candidate.route.backend==='carla'&&(await get(`/image-captures?run_id=${candidate.id}&limit=1`)).total){run=candidate;break}
}
if(!run)throw new Error('A finished CARLA drive with camera captures is required');
const capturedOn=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Stockholm'});
const metadata=JSON.parse(await readFile(assets+'provenance.json','utf8'));
for(const value of Object.values(metadata.assets))value.captured_on??=metadata.captured_on;
metadata.captured_on=capturedOn;
metadata.capture_method='Actual UI screenshots from saved CARLA state, events and camera frames, sent through isolated browser replay streams. No server writes. Historical fault examples retain their original source and date.';
const retained=['truth-substituted','fault-configuration','controller-outage'];
metadata.assets=Object.fromEntries(Object.entries(metadata.assets).filter(([name])=>retained.includes(name)));
for(const value of Object.values(metadata.assets)){value.backend='sumo';value.description=`Historical SUMO fault example. ${(value.description||'').replace(/^(Historical SUMO fault example\.\s*)+/, '')}`.trim()}
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,headless:true});
try{
 const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1});
 const writes=[];
 await context.route('**/api/v1/**',route=>{if(route.request().method()==='GET')return route.continue();writes.push(route.request().url());return route.abort()});
 await context.route('**/api/v1/health',route=>route.fulfill({json:{status:'ready',active_run:null,gateway:{status:'ready'}}}));
 const sockets=new Map();
 await context.routeWebSocket('**/api/v1/runs/*/stream',socket=>{
  const id=new URL(socket.url()).pathname.split('/')[4];
  if(!sockets.has(id))sockets.set(id,[]);sockets.get(id).push(socket);
 });
 async function send(time,type='replay'){
  const timeline=await get(`/runs/${run.id}/timeline?at=${time}&window=.25`);
  const signals=Object.assign({},...timeline.events.filter(event=>event.protocol==='CAN'&&event.kind==='tx').map(event=>event.decoded||{}));
  const value={type,run,cursor:time,...timeline,signals,health:{},faults:[]};
  for(const socket of sockets.get(run.id)||[])socket.send(JSON.stringify(value));
  return value;
 }
 async function shot(page,name,selector,details={},region){
  await page.mouse.move(0,0);await page.keyboard.press('Escape');
  const file=assets+name+'.png';
  if(region){
   const target=page.locator(selector);
   const [bounds,start,end,scroll]=await Promise.all([target.boundingBox(),target.locator(region.start).boundingBox(),target.locator(region.end).boundingBox(),page.evaluate(()=>({x:scrollX,y:scrollY}))]);
   await page.screenshot({path:file,fullPage:true,clip:{x:bounds.x+scroll.x,y:start.y+scroll.y,width:bounds.width,height:end.y+end.height-start.y}});
  }else if(selector)await page.locator(selector).screenshot({path:file});else await page.screenshot({path:file});
  metadata.assets[name]={file:`screenshots/${name}.png`,captured_on:capturedOn,run_id:run.id,route:run.route.name,backend:'carla',sample_time:8,kind:'recorded CARLA replay',...details};
 }
 async function ready(page,selector){await page.locator(selector).waitFor();await send(8)}
 async function cameraReady(page,view,at){
  const response=await fetch(`${api}/runs/${run.id}/carla/camera/${view}?at=${at}`);
  if(!response.ok)throw new Error(`Missing ${view} camera at ${at}`);
  const stamp=Number(response.headers.get('X-CARLA-Simulation-Time'));
  await page.locator(`[data-testid="carla-camera-${view}"] .carla-camera-label`).filter({hasText:`${stamp.toFixed(2)} s`}).waitFor();
  await page.locator(`[data-testid="carla-camera-${view}"] img`).evaluate(image=>image.decode());
 }
 const engineering=await context.newPage();await engineering.goto(origin+'/');
 await engineering.getByRole('combobox',{name:'Recorded run'}).selectOption(run.id);
 await ready(engineering,'.connection-dot.on');
 await engineering.getByTestId('image-similarity').filter({hasText:'closest match'}).waitFor();
 await shot(engineering,'engineering-overview');
 await shot(engineering,'engineering-route','.drive-panel');
 await shot(engineering,'engineering-network','.network-panel');
 await shot(engineering,'architecture-contracts','#architecture-view');
 await shot(engineering,'recordings-export','.recordings-panel');
 await engineering.getByRole('link',{name:'All signals CSV ↗'}).focus();
 await shot(engineering,'signals-export-choice','.recordings-panel',{description:'Export link focused without downloading or changing the recording.'});
 await shot(engineering,'communication-events','.events-panel');
 await shot(engineering,'replay-controls','.recordings-panel');
 await engineering.getByRole('button',{name:'Rerun configuration'}).focus();
 await shot(engineering,'rerun-configuration','.recordings-panel',{description:'Rerun button focused without starting a new drive.'});
 for(const time of [2,3,4,5,6,7,8])await send(time,'tick');
 await shot(engineering,'truth-normal','.drive-panel');
 const driver=await context.newPage();await driver.goto(`${origin}/driver/${run.id}`);
 await ready(driver,'iframe');await send(8);
 await driver.getByAltText('CARLA first-person driver camera').waitFor();
 await cameraReady(driver,'driver',8);
 await driver.frameLocator('iframe').locator('#similarity-value').filter({hasText:'closest match'}).waitFor();
 const dimensions=await driver.getByAltText('CARLA first-person driver camera').evaluate(image=>[image.naturalWidth,image.naturalHeight]);
 if(dimensions[0]<1920||dimensions[1]<1080)throw new Error(`Choose a 1080p CARLA recording; this camera is ${dimensions.join('x')}`);
 await shot(driver,'driver-view',null,{camera_dimensions:dimensions});
 const instrument=driver.frameLocator('iframe');
 const [cluster,speed,battery]=await Promise.all([instrument.locator('.cluster').boundingBox(),instrument.locator('.speedometer').boundingBox(),instrument.locator('.battery-section').boundingBox()]);
 await driver.screenshot({path:assets+'driver-instruments.png',fullPage:true,clip:{x:cluster.x,y:speed.y,width:cluster.width,height:battery.y+battery.height-speed.y}});
 metadata.assets['driver-instruments']={...metadata.assets['driver-view'],file:'screenshots/driver-instruments.png',description:'Close-up of actual speed, similarity and estimated battery state in the independent instruments.'};
 await driver.getByRole('button',{name:'Enlarge driver camera'}).click();
 await driver.waitForFunction(()=>document.fullscreenElement?.classList.contains('carla-camera'));
 await driver.locator('.carla-camera:fullscreen').screenshot({path:assets+'imagery-example.png'});
 metadata.assets['imagery-example']={...metadata.assets['driver-view'],file:'screenshots/imagery-example.png',description:'Full-screen CARLA camera at the recorded simulation time.'};
 await driver.evaluate(()=>document.exitFullscreen());
 const captures=(await get(`/image-captures?run_id=${run.id}&limit=100`)).items;
 let warningCapture;
 for(const capture of [...captures].reverse()){
  if((await get(`/runs/${run.id}/images/${capture.station_index}/similarity`)).too_similar){warningCapture=capture;break}
 }
 if(warningCapture){
  await send(warningCapture.sim_time+.2);
  await driver.frameLocator('iframe').locator('#similarity-warning').waitFor({state:'visible'});
  await cameraReady(driver,'driver',warningCapture.sim_time+.2);
  await shot(driver,'driver-similarity-warning',null,{sample_time:warningCapture.sim_time+.2,kind:'recorded CARLA replay with actual database warning',description:'The live similarity database supplies the five-match warning. No staged comparison response.'});
 }
 await send(8);
 const portal=await context.newPage();await portal.goto(`${origin}/carla?run=${run.id}`);await ready(portal,'.carla-session');
 await portal.getByAltText('CARLA third-person chase camera').waitFor();
 await cameraReady(portal,'chase',8);
 await shot(portal,'carla-portal');
 await shot(portal,'carla-world','.carla-portal-grid');
 await shot(portal,'carla-recording','.carla-session');
 const gallery=await context.newPage();await gallery.goto(`${origin}/image-similarity?run=${run.id}`);
 await gallery.locator('.capture-card').first().waitFor();
 let selected;
 for(const capture of [...captures].reverse()){
  if((await get(`/runs/${run.id}/images/${capture.station_index}/similarity`)).nearest_similarity_pct===100){selected=capture;break}
 }
 if(!selected)throw new Error('The gallery example needs a saved CARLA capture with an exact pHash repeat');
 await gallery.getByRole('button',{name:`Inspect capture ${run.id.slice(0,8)} at ${selected.station_index*25} m`,exact:true}).click();
 await gallery.locator('.capture-details').filter({hasText:selected.provider_image_id}).waitFor();
 await gallery.locator('.capture-match').getByText('100.0% similarity',{exact:true}).first().waitFor();
 const imageSource={station_index:selected.station_index,provider_image_id:selected.provider_image_id,source_captured_at:null,lat:selected.lat,lng:selected.lng,phash:selected.phash,sample_time:selected.sim_time,kind:'saved CARLA driver-camera capture in the shared pHash library'};
 await shot(gallery,'similarity-dashboard',null,imageSource);
 await shot(gallery,'similarity-exact','.capture-comparisons',{...imageSource,description:'First three actual comparison rows, cropped for legibility.'},{start:'.capture-match:first-child',end:'.capture-match:nth-child(3)'});
 await shot(gallery,'image-provenance','.capture-details',imageSource);
 await gallery.getByRole('checkbox').check();await gallery.locator('.capture-match').first().waitFor();
 await shot(gallery,'similarity-matching-only','.capture-inspector',imageSource);
 if(writes.length)throw new Error(`Screenshot workflow attempted server writes: ${writes}`);
 await writeFile(assets+'provenance.json',JSON.stringify(metadata,null,2)+'\n');
 console.log(JSON.stringify({screenshots:Object.keys(metadata.assets).length,recording:run.id,dimensions,actualWarning:!!warningCapture,serverWrites:writes.length}));
}finally{await browser.close()}
