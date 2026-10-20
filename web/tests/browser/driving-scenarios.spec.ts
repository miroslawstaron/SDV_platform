import {test,expect} from '@playwright/test';

for(const dashboard of ['engineering','portal']){
 test(`${dashboard} previews, saves and starts a prompt scenario`,async({page})=>{
  const id='e6cb7f94-5fb7-4b90-998d-8e4df6936256';
  let scenario:any,submitted:any,run:any;
  await page.route('**/api/v1/health',r=>r.fulfill({json:{status:'ready',active_run:null}}));
  await page.route('**/api/v1/runs?summary=true',r=>r.fulfill({json:[]}));
  await page.route('**/api/v1/runs',async r=>{submitted=r.request().postDataJSON();run={id,status:'created',time:0,recording_valid:true,configuration:{...submitted,scenario},results:[],route:{id:'carla-city',name:scenario.name,backend:'carla',geometry:[],distance:scenario.settings.distance_m,scenario:scenario.settings}};await r.fulfill({json:run})});
  await page.route(`**/api/v1/runs/${id}`,r=>r.fulfill({json:run}));
  await page.route(`**/api/v1/runs/${id}/start`,r=>{run={...run,status:'starting'};return r.fulfill({json:run})});
  await page.routeWebSocket(`**/api/v1/runs/${id}/stream`,socket=>socket.send(JSON.stringify({type:'snapshot',run:{...run,status:'starting'}})));
  try{
   await page.goto(dashboard==='engineering'?'/':'/carla');
   await page.getByText('Describe a scenario from a text prompt',{exact:true}).click();
   await page.getByRole('button',{name:'Rain at night',exact:true}).click();
   await page.getByRole('textbox',{name:'Scenario name',exact:true}).fill(`Browser prompt ${dashboard}`);
   await page.getByRole('button',{name:'Preview scenario',exact:true}).click();
   const preview=page.getByRole('region',{name:'Interpreted driving scenario'});
   await expect(preview.locator('dd')).toHaveText(['12','6','25 km/h','500 m','120 s','heavy rain','night','normal','42']);
   const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios')&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Save & use scenario',exact:true}).click();scenario=await (await saved).json();
   await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toHaveValue(scenario.id);
   await page.reload();
   await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toHaveValue(scenario.id);
   await page.getByRole('button',{name:dashboard==='engineering'?'▶ Start drive':'▶ Start city drive',exact:true}).click();
   await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toBeDisabled();
   expect(submitted.scenario_id).toBe(scenario.id);
   await expect(page.getByText(`Recorded scenario: ${scenario.name}`,{exact:true})).toBeVisible();
  }finally{if(scenario?.id)await page.request.delete(`/api/v1/scenarios/${scenario.id}`)}
 });
}

test('uninterpreted actions require explicit review and edits invalidate the preview',async({page})=>{
 await page.goto('/carla');
 await page.getByText('Describe a scenario from a text prompt',{exact:true}).click();
 await page.getByRole('textbox',{name:'Scenario name',exact:true}).fill('Unscripted action');
 const prompt=page.getByRole('textbox',{name:'Driving scenario prompt',exact:true});
 await prompt.fill('10 pedestrians and an ambulance overtakes then turn left');
 await page.getByRole('button',{name:'Preview scenario',exact:true}).click();
 const warning=page.getByRole('alert').filter({hasText:'Instructions not interpreted'});
 await expect(warning).toContainText('ambulance');await expect(warning).toContainText('turn');
 const save=page.getByRole('button',{name:'Save & use scenario',exact:true});
 await expect(save).toBeDisabled();
 await page.getByRole('checkbox',{name:'Use recognized settings only'}).check();
 await expect(save).toBeEnabled();
 await prompt.fill('No pedestrians and no traffic in clear daytime');
 await expect(save).toBeDisabled();
 await expect(warning).toHaveCount(0);
 await page.getByRole('button',{name:'Preview scenario',exact:true}).click();
 await expect(page.getByRole('region',{name:'Interpreted driving scenario'}).locator('dd')).toHaveText(['0','0','25 km/h','500 m','180 s','clear','day','normal','42']);
 await expect(save).toBeEnabled();
});

test('saved scenarios can be updated, copied and deleted without starting a drive',async({page})=>{
 const ids:string[]=[];
 try{
  await page.goto('/carla');
  await page.getByText('Describe a scenario from a text prompt',{exact:true}).click();
  await page.getByRole('button',{name:'Quiet daytime',exact:true}).click();
  await page.getByRole('textbox',{name:'Scenario name',exact:true}).fill('Library browser test');
  await page.getByRole('button',{name:'Preview scenario',exact:true}).click();
  let response=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Save & use scenario',exact:true}).click();
  const original=await (await response).json();ids.push(original.id);
  await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toHaveValue(original.id);
  await page.getByRole('textbox',{name:'Driving scenario prompt',exact:true}).fill('10 pedestrians and 4 cars in fog at sunset');
  await page.getByRole('button',{name:'Preview scenario',exact:true}).click();
  response=page.waitForResponse(r=>r.url().endsWith(`/scenarios/${original.id}`)&&r.request().method()==='PUT');
  await page.getByRole('button',{name:'Update & use scenario',exact:true}).click();
  const updated=await (await response).json();expect(updated.settings.weather).toBe('fog');expect(updated.settings.pedestrians).toBe(10);
  await expect(page.locator('.scenario-selected')).toContainText('10 pedestrians');
  response=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Save as new',exact:true}).click();
  const copied=await (await response).json();ids.push(copied.id);expect(copied.id).not.toBe(original.id);
  await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toHaveValue(copied.id);
  await page.getByRole('button',{name:'Delete scenario',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true})).toHaveValue('');
  await expect(page.getByRole('combobox',{name:'Driving scenario',exact:true}).locator(`option[value="${original.id}"]`)).toHaveCount(1);
  const library=await (await page.request.get('/api/v1/scenarios')).json();
  expect(library.some((s:any)=>s.id===original.id)).toBe(true);expect(library.some((s:any)=>s.id===copied.id)).toBe(false);
 }finally{for(const id of ids)await page.request.delete(`/api/v1/scenarios/${id}`)}
});
