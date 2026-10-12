import {test,expect} from '@playwright/test';

const origin={lat:57.7,lng:11.97};
const run={id:'drive-new',status:'completed',time:5,route:{id:'gothenburg-demo',name:'Gallery test route',distance:100,geometry:[origin,{...origin,lat:57.701}],start:origin,destination:{...origin,lat:57.701},attribution:'Test road'},configuration:{vehicle:{}},results:[],recording_valid:true};
const capture=(run_id:string,station_index:number,image_id='same-image')=>({run_id,station_index,image_id,provider_image_id:image_id==='same-image'?'123':'456',phash:image_id==='same-image'?'8000000000000000':'ffffffff00000000',sim_time:station_index,lat:57.7,lng:11.97,captured_at:1700000000000,bytes:100});
const captures=[capture('drive-new',1,'other-image'),capture('drive-new',0),capture('drive-old',0)];

test('engineering button opens a drive-filtered gallery and repeated captures show 100% across drives',async({page,context})=>{
 let uploads=0;
 await context.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await context.route('**/api/v1/health',route=>route.fulfill({json:{status:'ready',active_run:null}}));
 await context.route('**/api/v1/routes',route=>route.fulfill({json:[run.route]}));
 await context.route('**/api/v1/runs',route=>route.fulfill({json:[run]}));
 await context.route('**/api/v1/runs/drive-new',route=>route.fulfill({json:run}));
 await context.route('**/api/v1/runs/drive-new/timeline?*',route=>route.fulfill({json:{state:null,events:[]}}));
 await context.routeWebSocket('**/api/v1/runs/drive-new/stream',()=>{});
 await context.route('**/api/v1/images/*',route=>route.fulfill({contentType:'image/png',path:'tests/browser/fixtures/tiny.png'}));
 await context.route('**/api/v1/image-captures?*',route=>{
  const requested=new URL(route.request().url()).searchParams.get('run_id');const items=captures.filter(c=>!requested||c.run_id===requested);
  return route.fulfill({json:{total:items.length,items,runs:[{run_id:'drive-new',captures:2},{run_id:'drive-old',captures:1}],database_images:2,database_captures:3}});
 });
 await context.route('**/api/v1/image-captures/*/*/similarity*',route=>{
  const url=new URL(route.request().url()),parts=url.pathname.split('/'),current=captures.find(c=>c.run_id===parts[4]&&c.station_index===Number(parts[5]))!;
  let others=captures.filter(c=>c!==current).map(c=>({...c,distance:c.image_id===current.image_id?0:32,similarity_pct:c.image_id===current.image_id?100:50,is_match:c.image_id===current.image_id,exact_image:c.image_id===current.image_id})).sort((a,b)=>a.distance-b.distance);
  const count=others.filter(c=>c.is_match).length,closest=others[0]?.similarity_pct??null;
  if(url.searchParams.get('matches_only')==='true')others=others.filter(c=>c.is_match);
  return route.fulfill({json:{status:'ready',...current,database_images:2,database_captures:3,hash_bits:64,max_distance:8,warning_count:5,similar_count:count,similar_image_count:count?1:0,nearest_similarity_pct:closest,too_similar:false,comparison_total:others.length,comparisons:others,matches:others.filter(c=>c.is_match)}});
 });
 context.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/images/'))uploads++});
 await page.goto('/');await page.getByRole('combobox',{name:'Recorded run'}).selectOption(run.id);
 const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Open image similarity dashboard ↗',exact:true}).click();const gallery=await popupPromise;
 await expect(gallery).toHaveURL(/\/image-similarity\?run=drive-new/);
 await expect(gallery.getByRole('combobox',{name:'Image capture drive'})).toHaveValue('drive-new');
 await expect(gallery.locator('.capture-card')).toHaveCount(2);
 await gallery.getByRole('button',{name:'Inspect capture drive-ne at 0 m',exact:true}).click();
 await expect(gallery.getByTestId('image-similarity')).toContainText('100.0% closest match');
 await expect(gallery.getByTestId('image-similarity')).toContainText('1 similar captures');
 await expect(gallery.locator('.capture-match').first()).toContainText('Drive drive-ol');
 await expect(gallery.locator('.capture-match').first()).toContainText('Same image');
 await gallery.getByRole('checkbox').check();await expect(gallery.locator('.capture-match')).toHaveCount(1);
 await gallery.getByRole('combobox',{name:'Image capture drive'}).selectOption('');await expect(gallery.locator('.capture-card')).toHaveCount(3);
 await gallery.getByRole('button',{name:'Refresh images'}).click();await expect(gallery.locator('.capture-card')).toHaveCount(3);
 expect(uploads).toBe(0);await gallery.close();
});

test('empty capture history and storage errors are explicit and refresh recovers',async({page})=>{
 let calls=0;
 await page.route('**/api/v1/image-captures?*',route=>{
  calls++;return calls===1?route.fulfill({status:503,json:{detail:'Unavailable'}}):route.fulfill({json:{total:0,items:[],runs:[],database_images:0,database_captures:0}});
 });
 await page.goto('/image-similarity');await expect(page.getByRole('alert')).toContainText('could not load');
 await page.getByRole('button',{name:'Refresh images'}).click();await expect(page.getByText('No captured images for this selection.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Next images'})).toBeDisabled();
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('real retained history exposes exact repeats in the browsing dashboard',async({page,request})=>{
 const response=await request.get('/api/v1/image-captures?limit=100');expect(response.ok()).toBe(true);
 const value=await response.json();const repeated=value.items.find((capture:any)=>value.items.some((other:any)=>other.image_id===capture.image_id&&(other.run_id!==capture.run_id||other.station_index!==capture.station_index)));
 test.skip(!repeated,'No repeated captured images in this installation');
 await page.goto('/image-similarity');
 const choice=page.getByRole('button',{name:`Inspect capture ${repeated.run_id.slice(0,8)} at ${repeated.station_index*25} m`,exact:true});
 if(!await choice.count())await page.getByRole('combobox',{name:'Image capture drive'}).selectOption(repeated.run_id);
 await choice.click();await expect(page.getByTestId('image-similarity')).toContainText('100.0% closest match');
 await expect(page.locator('.capture-match').first()).toContainText('100.0% similarity');
});
