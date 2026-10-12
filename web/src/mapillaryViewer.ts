import type {Image,Viewer,EntContract,ImageEnt} from 'mapillary-js';
import {panoramaCenter} from './mapillary';
import type {StreetImage} from './mapillary';
import {MemoryCache} from './memoryCache';

export interface ImageryViewer{
 moveTo(id:string):Promise<Image>;
 setHeading(heading:number,pano:boolean,stillCurrent:()=>boolean):Promise<void>;
 remove():void;
}
export async function moveToImage(viewer:ImageryViewer,id:string,signal:AbortSignal):Promise<Image>{
 if(signal.aborted)throw new DOMException('Image load cancelled','AbortError');
 let cancel:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{
  cancel=()=>reject(new DOMException('Image load cancelled','AbortError'));
  if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
 });
 try{return await Promise.race([viewer.moveTo(id),aborted])}
 finally{signal.removeEventListener('abort',cancel)}
}
export async function createViewer(container:HTMLElement,accessToken:string):Promise<ImageryViewer>{
 const {Viewer,TransitionMode}=await import('mapillary-js');
 const viewer:Viewer=new Viewer({container,accessToken,transitionMode:TransitionMode.Instantaneous,
  component:{attribution:true,cover:false,direction:false,sequence:false,spatial:false,keyboard:false,cache:false}});
 return {
  moveTo:id=>viewer.moveTo(id),
  async setHeading(heading,pano,stillCurrent){
   if(!pano){if(stillCurrent())viewer.setCenter([.5,.5]);return;}
   const [bearing,center]=await Promise.all([viewer.getBearing(),viewer.getCenter()]);
   if(stillCurrent())viewer.setCenter([panoramaCenter(center[0],bearing,heading),.5]);
  },
  remove:()=>viewer.remove(),
 };
}

/** Shared SDK data provider preloads bytes; three bounded viewers pre-render frames. */
export async function createViewerGroup(containers:HTMLElement[],accessToken:string){
 const {Viewer,TransitionMode,GraphDataProvider}=await import('mapillary-js');
 class CachedProvider extends GraphDataProvider{
  metadata=new MemoryCache<EntContract<ImageEnt>>(256);
  buffers=new MemoryCache<ArrayBuffer>(64*1024*1024,value=>value.byteLength);
  meshes=new MemoryCache<Awaited<ReturnType<InstanceType<typeof GraphDataProvider>['getMesh']>>>(128);
  cells=new MemoryCache<Awaited<ReturnType<InstanceType<typeof GraphDataProvider>['getCoreImages']>>>(64);
  override getImages(ids:string[]){return Promise.all(ids.map(id=>this.metadata.get(id,async()=>{
   const nodes=await super.getImages([id]);const node=nodes.find(value=>value.node_id===id);
   if(!node)throw new Error('Mapillary image metadata unavailable');return node;
  })))}
  override getImageBuffer(url:string){return this.buffers.get(url,()=>super.getImageBuffer(url))}
  override getMesh(url:string){return this.meshes.get(url,()=>super.getMesh(url))}
  override getCoreImages(cell:string){return this.cells.get(cell,()=>super.getCoreImages(cell))}
  override getSpatialImages(ids:string[]){return this.getImages(ids)}
  clear(){this.metadata.clear();this.buffers.clear();this.meshes.clear();this.cells.clear()}
 }
 const provider=new CachedProvider({accessToken});
 const viewers:ImageryViewer[]=containers.map(container=>{
  const native=new Viewer({container,dataProvider:provider,imageTiling:false,transitionMode:TransitionMode.Instantaneous,
   component:{attribution:true,cover:false,direction:false,sequence:false,spatial:false,keyboard:false,cache:false}});
  return {
   moveTo:id=>native.moveTo(id),
   async setHeading(heading,pano,stillCurrent){
    if(!pano){if(stillCurrent())native.setCenter([.5,.5]);return;}
    const [bearing,center]=await Promise.all([native.getBearing(),native.getCenter()]);
    if(stillCurrent())native.setCenter([panoramaCenter(center[0],bearing,heading),.5]);
   },
   remove:()=>native.remove(),
  };
 });
 return {
  viewers,
  async imageBytes(image:StreetImage):Promise<ArrayBuffer>{
   const [{node}]=await provider.getImages([image.id]);
   return provider.getImageBuffer(node.thumb.url);
  },
  async preloadImage(image:StreetImage,signal:AbortSignal):Promise<StreetImage>{
   let cancelled=()=>{};
   const aborted=new Promise<never>((_,reject)=>{cancelled=()=>reject(new DOMException('Preload cancelled','AbortError'));if(signal.aborted)cancelled();else signal.addEventListener('abort',cancelled,{once:true});});
   const load=async()=>{
    const [{node}]=await provider.getImages([image.id]);
    await Promise.all([provider.getImageBuffer(node.thumb.url),node.mesh?.url?provider.getMesh(node.mesh.url).catch(()=>undefined):Promise.resolve()]);
    const point=node.computed_geometry||node.geometry;
    return {...image,lat:point.lat,lng:point.lng,pano:node.camera_type==='spherical',bearing:node.computed_compass_angle??node.compass_angle,capturedAt:node.captured_at};
   };
   try{return await Promise.race([load(),aborted])}finally{signal.removeEventListener('abort',cancelled)}
  },
  remove(){for(const viewer of viewers)viewer.remove();provider.clear()},
 };
}
