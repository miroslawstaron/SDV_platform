import {describe,it,expect} from 'vitest';
import {sequenceEntries} from '../src/communication';
import type {ContractCatalog,Event} from '../src/types';

const catalog:ContractCatalog={messages:[{id:256,name:'Sensors',producer:'sensor',consumers:['controller'],signals:[]}],update_period_ms:50,stale_threshold_ms:200,someip:{producer:'navigation',consumer:'controller',service:'0x1234',event:'0x8001',payload:{}}};
const shared={sim_time:1,protocol:'CAN',message_id:256,source:'sensor',decoded:{Speed:3,Sequence:7},sequence:7};
const events:Event[]=[{...shared,module:'sensor',kind:'tx'},{...shared,module:'controller',kind:'rx'},{...shared,module:'brake',kind:'rx'}];
describe('recorded sequence semantics',()=>{
 it('does not turn a CAN transmit into claimed point-to-point delivery',()=>{
  const rows=sequenceEntries(events,catalog,false,'all','all');
  expect(rows.map(r=>[r.from,r.to,r.reception])).toEqual([['sensor','CAN bus',false],['CAN bus','controller',true]]);
  expect(sequenceEntries(events,catalog,true,'all','all')).toHaveLength(3);
 });
 it('can inspect a sender including its received broadcast observations',()=>{
  expect(sequenceEntries(events,catalog,true,'sensor','CAN')).toHaveLength(3);
  expect(sequenceEntries(events,catalog,true,'brake','CAN')).toHaveLength(1);
  expect(sequenceEntries(events,catalog,true,'all','SOME/IP')).toHaveLength(0);
 });
 it('keeps SOME/IP requests, replies and receptions distinct',()=>{
  const someip:Event[]=[
   {sim_time:1,module:'controller',source:'controller',protocol:'SOME/IP',kind:'request_tx'},
   {sim_time:1,module:'navigation',source:'controller',protocol:'SOME/IP',kind:'request_rx'},
   {sim_time:1,module:'navigation',source:'navigation',protocol:'SOME/IP',kind:'response_tx'},
   {sim_time:1,module:'controller',source:'navigation',protocol:'SOME/IP',kind:'response_rx'},
  ];
  const rows=sequenceEntries(someip,catalog,false,'all','all');
  expect(rows.map(r=>[r.from,r.to])).toEqual([['controller','navigation'],['controller','navigation'],['navigation','controller'],['navigation','controller']]);
  expect(rows.map(r=>r.reception)).toEqual([false,true,false,true]);
 });
});
