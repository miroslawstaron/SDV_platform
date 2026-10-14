import {test,expect,type Page} from '@playwright/test';
import {Buffer} from 'node:buffer';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNwAAAABJRU5ErkJggg==','base64');
async function environment(page:Page,active:string|null=null,reuseImage=false){
 const calls:{path:string;body:any}[]=[];
 let runs=[{id:'drive-one',status:'completed',time:12},{id:'drive-two',status:'interrupted',time:4}];
 let images=[{id:'image-one',phash:'0123456789abcdef',media_type:'image/png',bytes:67,captures:2,created_at:1,reference_label:null as string|null}];
 const platform=()=>({status:'ready',active_run:active,services:{plant:{application:'running',transport:'ready'},sensor:{application:'running',transport:'ready'}},gateway:{status:'ready'}});
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
  const body=request.method()==='DELETE'?request.postDataJSON():null;
  if(path==='/management/overview')return route.fulfill({json:{recordings:{runs:runs.length,ticks:10,events:50,database_bytes:20000,reusable_bytes:0},images:{images:images.length,captures:images.reduce((n,image)=>n+image.captures,0),image_bytes:images.reduce((n,image)=>n+image.bytes,0),references:images.filter(image=>image.reference_label).length,database_bytes:10000,reusable_bytes:0,hash_bits:64,max_distance:8,warning_count:5},platform:platform()}});
  if(path==='/health')return route.fulfill({json:platform()});
  if(path==='/config')return route.fulfill({json:{mapillary_access_token:''}});
  if(path==='/runs')return route.fulfill({json:runs});
  if(path==='/routes')return route.fulfill({json:[{id:'gothenburg-demo',name:'Gothenburg',distance:371}]});
  if(path==='/images')return route.fulfill({json:{items:images,total:images.length}});
  if(path.startsWith('/images/'))return route.fulfill({body:png,contentType:'image/png'});
  if(path==='/management/recordings'){
   calls.push({path,body});const count=runs.filter(run=>body.all||body.ids.includes(run.id)).length;
   runs=runs.filter(run=>!body.all&&!body.ids.includes(run.id));
   return route.fulfill({json:{runs_deleted:count,captures_deleted:0,images_deleted:0}});
  }
  if(path==='/management/images'&&request.method()==='DELETE'){
   calls.push({path,body});images=[];return route.fulfill({json:{images_deleted:1,captures_deleted:2}});
  }
  if(path==='/management/images'&&request.method()==='POST'){
   expect(request.postDataBuffer()).toEqual(png);calls.push({path,body:new URL(request.url()).searchParams.get('filename')});
   if(reuseImage){images[0]={...images[0],captures:3,reference_label:'reference.png'};return route.fulfill({status:201,json:{image_id:'image-one',image_stored:false}})}
   images.push({...images[0],id:'uploaded-image',captures:1,reference_label:'reference.png'});
   return route.fulfill({status:201,json:{image_id:'uploaded-image',image_stored:true}});
  }
  if(path.endsWith('/stop')){active=null;return route.fulfill({json:{status:'stopping'}})}
  if(path==='/management/reset'){calls.push({path,body:null});return route.fulfill({json:{status:'reset',services:{plant:{status:'reset'}}}})}
  return route.fulfill({status:404,json:{detail:'Unexpected request '+path}});
 });
 await page.goto('/management');await expect(page.getByRole('heading',{name:'Management dashboard'})).toBeVisible();
 await expect(page.locator('.management-image')).toHaveCount(1);
 if(!active)await expect(page.getByRole('button',{name:'Clear all recording history'})).toBeEnabled();
 return calls;
}

