import type {ContractCatalog,Event} from './types';

export const NODES=['navigation','controller','powertrain','brake','lane','sensor','bms','plant'];
export const LIFELINES=['navigation','sensor','bms','controller','CAN bus','powertrain','brake','lane','plant'];
export type SequenceEntry={event:Event;from:string;to:string;label:string;reception:boolean};

export function sequenceEntries(events:Event[],catalog:ContractCatalog,allReceivers:boolean,node:string,protocol:string):SequenceEntry[]{
 return events.filter(e=>['CAN','SOME/IP'].includes(e.protocol)).flatMap(e=>{
  if(protocol!=='all'&&e.protocol!==protocol)return [];
  const message=catalog.messages.find(m=>m.id===e.message_id);
  const source=e.source||message?.producer||e.module;
  let from=e.module,to=e.module;
  const reception=e.kind==='rx'||e.kind.endsWith('_rx');
  if(e.protocol==='CAN'){
   if(e.kind==='tx')to='CAN bus';
   else if(e.kind==='rx'){
    if(!allReceivers&&!message?.consumers.includes(e.module))return [];
    from='CAN bus';
   }else return [];
  }else{
   if(reception)from=source;
   else if(e.kind.endsWith('_tx'))to=e.kind==='request_tx'?'navigation':'controller';
  }
  if(node!=='all'&&![from,to,source].includes(node))return [];
  const values=Object.entries(e.decoded||{}).filter(([k])=>!['Sequence','sequence','version'].includes(k)).slice(0,2).map(([k,v])=>`${k}=${typeof v==='number'?Number(v.toFixed(2)):v}`).join(', ');
  const binding=e.message_id!==undefined?'0x'+e.message_id.toString(16):'';
  return [{event:e,from,to,reception,label:`${message?.name||'SOME/IP'} ${binding} · ${e.kind}${e.sequence!==undefined?' #'+e.sequence:''}${values?' · '+values:''}`}];
 });
}
