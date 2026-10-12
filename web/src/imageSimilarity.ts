import type {StreetImage} from './mapillary';

export type ImageSimilarityResult={
 status:'ready'|'awaiting_capture';run_id:string;station_index:number;database_images:number;
 similar_count:number;too_similar:boolean;nearest_similarity_pct:number|null;
 hash_bits:number;max_distance:number;warning_count:number;phash?:string;
 database_captures?:number;similar_image_count?:number;
};

export async function captureStreetImage(runId:string,index:number,image:StreetImage,simTime:number,bytes:ArrayBuffer,signal:AbortSignal){
 const params=new URLSearchParams({provider_image_id:image.id,sim_time:String(simTime),lat:String(image.lat),lng:String(image.lng)});
 if(image.capturedAt!==undefined)params.set('captured_at',String(image.capturedAt));
 const response=await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/images/${index}?${params}`,{
  method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes,signal,
 });
 const value=await response.json();
 if(!response.ok)throw new Error(typeof value.detail==='string'?value.detail:'Image capture unavailable');
 return value as ImageSimilarityResult;
}

export function similarityText(value:ImageSimilarityResult){
 if(value.status!=='ready')return 'Waiting for a captured street image';
 const closest=value.nearest_similarity_pct===null?'No other captures yet':`${value.nearest_similarity_pct.toFixed(1)}% closest match`;
 return `${closest} · ${value.similar_count} similar captures · ${value.database_images} unique images${value.database_captures!==undefined?` · ${value.database_captures} captures stored`:''}`;
}
