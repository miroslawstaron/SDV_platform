import {it,expect,vi} from 'vitest';
import {MemoryCache} from '../src/memoryCache';

it('coalesces pending preloads and viewer requests for the same bytes',async()=>{
 const cache=new MemoryCache<ArrayBuffer>(20,value=>value.byteLength),load=vi.fn(async()=>new ArrayBuffer(10));
 const first=cache.get('image',load),second=cache.get('image',load);
 expect(first).toBe(second);await first;expect(load).toHaveBeenCalledOnce();
 await cache.get('image',load);expect(load).toHaveBeenCalledOnce();
});
it('evicts least recently used buffers within the memory budget',async()=>{
 const cache=new MemoryCache<ArrayBuffer>(20,value=>value.byteLength),load=vi.fn(async()=>new ArrayBuffer(10));
 await cache.get('a',load);await cache.get('b',load);await cache.get('a',load);await cache.get('c',load);
 await cache.get('a',load);expect(load).toHaveBeenCalledTimes(3);
 await cache.get('b',load);expect(load).toHaveBeenCalledTimes(4);
});
it('does not retain rejected loads or assets after disposal',async()=>{
 const cache=new MemoryCache<number>(2),load=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(1);
 await expect(cache.get('a',load)).rejects.toThrow('offline');await cache.get('a',load);cache.clear();await cache.get('a',load);
 expect(load).toHaveBeenCalledTimes(3);
});
