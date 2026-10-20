import {test,expect} from '@playwright/test';

const id='d8d78b83-02f8-4607-aa84-c3dd902cc997';
const route={id:'carla-city',backend:'carla',name:'CARLA city',distance:500,geometry:[],start:{lat:0,lng:0},destination:{lat:0,lng:0},attribution:'CARLA'};

for(const dashboard of ['engineering','portal']){
 test(`${dashboard} applies graphics and preview choices to the next drive`,async({page})=>{
  let submitted:any,run:any;
  await page.route('**/api/v1/routes',r=>r.fulfill({json:[route]}));
  await page.route('**/api/v1/health',r=>r.fulfill({json:{status:'ready',active_run:null}}));
  await page.route('**/api/v1/carla/status',r=>r.fulfill({json:{status:'idle',renderer:'nvidia'}}));
  await page.route('**/api/v1/runs?summary=true',r=>r.fulfill({json:[]}));
  await page.route('**/api/v1/runs',async r=>{
   submitted=r.request().postDataJSON();
   run={id,status:'created',time:0,route,configuration:submitted,results:[],recording_valid:true};
   await r.fulfill({json:run});
  });
  await page.route(`**/api/v1/runs/${id}`,r=>r.fulfill({json:run}));
  await page.route(`**/api/v1/runs/${id}/start`,r=>{run={...run,status:'starting'};return r.fulfill({json:run})});
  await page.routeWebSocket(`**/api/v1/runs/${id}/stream`,socket=>socket.send(JSON.stringify({type:'snapshot',run:{...run,status:'starting'}})));
  await page.goto(dashboard==='engineering'?'/':'/carla');
  const graphics=page.getByRole('combobox',{name:'CARLA graphics quality'});
  const resolution=page.getByRole('combobox',{name:'CARLA preview resolution'});
  await expect(graphics).toHaveValue('high');await expect(resolution).toHaveValue('1080p');
  await graphics.selectOption('low');await resolution.selectOption('720p');
  await page.reload();
  await expect(graphics).toHaveValue('low');await expect(resolution).toHaveValue('720p');
  await page.getByRole('button',{name:dashboard==='engineering'?'▶ Start drive':'▶ Start city drive',exact:true}).click();
  await expect(graphics).toBeDisabled();await expect(resolution).toBeDisabled();
  expect(submitted.carla).toEqual({graphics:'low',resolution:'720p'});
  await expect(page.getByText('Low graphics · 720p previews',{exact:true})).toBeVisible();
 });
}

test('engineering and portal share saved choices across open windows',async({page,context})=>{
 await page.goto('/');
 const portal=await context.newPage();await portal.goto('/carla');
 await expect(portal.getByRole('combobox',{name:'CARLA graphics quality'})).toHaveValue('high');
 await page.getByRole('combobox',{name:'CARLA graphics quality'}).selectOption('low');
 await page.getByRole('combobox',{name:'CARLA preview resolution'}).selectOption('720p');
 await expect(portal.getByRole('combobox',{name:'CARLA graphics quality'})).toHaveValue('low');
 await expect(portal.getByRole('combobox',{name:'CARLA preview resolution'})).toHaveValue('720p');
 await portal.getByRole('combobox',{name:'CARLA graphics quality'}).selectOption('high');
 await portal.getByRole('combobox',{name:'CARLA preview resolution'}).selectOption('1080p');
 await expect(page.getByRole('combobox',{name:'CARLA graphics quality'})).toHaveValue('high');
 await expect(page.getByRole('combobox',{name:'CARLA preview resolution'})).toHaveValue('1080p');
 await portal.close();
});
