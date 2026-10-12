import {it,expect,vi,beforeEach} from 'vitest';
import type {Image} from 'mapillary-js';
import {createViewer,createViewerGroup,moveToImage} from '../src/mapillaryViewer';
import type {ImageryViewer} from '../src/mapillaryViewer';

const sdk=vi.hoisted(()=>({options:{} as any,moveTo:vi.fn(),getBearing:vi.fn(),getCenter:vi.fn(),setCenter:vi.fn(),remove:vi.fn(),getImages:vi.fn(),getImageBuffer:vi.fn(),getMesh:vi.fn()}));
vi.mock('mapillary-js',()=>({TransitionMode:{Instantaneous:1},GraphDataProvider:class{getImages(ids:string[]){return sdk.getImages(ids)}getImageBuffer(url:string){return sdk.getImageBuffer(url)}getMesh(url:string){return sdk.getMesh(url)}},Viewer:class{constructor(options:unknown){sdk.options=options}moveTo=sdk.moveTo;getBearing=sdk.getBearing;getCenter=sdk.getCenter;setCenter=sdk.setCenter;remove=sdk.remove}}));
beforeEach(()=>{vi.clearAllMocks();sdk.getBearing.mockResolvedValue(0);sdk.getCenter.mockResolvedValue([.5,.5])});
it('uses official viewer controls and preserves attribution while orienting a panorama',async()=>{
 const viewer=await createViewer({} as HTMLElement,'client-token');
 expect(sdk.options.accessToken).toBe('client-token');
 expect(sdk.options.component.attribution).toBe(true);expect(sdk.options.component.sequence).toBe(false);
 await viewer.setHeading(90,true,()=>true);expect(sdk.setCenter).toHaveBeenCalledWith([.75,.5]);
 viewer.remove();expect(sdk.remove).toHaveBeenCalledOnce();
});
it('does not change an outdated heading and keeps a flat photograph centered',async()=>{
 const viewer=await createViewer({} as HTMLElement,'client-token');
 await viewer.setHeading(90,true,()=>false);expect(sdk.setCenter).not.toHaveBeenCalled();
 await viewer.setHeading(90,false,()=>true);expect(sdk.setCenter).toHaveBeenCalledWith([.5,.5]);
});
it('bounds pending SDK image loads with cancellation and ignores a late completion',async()=>{
 const controller=new AbortController();let complete!:(image:Image)=>void;
 const moveTo=vi.fn(()=>new Promise<Image>(resolve=>complete=resolve));
 const result=moveToImage({moveTo} as unknown as ImageryViewer,'123',controller.signal);
 const rejected=expect(result).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
 complete({id:'123'} as Image);await Promise.resolve();expect(moveTo).toHaveBeenCalledOnce();
});
it('does not start an SDK request that has already been cancelled',async()=>{
 const controller=new AbortController();controller.abort();const moveTo=vi.fn();
 await expect(moveToImage({moveTo} as unknown as ImageryViewer,'123',controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(moveTo).not.toHaveBeenCalled();
});
it('preloads real image bytes and mesh once for all three viewer buffers',async()=>{
 sdk.getImages.mockResolvedValue([{node_id:'123',node:{computed_geometry:{lat:57.7,lng:11.97},thumb:{url:'thumb'},mesh:{url:'mesh'},camera_type:'spherical',captured_at:1700000000000}}]);
 sdk.getImageBuffer.mockResolvedValue(new ArrayBuffer(8));sdk.getMesh.mockResolvedValue({});
 const group=await createViewerGroup([{}, {}, {}] as HTMLElement[],'client-token');
 const image={id:'123',lat:57.7,lng:11.97,pano:true};
 await Promise.all([group.preloadImage(image,new AbortController().signal),group.preloadImage(image,new AbortController().signal)]);
 expect(sdk.getImages).toHaveBeenCalledOnce();expect(sdk.getImageBuffer).toHaveBeenCalledOnce();expect(sdk.getMesh).toHaveBeenCalledOnce();
 await sdk.options.dataProvider.getImageBuffer('thumb');expect(sdk.getImageBuffer).toHaveBeenCalledOnce();
 expect((await group.imageBytes(image)).byteLength).toBe(8);
 expect(sdk.getImageBuffer).toHaveBeenCalledOnce();
 expect(sdk.options.imageTiling).toBe(false);expect(sdk.options.component.attribution).toBe(true);
 group.remove();expect(sdk.remove).toHaveBeenCalledTimes(3);
});
