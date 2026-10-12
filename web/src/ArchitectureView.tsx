import {useState} from 'react';
import type {ContractCatalog,Event} from './types';
import {NODES} from './communication';

const positions:Record<string,[number,number]>={navigation:[105,75],controller:[320,75],powertrain:[535,75],brake:[750,75],sensor:[105,305],bms:[320,305],lane:[535,305],plant:[750,305]};
export function ArchitectureView({catalog,events,health}:{catalog:ContractCatalog;events:Event[];health:Record<string,{application:string}>}){
 const [node,setNode]=useState('all'),[selected,setSelected]=useState<number|string>(512);
 const messages=catalog.messages.filter(m=>node==='all'||m.producer===node||m.consumers.includes(node));
 const chosen=catalog.messages.find(m=>m.id===selected);
 const highlighted=selected==='someip'?['navigation','controller']:chosen?[chosen.producer,...chosen.consumers]:[];
 const current=events.filter(e=>e.kind==='tx'&&e.protocol==='CAN'&&e.message_id===selected).at(-1);
 const nav=events.filter(e=>e.protocol==='SOME/IP'&&e.kind==='event_tx').at(-1);
 function chooseNode(name:string){setNode(old=>old===name?'all':name)}
 return <section id="architecture-view" className="card architecture-panel" aria-label="Vehicle E/E architecture"><div className="section-heading"><h2>07 <span>Vehicle E/E architecture</span></h2><button onClick={()=>setNode('all')}>Show all nodes</button></div>
 <div className="architecture-layout"><div><svg className="architecture-svg" viewBox="0 0 860 380" role="img" aria-label="ECU topology with CAN bus and SOME/IP service"><defs><marker id="architecture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10" fill="#a96313"/></marker></defs>
 <path d="M105 196H750" className="bus-line"/><text x="425" y="180" textAnchor="middle" className="bus-label">CAN FD · functional broadcast</text>
 {NODES.map(n=>{const [x,y]=positions[n];return <path key={n} d={`M${x} ${y<196?y+34:y-34}V196`} strokeDasharray={n==='navigation'?'4 4':undefined} className={highlighted.includes(n)&&selected!=='someip'?'architecture-wire active':'architecture-wire'}/>})}
 <path d="M184 75H240" stroke="#a96313" strokeWidth={selected==='someip'?3:1.5} markerEnd="url(#architecture-arrow)"/><text x="213" y="15" textAnchor="middle" className="someip-label">SOME/IP</text><text x="213" y="29" textAnchor="middle" className="someip-label">0x1234 / 0x8001</text>
 {NODES.map(n=>{const [x,y]=positions[n];const status=health[n]?.application||'ready';const active=events.slice(-80).some(e=>e.module===n&&(e.kind==='tx'||e.kind.endsWith('_tx')));return <g key={n} role="button" aria-label={`Inspect ${n}`} tabIndex={0} onClick={()=>chooseNode(n)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();chooseNode(n)}}} className={`architecture-node ${highlighted.includes(n)?'highlighted':''} ${node===n?'chosen':''}`}><rect x={x-79} y={y-34} width="158" height="68" rx="7"/><circle cx={x+64} cy={y-21} r="4" fill={['ready','running'].includes(status)?'#087c65':'#a96313'} opacity={active?1:.5}/><text x={x} y={y-4} textAnchor="middle">{n==='plant'?'SUMO plant':n}</text><text x={x} y={y+17} textAnchor="middle" className="node-status">{n==='plant'?'Simulator adapter':status}</text></g>})}
 <text x="425" y="240" textAnchor="middle" className="node-status">{chosen?`${chosen.producer} → ${chosen.consumers.join(', ')} · ${chosen.name} 0x${chosen.id.toString(16)}`:'Navigation → controller · navigation intent'}</text>
 </svg><p className="architecture-note">Select a node or contract to inspect its signals. Highlighted CAN taps show the contract producer and consumers. Navigation observes CAN through its adapter (dashed tap); its intent uses SOME/IP. KUKSA mirrors reported values through the API gateway.</p></div>
 <div className="architecture-contracts"><div className="architecture-caption">{node==='all'?'All communication contracts':`Contracts for ${node}`}</div>
 {(node==='all'||['navigation','controller'].includes(node))&&<button className={`contract-row ${selected==='someip'?'selected':''}`} onClick={()=>setSelected('someip')}><span className="protocol orange">SOME/IP {catalog.someip.service}</span><b>Navigation intent</b><small>navigation → controller</small><span>target_speed · lane_request · remaining</span></button>}
 {messages.map(m=><button key={m.id} className={`contract-row ${selected===m.id?'selected':''}`} onClick={()=>setSelected(m.id)}><span className="protocol">CAN 0x{m.id.toString(16)}</span><b>{m.name}</b><small>{m.producer} → {m.consumers.join(', ')}</small><span>{m.signals.filter(s=>s.name!=='Sequence').map(s=>s.name).join(' · ')}</span></button>)}
 </div></div><div className="signal-contract-detail"><div className="architecture-caption">{selected==='someip'?'Navigation intent':chosen?.name} · {catalog.update_period_ms} ms update · {catalog.stale_threshold_ms} ms expiry</div><div className="signal-contract-grid">{selected==='someip'?Object.entries(catalog.someip.payload).map(([name,type])=><div key={name}><b>{name}</b><span>{String(type)}</span><strong>{String(nav?.decoded?.[name]??'—')}</strong></div>):chosen?.signals.map(s=><div key={s.name} title={s.vss||''}><b>{s.name}</b><span>{s.unit||'unitless'} · {s.consumers.join(', ')}</span><strong>{String(current?.decoded?.[s.name]??'—')}</strong></div>)}</div></div>
 </section>;
}
