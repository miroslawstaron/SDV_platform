import {test,expect} from '@playwright/test';

for(const providerError of ['Could not download OpenStreetMap roads (provider: request timed out). Retry Prepare route.','']){
 test(`failed route preparation explains ${providerError?'provider errors':'empty errors'} and allows retry`,async({page})=>{
  await page.route('**/api/v1/routes/prepare',route=>route.fulfill({status:202,json:{id:'failed-route',status:'preparing',stage:'Downloading roads',progress:10}}));
  await page.route('**/api/v1/routes/jobs/failed-route',route=>route.fulfill({json:{id:'failed-route',status:'failed',stage:'Failed',progress:10,error:providerError}}));
  await page.goto('/');
  const map=page.locator('.route-map .leaflet-container');
  await expect(page.getByRole('combobox',{name:'Route'})).toHaveValue('gothenburg-demo');
  await map.click({position:{x:150,y:150}});await map.click({position:{x:250,y:200}});
  await page.getByRole('button',{name:'Prepare route'}).click();
  await expect(page.getByRole('alert')).toContainText(providerError||'Route preparation failed. Retry Prepare route');
  await expect(page.locator('.job-status')).toHaveText('Failed');
  await expect(page.getByRole('button',{name:'Prepare route'})).toBeEnabled();
  await expect(page.locator('.map-note')).toHaveText('Endpoints selected — prepare route');
 });
}
