import {test,expect,type WebSocketRoute} from '@playwright/test';

const origin={lat:57.7,lng:11.97};
const run={id:'instrument-test',status:'running',time:20,route:{id:'test',name:'Gothenburg · Nya Allén',distance:371.49,geometry:[origin,{...origin,lat:57.704}],start:origin,destination:{...origin,lat:57.704},attribution:'Test road'},configuration:{vehicle:{capacity_wh:60000}},recording_valid:true};
const state={...origin,time:3.5,heading:90,speed:12.5,speed_limit:13.89,remaining:250,distance:371.49,progress:.33,charge_pct:79.8,energy_wh:47880,power_w:15000,lane_index:0,arrived:false,red_light:false};

test('split driver has independent instruments, live ground truth, warnings and aligned replay',async({page})=>{
 const sockets:WebSocketRoute[]=[];
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.route('**/api/v1/runs/instrument-test',route=>route.fulfill({json:run}));
 await page.routeWebSocket('**/api/v1/runs/instrument-test/stream',ws=>sockets.push(ws));
 await page.goto('/driver/instrument-test');
 const frame=page.frameLocator('iframe[title="Vehicle instrument dashboard"]');
 await expect(frame.getByText('Connected',{exact:true})).toBeVisible();
 await expect.poll(()=>sockets.length).toBe(2);
 for(const socket of sockets)socket.send(JSON.stringify({type:'tick',run,state,signals:{Speed:99,Charge:1}}));
 await expect(frame.getByTestId('instrument-speed')).toHaveText('45');
 await expect(frame.locator('#limit')).toHaveText('50');
 await expect(frame.getByTestId('instrument-charge')).toHaveText('79.8');
 await expect(frame.getByText('60 kWh EV')).toBeVisible();
 const instrument=await page.locator('.instrument-pane').boundingBox(),scene=await page.locator('.driver-scene').boundingBox();
 expect(instrument!.x+instrument!.width).toBeLessThanOrEqual(scene!.x+1);expect(instrument!.width).toBeCloseTo(scene!.width,0);
 expect(instrument!.x).toBe(0);expect(scene!.x+scene!.width).toBe(page.viewportSize()!.width);
 for(const socket of sockets)socket.send(JSON.stringify({type:'tick',run,state:{...state,speed_limit:8.33}}));
 await expect(frame.locator('#limit')).toHaveText('30');
 for(const socket of sockets)socket.send(JSON.stringify({type:'replay',run:{...run,status:'completed'},state:{...state,time:1,speed:0,charge_pct:7,energy_wh:4200,remaining:346.49,progress:25/371.49,power_w:-12000,red_light:true}}));
 await expect(frame.getByTestId('instrument-speed')).toHaveText('0');await expect(frame.getByTestId('instrument-charge')).toHaveText('7.0');
 await expect(frame.getByText('REPLAY',{exact:true})).toBeVisible();await expect(frame.getByTestId('instrument-time')).toHaveText('1.0 s');
 await expect(frame.locator('#warnings')).toContainText('LOW BATTERY');await expect(frame.locator('#warnings')).toContainText('RED TRAFFIC SIGNAL');
 await expect(frame.locator('#power-fill')).toHaveClass('regen');await expect(page.getByTestId('panorama')).toHaveAttribute('data-station','1');
 await expect(page.getByRole('link',{name:'Open instruments separately'})).toHaveAttribute('href','/instruments/?run=instrument-test');
});

test('instrument container works directly, reconnects and remains alive when the driver closes',async({page,context})=>{
 const sockets:WebSocketRoute[]=[];
 await context.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await context.route('**/api/v1/runs/instrument-test',route=>route.fulfill({json:run}));
 await context.routeWebSocket('**/api/v1/runs/instrument-test/stream',ws=>sockets.push(ws));
 const direct=await context.newPage();await direct.goto('http://localhost:8081/?run=instrument-test');
 await expect(direct.getByText('Connected',{exact:true})).toBeVisible();
 sockets[0].send(JSON.stringify({type:'tick',run,state}));await expect(direct.getByTestId('instrument-speed')).toHaveText('45');
 sockets[0].close();await expect(direct.getByText('Reconnecting',{exact:true})).toBeVisible();
 await expect.poll(()=>sockets.length).toBe(2);await expect(direct.getByText('Connected',{exact:true})).toBeVisible();
 await page.goto('/driver/instrument-test');await expect(page.getByText('Connected',{exact:true})).toBeVisible();await page.close();
 sockets[1].send(JSON.stringify({type:'tick',run,state:{...state,speed:10,time:4}}));
 await expect(direct.getByTestId('instrument-speed')).toHaveText('36');await expect(direct.getByTestId('instrument-time')).toHaveText('4.0 s');
 expect((await direct.request.get('http://localhost:8081/health')).status()).toBe(200);
 await direct.close();
});

test('linked reveal.js deck loads locally, navigates and fits every slide',async({page})=>{
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.goto('/');
 await expect(page.locator('header img[alt="Metriczone measurement ecosystem"]')).toBeVisible();
 await expect(page.getByRole('link',{name:'Presentation ↗'})).toHaveAttribute('href','/presentation/');
 await page.goto('/presentation/');
 await expect(page.locator('.slides section.present h1')).toHaveText('Inside a software-defined vehicle');
 await page.keyboard.press('ArrowRight');await expect(page.locator('.slides section.present:not(.stack) h2')).toHaveText('A short drive through Gothenburg');
 const count=await page.locator('.slides>section').count();expect(count).toBe(19);
 await expect(page.locator('.slides h2').filter({hasText:'Captured images and pHash matching'})).toHaveCount(1);
 await expect(page.locator('.slides h2').filter({hasText:'Similarity warnings during driving'})).toHaveCount(1);
 const chapters=await page.locator('.slides>section').evaluateAll(sections=>sections.map(section=>section.querySelectorAll(':scope>section').length||1));
 expect(chapters.reduce((sum,n)=>sum+n,0)).toBe(71);
 expect(chapters[2]).toBe(17); // Docker overview plus each of the 16 services.
 await page.evaluate(()=>(window as any).Reveal.slide(1,1));
 await expect(page.locator('.slide-number')).toHaveText('2.1 / 19');
 for(let index=0;index<count;index++)for(let vertical=0;vertical<chapters[index];vertical++){
  await page.evaluate(([h,v])=>(window as any).Reveal.slide(h,v),[index,vertical]);
  const overflow=await page.evaluate(()=>{
   const section=(window as any).Reveal.getCurrentSlide(),bounds=section.getBoundingClientRect();
   return {height:bounds.height,viewport:innerHeight-94,width:bounds.width,viewportWidth:innerWidth};
  });
  expect(overflow.height,`slide ${index+1}.${vertical} height`).toBeLessThanOrEqual(overflow.viewport+3);
  expect(overflow.width,`slide ${index+1}.${vertical} width`).toBeLessThanOrEqual(overflow.viewportWidth+3);
 }
 await page.goto('/presentation/?print-pdf');await expect(page.locator('html')).toHaveClass(/print-pdf/);
});

