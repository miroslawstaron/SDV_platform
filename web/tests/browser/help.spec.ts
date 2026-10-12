import {test,expect,type Page,type WebSocketRoute} from '@playwright/test';

const origin={lat:57.7,lng:11.97};
const run={id:'help-test',status:'running',time:5,route:{id:'gothenburg-demo',name:'Help test route',distance:200,geometry:[origin,{...origin,lat:57.702}],start:origin,destination:{...origin,lat:57.702},attribution:'Test route'},configuration:{vehicle:{capacity_wh:60000}},recording_valid:true};
async function dashboard(page:Page){
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.route('**/api/v1/health',route=>route.fulfill({json:{status:'ready',active_run:null}}));
 await page.route('**/api/v1/routes',route=>route.fulfill({json:[run.route]}));
 await page.route('**/api/v1/runs',route=>route.fulfill({json:[]}));
 await page.clock.install();await page.goto('/');
 await expect(page.getByRole('button',{name:'▶ Start drive'})).toBeEnabled();
 await expect(page.locator('#sdv-ui-help')).toBeAttached();
}

test('hover help waits three seconds, resets on another control, supports disabled controls and Escape',async({page})=>{
 await dashboard(page);const tip=page.getByRole('tooltip');
 await page.getByRole('button',{name:'▶ Start drive'}).hover();
 await page.clock.runFor(2500);await expect(tip).toBeHidden();
 await page.clock.runFor(1000);await expect(tip).toContainText('Start a new simulation');
 await expect(page.getByRole('button',{name:'▶ Start drive'})).toHaveAttribute('aria-describedby','sdv-ui-help');
 await page.getByRole('button',{name:'■ Stop'}).hover();await expect(tip).toBeHidden();
 await page.clock.runFor(2500);await expect(tip).toBeHidden();await page.clock.runFor(1000);
 await expect(tip).toContainText('finish its recording');await expect(tip).toContainText('currently unavailable');
 await page.keyboard.press('Escape');await expect(tip).toBeHidden();
 await expect(page.getByRole('button',{name:'■ Stop'})).not.toHaveAttribute('aria-describedby');
 await page.getByRole('link',{name:'Presentation ↗',exact:true}).hover();await page.clock.runFor(1000);
 await page.mouse.move(0,0);await page.clock.runFor(3500);await expect(tip).toBeHidden();
});

test('readings, maps, SVG controls and keyboard focus have explanations without native early tooltips',async({page})=>{
 await dashboard(page);const tip=page.getByRole('tooltip');
 await page.locator('.metrics>div').first().hover();await page.clock.runFor(3500);await expect(tip).toContainText('Actual vehicle speed');
 await page.locator('.route-map .map').hover({position:{x:120,y:120}});await page.clock.runFor(3500);await expect(tip).toContainText('choose a start');
 await page.getByRole('button',{name:'Inspect bms',exact:true}).hover();await page.clock.runFor(3500);await expect(tip).toContainText('Inspect the bms node');
 const input=page.getByRole('spinbutton',{name:'Initial charge'});await input.focus();await page.clock.runFor(3500);await expect(tip).toContainText('from 0 to 100%');
 await page.keyboard.press('Escape');await expect(tip).toBeHidden();
 await expect(page.locator('.signal-contract-grid [title]')).toHaveCount(0);
 await page.getByTestId('image-similarity').hover();await page.clock.runFor(3500);await expect(tip).toContainText('differing pHash bits / 64');
 const bounds=await tip.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 await page.mouse.wheel(0,300);await expect(tip).toBeHidden();
});

test('independent instrument readings get delayed help inside the iframe',async({page})=>{
 const sockets:WebSocketRoute[]=[];
 await page.route('**/api/v1/config',route=>route.fulfill({json:{mapillary_access_token:''}}));
 await page.route('**/api/v1/runs/help-test',route=>route.fulfill({json:run}));
 await page.route('**/api/v1/runs/help-test/images/*/similarity',route=>route.fulfill({json:{status:'awaiting_capture',too_similar:false}}));
 await page.routeWebSocket('**/api/v1/runs/help-test/stream',ws=>sockets.push(ws));
 await page.clock.install();await page.goto('/driver/help-test');
 const frame=page.frameLocator('iframe[title="Vehicle instrument dashboard"]');
 await expect(frame.locator('#sdv-ui-help')).toBeAttached();await expect.poll(()=>sockets.length).toBe(2);
 for(const socket of sockets)socket.send(JSON.stringify({type:'tick',run,state:{...origin,time:1,speed:5,remaining:190,charge_pct:80,heading:90}}));
 await frame.locator('#charge').hover();await page.clock.runFor(2500);await expect(frame.getByRole('tooltip')).toBeHidden();
 await page.clock.runFor(1000);await expect(frame.getByRole('tooltip')).toContainText('Actual battery state of charge');
 await expect(page.getByRole('tooltip')).toBeHidden();
 await page.getByRole('button',{name:'Following vehicle',exact:true}).hover();await expect(frame.getByRole('tooltip')).toBeHidden();
 await page.clock.runFor(3500);await expect(page.getByRole('tooltip')).toContainText('Heading tracking is enabled');
});

test('presentation navigation has delayed help and the added slides retain the original layout',async({page},testInfo)=>{
 await page.clock.install();await page.goto('/presentation/');
 await expect(page.locator('.slides>section')).toHaveCount(19);
 await page.getByRole('link',{name:'Print / PDF ↗'}).hover();await page.clock.runFor(2500);await expect(page.getByRole('tooltip')).toBeHidden();
 await page.clock.runFor(1000);await expect(page.getByRole('tooltip')).toContainText('browser’s Print dialog');
 await page.mouse.move(0,0);
 for(const index of [7,8,9,10]){
  await page.evaluate(index=>(window as any).Reveal.slide(index),index);await page.clock.runFor(100);
  const slide=page.locator('.slides section.present:not(.stack)');
  await expect(slide.locator('h2')).toContainText(['Captured images','How image similarity','Similarity warnings','Review similarity'][index-7]);
  const overflow=await slide.evaluate(element=>{
   const bounds=element.getBoundingClientRect();return {bottom:bounds.bottom,height:bounds.height,available:innerHeight-94};
  });expect(overflow.height).toBeLessThanOrEqual(overflow.available+3);expect(overflow.bottom).toBeLessThanOrEqual(page.viewportSize()!.height+3);
  await page.screenshot({path:testInfo.outputPath(`slide-${index+1}.png`)});
 }
 await page.locator('.navigate-right').hover();await page.clock.runFor(3500);await expect(page.getByRole('tooltip')).toContainText('next presentation slide');
});


