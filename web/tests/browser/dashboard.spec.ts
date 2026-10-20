import {test,expect,type WebSocketRoute} from '@playwright/test';
test('CARLA architecture, recorded sequence and complete signal export',async({page})=>{
 await page.goto('/');
 await expect(page.getByRole('combobox',{name:'Route'})).toHaveValue('carla-city');
 const route=(await (await page.request.get('/api/v1/routes')).json())[0];
 expect(route.backend).toBe('carla');expect(route.world).toBe('Town10HD_Opt');
 expect(route.scenario.pedestrians).toBe(48);expect(route.distance).toBe(500);
 const architecture=page.getByRole('region',{name:'Vehicle E/E architecture'});
 await expect(architecture).toBeVisible();
 await architecture.getByRole('button',{name:'Inspect bms',exact:true}).click();
 await expect(architecture.getByText('Contracts for bms',{exact:true})).toBeVisible();
 await architecture.getByRole('button',{name:/CAN 0x110/}).click();
 await expect(architecture.locator('.signal-contract-grid').getByText('Charge',{exact:true})).toBeVisible();
 await expect(architecture.locator('.signal-contract-grid').getByText('PropulsionLimit',{exact:true})).toBeVisible();
 await architecture.getByRole('button',{name:'Show all nodes'}).click();
 const run=await (await page.request.post('/api/v1/runs',{data:{duration:1}})).json();
 await page.request.post('/api/v1/runs/'+run.id+'/start');
 await expect.poll(async()=> (await (await page.request.get('/api/v1/runs/'+run.id)).json()).status,{timeout:15000}).toBe('timed_out');
 await page.reload();await page.getByRole('combobox',{name:'Recorded run'}).selectOption(run.id);
 const sequence=page.getByRole('region',{name:'ECU communication sequence'});
 await expect(sequence.locator('.sequence-message').first()).toBeVisible({timeout:10000});
 await page.request.post('/api/v1/runs/'+run.id+'/replay',{data:{at:.5}});
 await expect(sequence.getByText('REPLAY · 0.50 s')).toBeVisible();
 await expect(sequence.locator('.sequence-message').filter({hasText:'Sensors'}).first()).toBeVisible();
 await page.getByRole('combobox',{name:'Sequence transport'}).selectOption('SOME/IP');
 await expect(sequence.locator('.sequence-message').filter({hasText:'Sensors'})).toHaveCount(0);
 const exported=await page.request.get(`/api/v1/runs/${run.id}/export?format=signals`);
 expect(exported.status()).toBe(200);expect(exported.headers()['content-disposition']).toContain('.signals.csv');
 const text=await exported.text();expect(text).toContain('source,destination,direction');expect(text).toContain(',Speed,');expect(text).toContain(',target_speed,');
 expect(text).toContain(',sensor,CAN bus,transmit,');expect(text).toContain(',sensor,controller,receive,');
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'All signals CSV ↗'}).click();
 expect((await download).suggestedFilename()).toBe(`${run.id}.signals.csv`);
});
test('saved configuration reruns with its vehicle profile and seed',async({page})=>{
 const initial=await (await page.request.post('/api/v1/runs',{data:{duration:1,seed:17,vehicle:{charge_pct:40}}})).json();
 await page.request.post('/api/v1/runs/'+initial.id+'/start');
 await expect.poll(async()=> (await (await page.request.get('/api/v1/runs/'+initial.id)).json()).status,{timeout:15000}).toBe('timed_out');
 await page.goto('/');await page.getByRole('combobox',{name:'Recorded run'}).selectOption(initial.id);
 await expect(page.getByRole('button',{name:'Rerun configuration'})).toBeEnabled();
 const created=page.waitForResponse(r=>r.url().endsWith('/api/v1/runs')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Rerun configuration'}).click();const next=await (await created).json();
 expect(next.configuration.seed).toBe(17);expect(next.configuration.vehicle.charge_pct).toBe(40);expect(next.configuration.duration).toBe(1);
 await expect.poll(async()=> (await (await page.request.get('/api/v1/runs/'+next.id)).json()).status,{timeout:15000}).toBe('timed_out');
});
test('dashboard launches and driver stays connected when engineering closes',async({page,context})=>{
 // A finished run can still be releasing the plant and committing its metadata.
 await expect.poll(async()=> (await (await page.request.get('/api/v1/health')).json()).active_run,{timeout:15000}).toBeNull();
 await context.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your vehicle. Your test bench.'})).toBeVisible();
 await expect(page.getByRole('button',{name:'▶ Start drive'})).toBeEnabled();
 await page.getByRole('button',{name:'▶ Start drive'}).click();
 await expect(page.getByRole('button',{name:'■ Stop'})).toBeEnabled({timeout:15000});
 const popupPromise=context.waitForEvent('page');await page.getByRole('button',{name:'Open driver’s view ↗'}).click();const driver=await popupPromise;
 const rid=driver.url().split('/').pop();
 try{
  await expect(driver.getByText('DRIVER’S VIEW')).toBeVisible();await expect(driver.getByText('Connected',{exact:true})).toBeVisible();
  await expect(driver.getByAltText('CARLA first-person driver camera')).toBeVisible({timeout:15000});
  await page.close();await expect(driver.getByText('Connected',{exact:true})).toBeVisible();
 }finally{if(rid)await context.request.post('/api/v1/runs/'+rid+'/stop');await driver.close()}
});

