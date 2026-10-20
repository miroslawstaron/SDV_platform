const $=id=>document.getElementById(id);
const id=new URLSearchParams(location.search).get('run');
const svgNS='http://www.w3.org/2000/svg';
for(let speed=0;speed<=140;speed+=20){
 const angle=(135+270*speed/140)*Math.PI/180;
 const line=document.createElementNS(svgNS,'line');
 for(const [key,radius,axis] of [['x1',96,'x'],['y1',96,'y'],['x2',102,'x'],['y2',102,'y']])line.setAttribute(key,String((axis==='x'?160:148)+(axis==='x'?Math.cos(angle):Math.sin(angle))*radius));
 const text=document.createElementNS(svgNS,'text');text.setAttribute('x',String(160+Math.cos(angle)*81));text.setAttribute('y',String(148+Math.sin(angle)*81));text.textContent=String(speed);
 $('speed-ticks').append(line,text);
}
let socket,retry,closed=false,run={},lastState=null,lastReceived=0;
let similarityStation=-1,similarityBusy=false,similarityController;
const finite=(value,fallback=0)=>Number.isFinite(value)?value:fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function warnings(){
 if(!lastState)return;
 const list=[];
 if(socket?.readyState!==WebSocket.OPEN)list.push('Connection lost · last received values');
 else if(['running','starting'].includes(run.status)&&Date.now()-lastReceived>1500)list.push('Vehicle updates delayed · last received values');
 if(lastState.charge_pct<10)list.push('LOW BATTERY');
 if(lastState.red_light)list.push('RED TRAFFIC SIGNAL');
 if(lastState.pedestrian_hazard)list.push('PEDESTRIAN AHEAD');
 if(run.recording_valid===false)list.push('Recording incomplete');
 $('warnings').textContent=list.length?list.join(' · '):lastState.arrived?'Destination reached':run.status==='completed'?'Journey complete':'Vehicle systems normal';
 $('warnings').classList.toggle('warning',list.length>0);
}
function render(packet){
 if(packet.run?.id&&packet.run.id!==id)return;
 run={...run,...packet.run};
 $('mode').textContent=packet.type==='replay'?'REPLAY':String(run.status||'ready').toUpperCase();
 if(run.route)$('route-name').textContent=run.route.name;
 if(run.configuration?.vehicle?.capacity_wh)$('capacity').textContent=`${(run.configuration.vehicle.capacity_wh/1000).toFixed(0)} kWh EV${run.route?.backend==='carla'?' · estimated':''}`;
 if(!packet.state)return;
 const state=packet.state;lastState=state;lastReceived=Date.now();
 const speed=Math.max(0,finite(state.speed)*3.6),charge=clamp(finite(state.charge_pct),0,100),power=finite(state.power_w)/1000;
 $('speed').textContent=speed.toFixed(0);$('speed-arc').style.strokeDasharray=`${518.363*clamp(speed/140,0,1)} 691.15`;
 $('charge').textContent=charge.toFixed(1);$('battery-fill').style.width=`${charge}%`;$('battery-meter').setAttribute('aria-valuenow',String(charge));$('battery-meter').classList.toggle('low',charge<10);
 $('energy').textContent=`${(finite(state.energy_wh)/1000).toFixed(1)} kWh remaining`;
 $('power').textContent=`${power.toFixed(1)} kW`;
 const powerWidth=power<0?30*clamp(-power/60,0,1):70*clamp(power/150,0,1);
 $('power-fill').style.left=`${power<0?30-powerWidth:30}%`;$('power-fill').style.width=`${powerWidth}%`;$('power-fill').classList.toggle('regen',power<0);
 const progress=100*clamp(finite(state.progress),0,1);$('progress').textContent=`${progress.toFixed(0)} %`;$('journey-progress').value=progress;
 $('remaining').textContent=`${(Math.max(0,finite(state.remaining))/1000).toFixed(2)} km`;
 const distance=run.route?.distance??finite(state.distance);$('travelled').textContent=`${(Math.max(0,distance-finite(state.remaining))/1000).toFixed(2)} km`;
 $('elapsed').textContent=`${finite(state.time).toFixed(1)} s`;
 $('limit').textContent=state.speed_limit>0?String(Math.round(state.speed_limit*3.6)):'—';
 $('gear').textContent=speed>.1||(['running','starting'].includes(run.status)&&!state.arrived)?'D':'P';
 $('lane').textContent=`LANE ${finite(state.lane_index)+1}`;$('heading').textContent=`${finite(state.heading).toFixed(0)}°`;
 warnings();
 refreshSimilarity();
}
async function refreshSimilarity(force=false){
 if(closed||!id||!lastState||!run.route)return;
 const distance=run.route.distance;
 const station=Math.min(Math.floor(distance/25),Math.floor((clamp(distance-lastState.remaining,0,distance)+1e-7)/25));
 if(station===similarityStation&&!force)return;
 if(station!==similarityStation){
  similarityStation=station;similarityController?.abort();similarityBusy=false;
  $('similarity-station').textContent=`${station*25} m point`;
  $('similarity-value').textContent='Checking captured images…';$('similarity-warning').hidden=true;
 }
 if(similarityBusy)return;
 similarityBusy=true;const controller=new AbortController();similarityController=controller;
 const timeout=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await fetch(`/api/v1/runs/${encodeURIComponent(id)}/images/${station}/similarity`,{signal:controller.signal});
  if(!response.ok)throw new Error('Similarity unavailable');
  const value=await response.json();
  if(closed||station!==similarityStation||similarityController!==controller)return;
  $('similarity-value').textContent=value.status==='ready'?`${value.nearest_similarity_pct===null?'No other captures yet':`${value.nearest_similarity_pct.toFixed(1)}% closest match`} · ${value.similar_count} similar captures · ${value.database_images} unique images${value.database_captures!==undefined?` · ${value.database_captures} captures stored`:''}`:'Waiting for a captured camera image';
  $('similarity-warning').hidden=value.status!=='ready'||!value.too_similar;
 }catch{
  if(!closed&&station===similarityStation&&similarityController===controller){$('similarity-value').textContent='Similarity check unavailable';$('similarity-warning').hidden=true}
 }finally{clearTimeout(timeout);if(similarityController===controller)similarityBusy=false}
}
function connect(){
 if(closed)return;
 socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/v1/runs/${encodeURIComponent(id)}/stream`);
 socket.onopen=()=>{$('connection').textContent='Connected';$('connection').classList.add('online')};
 socket.onmessage=event=>{try{render(JSON.parse(event.data))}catch{$('warnings').textContent='Vehicle update unavailable'}};
 socket.onclose=()=>{$('connection').textContent='Reconnecting';$('connection').classList.remove('online');warnings();if(!closed)retry=setTimeout(connect,1200)};
 socket.onerror=()=>socket.close();
}
if(id){
 fetch(`/api/v1/runs/${encodeURIComponent(id)}`).then(response=>{if(!response.ok)throw new Error('Run unavailable');return response.json()}).then(value=>{run={...value,...run};render({run,type:'snapshot'})}).catch(()=>{$('warnings').textContent='Run unavailable · check the selected recording'});
 connect();
}else{$('connection').textContent='No run';$('warnings').textContent='Open the driver window from the engineering dashboard, or add ?run=RUN_ID to this URL.'}
const staleTimer=setInterval(warnings,500);
const similarityTimer=setInterval(()=>refreshSimilarity(true),1000);
addEventListener('pagehide',()=>{closed=true;clearTimeout(retry);clearInterval(staleTimer);clearInterval(similarityTimer);similarityController?.abort();socket?.close()});

