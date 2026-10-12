/** Request coalescing and bounded transient memory; no disk or recording storage. */
export class MemoryCache<T>{
 private entries=new Map<string,{promise:Promise<T>;size:number}>();
 private bytes=0;
 constructor(private limit:number,private measure:(value:T)=>number=()=>1){}
 get(key:string,load:()=>Promise<T>):Promise<T>{
  const existing=this.entries.get(key);
  if(existing){this.entries.delete(key);this.entries.set(key,existing);return existing.promise;}
  const entry={promise:null! as Promise<T>,size:0};
  entry.promise=Promise.resolve().then(load).then(value=>{
   if(this.entries.get(key)===entry){entry.size=this.measure(value);this.bytes+=entry.size;this.evict();}return value;
  }).catch(error=>{if(this.entries.get(key)===entry){this.entries.delete(key);this.bytes-=entry.size;}throw error;});
  this.entries.set(key,entry);return entry.promise;
 }
 private evict(){
  for(const [key,entry] of this.entries){if(this.bytes<=this.limit)break;if(entry.size){this.entries.delete(key);this.bytes-=entry.size;}}
 }
 clear(){this.entries.clear();this.bytes=0;}
}
