import {test,expect,type WebSocketRoute} from '@playwright/test';

test('engineering dashboard compares the current station and discards a late earlier result',async({page})=>{
 const origin={lat:57.7,lng:11.97};
 const run={id:'similarity-dashboard',status:'running',time:20,route:{id:'gothenburg-demo',name:'Test road',distance:200,geometry:[origin,{...origin,lat:57.702}],start:origin,destination:{...origin,lat:57.702},attribution:'Test route'},configuration:{},recording_valid:true};
 const sockets:WebSocketRoute[]=[];let releaseOld:(()=>void)|undefined;
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.route('**/api/v1/health',route=>route.fulfill({json:{status:'ready',active_run:null}}));
 await page.route('**/api/v1/routes',route=>route.fulfill({json:[run.route]}));
 await page.route(/\/api\/v1\/runs(?:\?.*)?$/,route=>route.fulfill({json:[run]}));
 await page.route('**/api/v1/runs/similarity-dashboard',route=>route.fulfill({json:run}));
 await page.route('**/api/v1/runs/similarity-dashboard/events?*',route=>route.fulfill({json:[]}));
 await page.routeWebSocket('**/api/v1/runs/similarity-dashboard/stream',ws=>sockets.push(ws));
 await page.route('**/api/v1/runs/similarity-dashboard/images/*/similarity',async route=>{
  const index=Number(new URL(route.request().url()).pathname.split('/')[6]);
  if(index===0)await new Promise<void>(resolve=>releaseOld=resolve);
  await route.fulfill({json:{status:'ready',run_id:run.id,station_index:index,database_images:8,similar_count:index===2?0:5,
   too_similar:index!==2,nearest_similarity_pct:index===2?50:96.875,hash_bits:64,max_distance:8,warning_count:5}}).catch(()=>{});
 });
 await page.goto('/');await page.getByRole('combobox',{name:'Recorded run'}).selectOption(run.id);
 await expect.poll(()=>sockets.length).toBe(1);
 await expect.poll(()=>!!releaseOld).toBe(true);
 const send=(travelled:number)=>sockets[0].send(JSON.stringify({type:'tick',run,state:{...origin,time:1,speed:3,charge_pct:80,remaining:200-travelled,progress:travelled/200}}));
 send(25);const card=page.getByTestId('image-similarity');
 await expect(card).toContainText('25 m point');await expect(card).toContainText('5 similar captures');
 await expect(card.getByRole('alert')).toContainText('Drive to another place');
 releaseOld!();await page.waitForTimeout(100);await expect(card).toContainText('25 m point');
 send(50);await expect(card).toContainText('0 similar captures');await expect(card.getByRole('alert')).toHaveCount(0);
});

