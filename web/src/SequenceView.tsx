import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {LIFELINES,NODES,sequenceEntries} from './communication';
import type {ContractCatalog,Event} from './types';

export function SequenceView({id,at,catalog,live}:{id?:string;at:number;catalog:ContractCatalog;live:boolean}){
 const [events,setEvents]=useState<Event[]>([]),[windowSize,setWindowSize]=useState(.05),[allReceivers,setAllReceivers]=useState(false),[node,setNode]=useState('all'),[protocol,setProtocol]=useState('all'),[error,setError]=useState(''),[shownAt,setShownAt]=useState(0);
 const cursor=useRef(at);cursor.current=at;
 const generation=useRef(0);
 useEffect(()=>{
  const token=++generation.current;let pending=false;
  setEvents([]);setError('');
  async function load(){if(!id||pending)return;pending=true;const time=cursor.current;
   try{const data=await api<{events:Event[]}>(`/runs/${id}/timeline?at=${time}&window=${windowSize}`);if(generation.current===token){setEvents(data.events);setShownAt(time);setError('')}}
   catch(e){if(generation.current===token)setError((e as Error).message)}finally{pending=false}
  }
  load();const timer=setInterval(load,500);return()=>{generation.current++;clearInterval(timer)};
 },[id,windowSize]);
 const entries=sequenceEntries(events,catalog,allReceivers,node,protocol),visible=entries.slice(-120);
 const x=(name:string)=>110+Math.max(0,LIFELINES.indexOf(name))*160;
 const height=Math.max(200,95+visible.length*49);
 return <section id="sequence-view" className="card sequence-panel" aria-label="ECU communication sequence"><div className="section-heading"><h2>08 <span>ECU communication sequence</span></h2><span className="pill">{live?'LIVE':'REPLAY'} · {shownAt.toFixed(2)} s</span></div>
 <div className="sequence-controls"><label>Time window <select aria-label="Sequence time window" value={windowSize} onChange={e=>setWindowSize(Number(e.target.value))}><option value={.05}>50 ms · one cycle</option><option value={.25}>250 ms</option><option value={1}>1 second</option></select></label><label>Node <select aria-label="Sequence node" value={node} onChange={e=>setNode(e.target.value)}><option value="all">All nodes</option>{NODES.map(n=><option key={n}>{n}</option>)}</select></label><label>Transport <select aria-label="Sequence transport" value={protocol} onChange={e=>setProtocol(e.target.value)}><option value="all">CAN + SOME/IP</option><option>CAN</option><option>SOME/IP</option></select></label><label className="checkbox"><input type="checkbox" checked={allReceivers} onChange={e=>setAllReceivers(e.target.checked)}/> Include every CAN receiver</label></div>
 <div className="trace-description">From the complete recording, independent of the sampled live trace. Solid arrows: transmit. Dashed arrows: observed receive. CAN transmission goes to the bus; reception confirms delivery. Default receptions show contract consumers. Rows follow simulation time and recorder order; native timestamps are local to each adapter.</div>
 {error&&<p role="alert" className="empty">Sequence unavailable: {error}</p>}
 {!id?<p className="empty">Start a drive or select a recording to see ECU communication.</p>:<div className="sequence-scroll"><svg viewBox={`0 0 1500 ${height}`} width="1500" height={height} role="img" aria-label="Sequence diagram of recorded ECU messages"><defs><marker id="sequence-can" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10" fill="#087c65"/></marker><marker id="sequence-someip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10" fill="#a96313"/></marker></defs>
 {LIFELINES.map(name=><g key={name}><rect x={x(name)-67} y="12" width="134" height="34" rx="5" fill="#edf5f7"/><text x={x(name)} y="34" textAnchor="middle" className="lifeline-label">{name}</text><path d={`M${x(name)} 48V${height-12}`} stroke="#bfd1d7" strokeDasharray="3 5"/></g>)}
 {visible.map((row,i)=>{const y=90+i*49,a=x(row.from),b=x(row.to),someip=row.event.protocol==='SOME/IP';const stroke=someip?'#a96313':'#087c65';return <g key={row.event.event_id||i} className="sequence-message"><title>{row.label}\nSource: {row.event.source||row.from}; observer: {row.event.module}\nNative monotonic: {row.event.monotonic_ns??'unavailable'} ns\n{JSON.stringify(row.event.decoded)}\n{row.event.raw}</title><text x="5" y={y+4} className="sequence-time">{row.event.sim_time.toFixed(2)}</text><path d={a===b?`M${a} ${y-8}h36v16h-36`:`M${a} ${y}H${b}`} stroke={stroke} fill="none" strokeDasharray={row.reception?'5 4':undefined} markerEnd={`url(#sequence-${someip?'someip':'can'})`}/><text x={Math.min(a,b)+8} y={y-10} fill={stroke} className="sequence-label">{row.label.length>110?row.label.slice(0,107)+'…':row.label}</text></g>})}
 {!visible.length&&<text x="620" y="130" textAnchor="middle" className="node-status">No matching recorded messages in this time window.</text>}
 </svg></div>}
 <div className="trace-description">Showing {visible.length} of {entries.length} matching observations in [{Math.max(0,shownAt-windowSize).toFixed(2)}, {shownAt.toFixed(2)}] s.{entries.length>120?' Diagram shows the latest 120 matching observations; narrow the filters to inspect others.':''} Exports include every event and signal.</div>
 </section>;
}