test('recording deletion confirms exact scope, cancel keeps data, and images are retained by default',async({page})=>{
 const calls=await environment(page);
 await page.getByRole('checkbox',{name:'Select recording drive-one',exact:true}).check();
 await page.getByRole('button',{name:'Delete selected recordings',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('captured images and similarity history will be kept');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(calls).toEqual([]);
 await page.getByRole('button',{name:'Delete selected recordings',exact:true}).click();
 await page.getByRole('button',{name:'Delete 1 recording',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('1 recording deleted. Image history kept.');
 expect(calls[0]).toEqual({path:'/management/recordings',body:{ids:['drive-one'],include_images:false}});
 await expect(page.getByRole('checkbox',{name:'Select recording drive-one',exact:true})).toHaveCount(0);
 await expect(page.locator('.management-image')).toHaveCount(1);
 await page.getByRole('textbox',{name:'Find recordings'}).fill('no-match');
 await page.getByRole('checkbox',{name:'Also remove their image observations'}).check();
 await page.getByRole('button',{name:'Clear all recording history'}).click();
 await expect(page.getByRole('dialog')).toContainText('image observations will also be removed');
 await page.getByRole('button',{name:'Delete 1 recording',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('1 recording deleted.');
 expect(calls[1].body).toEqual({all:true,include_images:true});
});

test('reference uploads use original bytes and selected image removal explains every affected observation',async({page})=>{
 const calls=await environment(page);
 await page.getByLabel('Add reference images',{exact:true}).setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
 await page.getByRole('button',{name:'Import images (1)'}).click();
 await expect(page.getByRole('status')).toContainText('1 upload accepted');
 await expect(page.locator('.management-image')).toHaveCount(2);
 await expect(page.getByText('Uploaded reference',{exact:true})).toBeVisible();
 expect(calls[0]).toEqual({path:'/management/images',body:'reference.png'});
 await page.getByRole('checkbox',{name:'Select image image-one',exact:true}).check();
 await page.getByRole('button',{name:'Delete selected images',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('every capture or reference that uses them');
 await page.getByRole('button',{name:'Delete 1 image',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('1 image and 2 observations deleted');
 expect(calls[1].body).toEqual({ids:['image-one']});
});

test('100 percent matched reference uploads explain reuse and do not add another image',async({page})=>{
 await environment(page,null,true);
 await page.getByLabel('Add reference images',{exact:true}).setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
 await page.getByRole('button',{name:'Import images (1)'}).click();
 await expect(page.getByRole('status')).toContainText('1 100% match reused; duplicate files were not stored');
 await expect(page.locator('.management-image')).toHaveCount(1);
 await expect(page.locator('.management-totals').nth(0)).toContainText('1 uploaded reference');
});

test('active drive locks mutations and delayed help remains available on disabled controls',async({page})=>{
 await page.clock.install();const calls=await environment(page,'live-drive');
 await expect(page.getByRole('button',{name:'Clear all recording history'})).toBeDisabled();
 const reset=page.getByRole('button',{name:'Reset vehicle services',exact:true});await expect(reset).toBeDisabled();
 await expect(page.getByLabel('Add reference images',{exact:true})).toBeDisabled();
 await reset.hover();await page.clock.runFor(2500);await expect(page.getByRole('tooltip')).toBeHidden();
 await page.clock.runFor(1000);await expect(page.getByRole('tooltip')).toContainText('Stop the drive first');
 await page.getByRole('button',{name:'Stop active drive'}).click();await page.clock.runFor(5500);
 await expect(reset).toBeEnabled();await reset.click();
 await expect(page.getByRole('dialog')).toContainText('Saved recordings, image history and prepared routes will be kept');
 await page.getByRole('dialog').getByRole('button',{name:'Reset vehicle services',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Simulator and all vehicle ECUs reset');
 expect(calls.at(-1)?.path).toBe('/management/reset');
});

test('management stays readable on a narrow screen and bundled route removal is disabled',async({page})=>{
 await page.setViewportSize({width:390,height:844});await environment(page);
 await expect(page.getByRole('button',{name:'Remove route'})).toBeDisabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Clear image database'}).click();
 await page.keyboard.press('Tab');await page.keyboard.press('Tab');
 await expect(page.getByRole('dialog').getByRole('button',{name:'Cancel'})).toBeFocused();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
});
