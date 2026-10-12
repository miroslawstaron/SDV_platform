// Read-only screenshot capture from saved runs. No run, fault or image writes.
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const assets=fileURLToPath(new URL('../public/presentation/screenshots/',import.meta.url));
await mkdir(assets,{recursive:true});
const origin=process.env.SDV_WEB_URL||'http://localhost:8080',api=origin+'/api/v1';
async function get(path){const response=await fetch(api+path);if(!response.ok)throw new Error(`Read failed: ${path} (${response.status})`);return response.json()}
const [runs,history]=await Promise.all([get('/runs'),get('/image-captures?limit=100')]);
const run=runs.find(item=>item.status==='completed'&&history.runs.some(saved=>saved.run_id===item.id));
if(!run)throw new Error('A completed drive with captured images is required for presentation screenshots');
const faultRun=runs.find(item=>item.time>=3&&item.configuration.faults.some(f=>f.module==='sensor'&&f.kind==='substitute'&&f.signal==='Speed')&&item.configuration.faults.length===1);
const outageRun=runs.find(item=>item.time>=3&&item.configuration.faults.some(f=>f.module==='controller'&&f.kind==='stop'));
if(!faultRun||!outageRun)throw new Error('Saved sensor substitution and controller outage examples are required');
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const metadata={captured_on:new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Stockholm'}),capture_method:'Screenshots of the actual UI; saved state and events displayed through an isolated browser replay stream. No recording, image capture or fault writes.',assets:{}};
await context.route('**/api/v1/**',route=>route.request().method()==='GET'?route.continue():route.abort());
await context.route('**/api/v1/health',route=>route.fulfill({json:{status:'ready',active_run:null,gateway:{status:'ready'}}}));
const sockets=new Map();
await context.routeWebSocket('**/api/v1/runs/*/stream',socket=>{
 const id=new URL(socket.url()).pathname.split('/')[4];
 if(!sockets.has(id))sockets.set(id,[]);sockets.get(id).push(socket);
});
const signals=events=>Object.assign({},...events.filter(event=>event.protocol==='CAN'&&event.kind==='tx').map(event=>event.decoded||{}));
async function packet(record,time){
 const timeline=await get(`/runs/${record.id}/timeline?at=${time}&window=0.25`);
 return {type:'replay',run:record,cursor:time,...timeline,signals:signals(timeline.events),faults:record.configuration.faults.filter(f=>f.at<=time&&time<f.at+f.duration)};
}
async function send(record,time,type='replay'){
 const value=await packet(record,time);value.type=type;
 for(const socket of sockets.get(record.id)||[])socket.send(JSON.stringify(value));return value;
}
async function shot(page,name,selector,source,details={},region){
 await page.mouse.move(0,0);await page.keyboard.press('Escape').catch(()=>{});
 const target=selector?page.locator(selector):page;
 if(region){
  const [bounds,start,end]=await Promise.all([target.boundingBox(),target.locator(region.start).boundingBox(),target.locator(region.end).boundingBox()]);
  const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
  await page.screenshot({path:assets+name+'.png',fullPage:true,clip:{x:bounds.x+scroll.x,y:start.y+scroll.y,width:bounds.width,height:end.y+end.height-start.y+8}});
 }else await target.screenshot({path:assets+name+'.png'});
 metadata.assets[name]={file:`screenshots/${name}.png`,...source,...details};
}
async function dashboard(record,time){
 const page=await context.newPage();await page.goto(origin+'/');
 await page.getByRole('combobox',{name:'Recorded run'}).selectOption(record.id);
 await page.waitForFunction(()=>document.querySelector('.connection-dot.on'));
 await send(record,time);
 await page.getByRole('slider',{name:'Replay time'}).waitFor();
 return page;
}
const source={run_id:run.id,route:run.route.name,sample_time:8,kind:'recorded replay'};
const engineering=await dashboard(run,8);
await shot(engineering,'engineering-overview',null,source);
await shot(engineering,'engineering-route','.drive-panel',source);
await shot(engineering,'engineering-network','.network-panel',source);
await shot(engineering,'architecture-contracts','#architecture-view',source);
await shot(engineering,'recordings-export','.recordings-panel',source);
await engineering.getByRole('link',{name:'All signals CSV ↗'}).focus();
await shot(engineering,'signals-export-choice','.recordings-panel',source,{description:'Keyboard focus highlights the All signals CSV export link; no download or server write was performed.'});
await shot(engineering,'communication-events','.events-panel',source);
await shot(engineering,'replay-controls','.recordings-panel',source);
await engineering.getByRole('button',{name:'Rerun configuration'}).focus();
await shot(engineering,'rerun-configuration','.recordings-panel',source,{description:'Saved configuration selected; rerun button focused without starting a new run.'});
for(const time of [2,3,4,5,6,7,8])await send(run,time,'tick');
await shot(engineering,'truth-normal','.drive-panel',source,{description:'Ground truth and reported speed from saved normal-drive samples; tick packets populate the UI chart locally.'});
const faultPage=await dashboard(faultRun,2);
for(const time of [.5,1,1.25,1.5,1.75,2])await send(faultRun,time,'tick');
await shot(faultPage,'truth-substituted','.workspace',{run_id:faultRun.id,sample_time:2,kind:'recorded sensor substitution',fault:faultRun.configuration.faults[0]});
const faultSelect=faultPage.locator('.fault-panel select');
await faultSelect.nth(0).selectOption('sensor');await faultSelect.nth(1).selectOption('substitute');
await faultSelect.nth(2).selectOption('Speed');await faultPage.locator('.fault-panel input').nth(0).fill('80');
await faultPage.locator('.fault-panel input').nth(1).fill('2');
await shot(faultPage,'fault-configuration','.fault-panel',{run_id:faultRun.id,sample_time:2,kind:'recorded fault with matching settings shown',fault:faultRun.configuration.faults[0]},{description:'Form settings shown for explanation; no fault was injected into the finished recording. Active badge is reconstructed from its saved schedule.'});
const outagePage=await dashboard(outageRun,1.1);
await outagePage.locator('.trace-filters button').getByText('FAULT',{exact:true}).click();
await shot(outagePage,'controller-outage','.events-panel',{run_id:outageRun.id,sample_time:1.1,kind:'recorded controller outage',fault:outageRun.configuration.faults[0]});
const gallery=await context.newPage();await gallery.goto(origin+'/image-similarity');
await gallery.locator('.capture-card').first().waitFor();await gallery.locator('.capture-match').first().waitFor();
const repeated=history.items.find(item=>history.items.some(other=>other.image_id===item.image_id&&(other.run_id!==item.run_id||other.station_index!==item.station_index)));
const imageChoice=gallery.getByRole('button',{name:`Inspect capture ${repeated.run_id.slice(0,8)} at ${repeated.station_index*25} m`,exact:true});
if(!await imageChoice.count())await gallery.getByRole('combobox',{name:'Image capture drive'}).selectOption(repeated.run_id);
await imageChoice.click();await gallery.getByTestId('image-similarity').getByText(/100.0% closest match/).waitFor();
const imageSource={run_id:repeated.run_id,station_index:repeated.station_index,provider_image_id:repeated.provider_image_id,source_captured_at:repeated.captured_at,lat:repeated.lat,lng:repeated.lng,phash:repeated.phash,kind:'saved Mapillary source image; browser gallery screenshot'};
await shot(gallery,'similarity-dashboard',null,imageSource);
await shot(gallery,'similarity-exact','.capture-inspector',imageSource,{description:'Cropped to source metadata, similarity summary and the first three comparisons so exact repeats and a below-threshold example remain legible.'},{start:'.capture-details',end:'.capture-match:nth-child(3)'});
await shot(gallery,'image-provenance','.capture-details',imageSource);
await gallery.getByRole('checkbox').check();await gallery.locator('.capture-match').first().waitFor();
await shot(gallery,'similarity-matching-only','.capture-inspector',imageSource);
const driver=await context.newPage();await driver.goto(`${origin}/driver/${run.id}`);
await driver.getByText('Connected',{exact:true}).waitFor();await send(run,8);
await driver.locator('.panorama-slot.visible').waitFor({timeout:35000}).catch(()=>{});
await shot(driver,'driver-view',null,source,{street_view_available:await driver.locator('.panorama-slot.visible').count()>0});
await driver.frameLocator('iframe').locator('#charge').waitFor();
await driver.frameLocator('iframe').locator('.cluster').screenshot({path:assets+'driver-instruments.png'});
metadata.assets['driver-instruments']={file:'screenshots/driver-instruments.png',...source,description:'Independent instrument frame using saved simulator ground truth.'};
await shot(driver,'imagery-example','.driver-scene',source);
let warningStaged=false;
const actual=await get(`/runs/${run.id}/images/${Math.floor((run.route.distance-(await packet(run,8)).state.remaining)/25)}/similarity`);
if(!actual.too_similar){
 warningStaged=true;
 await driver.route('**/api/v1/runs/*/images/*/similarity',route=>route.fulfill({json:{...actual,status:'ready',similar_count:5,too_similar:true,nearest_similarity_pct:100}}));
}
await driver.frameLocator('iframe').locator('#similarity-warning').waitFor({state:'visible',timeout:6000});
await shot(driver,'driver-similarity-warning',null,source,{kind:warningStaged?'illustrative warning state on recorded driver view':'recorded view with actual database warning',description:warningStaged?'Only the comparison response is staged at five matches to illustrate the warning. No captures or hashes are inserted.':'Warning computed from the saved capture database.'});
const routePage=await context.newPage();await routePage.goto(origin+'/');await routePage.getByRole('combobox',{name:'Route'}).waitFor();
const map=routePage.locator('.route-map .leaflet-container');await map.click({position:{x:190,y:150}});await map.click({position:{x:340,y:210}});
await shot(routePage,'route-pins','.drive-panel',{kind:'illustrative route-selection UI',description:'Example map pins selected in the browser; no route preparation request was submitted.'});
await routePage.getByRole('button',{name:'Reset pins'}).click();
await shot(routePage,'route-prepared','.drive-panel',{kind:'actual bundled prepared route',route:run.route.name,description:'Bundled route loaded from the real API; screenshot illustrates reviewing a prepared route before Start drive.'});
await writeFile(assets+'provenance.json',JSON.stringify(metadata,null,2));
console.log(JSON.stringify({screenshots:Object.keys(metadata.assets).length,recording:run.id,faultRecording:faultRun.id,warningStaged,streetView:metadata.assets['driver-view'].street_view_available}));
await browser.close();
