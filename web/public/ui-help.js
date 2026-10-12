/* Shared delayed explanations for the dashboard, driver, instruments and deck. */
(() => {
  const DELAY = 3000;
  const text = element => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim();
  const label = element => {
    const copy = element.closest('label')?.cloneNode(true);
    copy?.querySelectorAll('input,select,button').forEach(child => child.remove());
    return element.getAttribute('aria-label') || copy?.textContent?.trim() || '';
  };
  const fields = {
    Route: 'Choose a prepared driving route. Its geometry and endpoints appear on the map. Stop the drive before changing routes.',
    'Recorded run': 'Select a saved run to inspect its state, messages, results and replay. Selecting a recording does not start another drive.',
    'Initial charge': 'Set the battery charge, from 0 to 100%, for the next drive. This cannot change the battery of an active run.',
    'Replay time': 'Scrub a finished recording to this simulation time. The dashboard, driver and instruments follow the same replay cursor.',
    'Left hand traffic': 'Prepare the selected road network for driving on the left side of the road.',
    ECU: 'Choose the vehicle module that will receive the injected fault.',
    Fault: 'Choose how to disturb the selected module: delay, drop, duplicate, freeze or substitute messages, stop its application, or withdraw navigation.',
    Signal: 'Choose the reported signal to freeze or replace. Ground truth is recorded separately.',
    Value: 'Set the replacement value for the selected signal, in that signal’s units.',
    'Duration (s)': 'Set how many simulation seconds the injected fault should remain active.',
    'Sequence time window': 'Choose how much recorded history appears before the current cursor: one 50 ms cycle, 250 ms, or one second.',
    'Sequence node': 'Show recorded messages involving this node, or choose all nodes to see the entire exchange.',
    'Sequence transport': 'Filter the recorded sequence to CAN, SOME/IP, or both transports.',
    'Include every CAN receiver': 'Include every adapter that observed a CAN reception, including receivers beyond the declared contract consumers.',
  };
  const buttons = {
    'Start drive': 'Start a new simulation using the prepared route and initial battery charge. Clear unprepared pins first. Open the driver’s view to capture street images.',
    Stop: 'Request the active drive to stop and finish its recording. The saved run remains available for replay and export.',
    'Open driver’s view': 'Open an independent window with vehicle instruments, the location map, street imagery and image similarity. Closing this dashboard does not stop the drive.',
    'Reset pins': 'Clear the start and destination pins selected on the map so you can choose new endpoints.',
    'Prepare route': 'Prepare roads and a driving route between the two selected map pins. Review the snapped endpoints before starting. Routes must be 100 m to 5 km.',
    Cancel: 'Cancel the route preparation job currently in progress.',
    'Inject fault': 'Apply the chosen fault to the selected ECU during the active drive, for the specified duration.',
    Remove: 'End this active fault now instead of waiting for its configured duration.',
    Dismiss: 'Close this error message. The message does not change the run or resolve its cause.',
    'Rerun configuration': 'Create and start a new run using the selected recording’s saved vehicle profile, route, seed, modules and scheduled faults.',
    'Play replay': 'Advance through a finished recording. Other open views follow the replay cursor.',
    'Pause replay': 'Pause replay at the current simulation time so you can inspect the recorded evidence.',
    Delete: 'Delete the selected vehicle recording and its events. Captured images in the similarity database are retained.',
    'Following vehicle': 'Heading tracking is enabled. Click to release it and look around the current image.',
    'Follow vehicle': 'Restore panorama heading tracking to the vehicle. Flat photographs retain their fixed camera direction.',
    'Retry capture': 'Try saving the current street image and its pHash again. Repeated uploads do not create duplicate captures.',
    'Show all nodes': 'Remove the ECU node filter so all communication contracts are shown.',
    Right: 'Request a lane change to the vehicle’s right during the active drive. The controller and lane ECU apply the request.',
    Left: 'Request a lane change to the vehicle’s left during the active drive. The controller and lane ECU apply the request.',
    'Zoom in': 'Zoom in on this map or image to inspect more detail.',
    'Zoom out': 'Zoom out on this map or image to see a wider area.',
    'next slide': 'Advance to the next presentation slide. You can also press the right arrow key.',
    'previous slide': 'Return to the previous presentation slide. You can also press the left arrow key.',
  };
  const metrics = {
    SPEED: 'Actual vehicle speed in kilometres per hour, from simulator ground truth.',
    BATTERY: 'Actual remaining battery charge as a percentage of capacity, from ground truth.',
    PROGRESS: 'Percentage of the prepared driving route already completed.',
    SIMULATION: 'Elapsed simulation time in seconds. Replay uses the recorded simulation clock.',
  };
  const signals = {
    Speed: 'Vehicle speed reported by the sensor ECU, in metres per second. Fault injection can make it differ from ground truth.',
    Charge: 'Battery charge reported by the BMS, as a percentage. Fault injection can make it differ from actual charge.',
    TargetSpeed: 'The controller’s requested target speed, in metres per second.',
    Acceleration: 'Requested forward acceleration, in metres per second squared.',
    Deceleration: 'Requested braking deceleration, in metres per second squared.',
    PropulsionLimit: 'BMS propulsion allowance from 0 to 1. Low battery charge reduces permitted propulsion.',
    LowBattery: 'The BMS warning flag for reported battery charge below 10%.',
    LaneIndex: 'The reported lane index. The instrument display uses a human-readable lane number.',
  };
  const rules = [
    ['.similarity-warning,#similarity-warning', 'At least five other captured observations match this view within 8 bits of its 64-bit pHash. Drive to another place to collect more varied scenery. Captures from different drives or stations count separately, even when their image bytes are identical. Repeated uploads for one run/station do not inflate the count.'],
    ['.similarity-heading small,#similarity-station', 'The current image capture station along the route. Street images change at 25 metre driving-distance intervals.'],
    ['.image-similarity', 'Compare the current station’s captured source image against the persistent image database. The closest-match percentage is 100 × (1 − differing pHash bits / 64). A match differs by at most 8 bits; five other captured observations trigger the warning. Earlier captures of the same image match at 100%. Panoramas use the full source image.'],
    ['button,[role="button"]', element => {
      const name = text(element).replace(/^[▶■←→✓×]+\s*/, '').replace(/\s*[↗↓→]$/, '');
      let help = buttons[name];
      if(!help && name.startsWith('Inspect ')) help = `Inspect the ${name.slice(8)} node and its produced and consumed message contracts. Click the selected node again to clear its filter.`;
      if(!help && element.matches('.contract-row')) help = `Select this ${name} communication contract to highlight its producer and consumers and inspect its signals, units and latest reported values.`;
      if(!help && element.closest('.trace-filters')) help = name === 'all' ? 'Show all protocols in the sampled live communication trace.' : `Show only ${name} observations in the sampled live communication trace. Exports still contain the complete recording.`;
      return (help || `Activate ${name || 'this control'}.`) + (element.matches(':disabled,[aria-disabled="true"]') ? ' This control is currently unavailable; its prerequisites must be met first.' : '');
    }],
    ['input,select,label', element => fields[label(element)] || (element.matches('label') ? fields[text(element)] : '')],
    ['a', element => {
      const href = element.getAttribute('href') || '', name = text(element);
      if(buttons[name]) return buttons[name];
      if(href.includes('format=signals')) return 'Download every decoded signal observation, with time, source, destination, value, unit and VSS mapping, as a CSV file.';
      if(href.includes('format=csv')) return 'Download all recorded communication events, including raw payloads and decoded signals, as a CSV file.';
      if(href.includes('format=jsonl')) return 'Download the full vehicle recording, configuration, state and events as JSONL. Image bytes and access tokens are excluded.';
      if(href.includes('print-pdf')) return 'Open the printable slide layout. Use the browser’s Print dialog to save the presentation as a PDF.';
      if(href.includes('/presentation')) return 'Open the platform presentation, including image capture, pHash matching and the five-image similarity warning.';
      if(href.includes('/instruments') || name.includes('instruments separately')) return 'Open the independent vehicle instruments in a separate window for the same run and replay cursor.';
      if(href.startsWith('/driver/')) return 'Open the driver’s view directly. This link also works when browser popup windows are blocked.';
      if(href === '#architecture-view') return 'Jump to the interactive vehicle E/E architecture and communication contracts.';
      if(href === '#sequence-view') return 'Jump to the recorded ECU communication sequence and its time, node and protocol filters.';
      if(href === '/') return 'Open the engineering test bench for route preparation, driving, fault injection, recordings and replay.';
      if(element.closest('.leaflet-control-attribution,[class*="attribution"]')) return 'View the map or imagery provider and contributor attribution. Follow the link for source information.';
      if(href.startsWith('http')) return `Open the source or reference for ${name || 'this item'} in the linked website.`;
      return `Open ${name || 'this link'}.`;
    }],
    ['.metrics>div', element => metrics[element.querySelector('small')?.textContent?.trim()] ],
    ['.signals-panel dl>div', element => signals[element.querySelector('dt')?.textContent] || 'Latest decoded value received from a vehicle ECU. These reported values can be affected by injected faults.'],
    ['.signal-contract-grid>div', element => `Signal ${element.querySelector('b')?.textContent || ''}: its unit or payload type, declared consumers and latest recorded value. A dash means no value has been observed yet.`],
    ['.sequence-message', 'One recorded message observation. Solid arrows indicate transmission; dashed arrows confirm an adapter observed reception. The timestamp is simulation time.'],
    ['.trace-chart,.chart-heading', 'Compare actual speed (solid teal) with sensor-reported speed (dashed orange). A divergence can reveal a reporting fault.'],
    ['.event-scroll td,.event-scroll th', element => {
      const index = Array.from(element.parentElement.children).indexOf(element);
      return ['Simulation timestamp of this observation, in seconds.', 'The ECU or platform component that observed this event.', 'Transport or event category: CAN, SOME/IP, FAULT, SIM or health.', 'Recorded event type, such as transmission, reception or fault activation.', 'Message identifier and sequence counter. CAN identifiers are hexadecimal.', 'Raw message bytes and decoded signal values. The live table is sampled; exports retain all observations.'][index];
    }],
    ['.ecu', element => `Application health for the ${element.querySelector('b')?.textContent} ECU. Its activity dot lights when recent communication is visible; stopped or failed applications remain shown.`],
    ['.ecu-dot', 'Recent communication activity for this ECU in the sampled live events. A dim dot does not itself prove a fault.'],
    ['.service-link', 'Navigation sends target speed, lane request and remaining distance to the controller over SOME/IP.'],
    ['.can-bus,.bus-label', 'CAN FD is the functional broadcast bus used by sensor, battery, controller and actuator modules. Each observed reception is recorded separately.'],
    ['.network-summary', 'The control cycle is 50 ms, stale control inputs expire after 200 ms, and KUKSA mirrors reported signals through the gateway.'],
    ['.connection-dot,.connection,#connection,.driver-shell header .pill', 'Connection to the selected run’s live or replay stream. Reconnecting means the displayed state may be the last received state.'],
    ['.dashboard header .pill', 'Overall platform service health. Ready means the required services and applications are available; degraded means at least one needs attention.'],
    ['.drive-panel .section-heading .pill,#mode', 'Current run state or replay mode. A completed, stopped or timed-out run can be reviewed from its recording.'],
    ['.sequence-panel .pill', 'Whether the sequence is live or replayed, and the simulation time of its most recently loaded observations.'],
    ['.job-status', 'Current route preparation stage and progress. Failed jobs retain your map pins so you can retry.'],
    ['.active-faults', 'Faults currently applied to the vehicle. Each ends after its duration or when you remove it.'],
    ['.test-results>span', 'Result of a configured run assertion. A check mark means the observed result met its condition; a cross indicates failure.'],
    ['.energy-summary>span', element => text(element).startsWith('Consumed') ? 'Total electrical energy consumed during this drive, in watt-hours.' : text(element).startsWith('Regenerated') ? 'Electrical energy recovered during braking, in watt-hours.' : 'Instantaneous electrical power in kilowatts. Negative power indicates regeneration.'],
    ['.map-note,.route-map .map-wrap', 'Click the map to choose a start and then a destination. Prepare route validates and snaps these pins to drivable roads. The teal line is the prepared route; the moving arrow follows actual vehicle position.'],
    ['.vehicle-marker', 'Actual vehicle position and heading from simulator ground truth, independent of faults in ECU-reported location.'],
    ['.driver-fallback,.driver-location-map', 'Actual vehicle location on OpenStreetMap. This map remains available when street imagery is missing or still loading.'],
    ['.panorama', 'Current Mapillary street image, held for this 25 m interval. Drag or zoom to look around and release heading tracking; Follow vehicle restores tracking. Images are scenery and do not show simulated traffic.'],
    ['.driver-controls>span', 'Street imagery availability, live offset from the car, original capture date, current 25 m point and preload progress. Preloaded future images are not added to the capture database.'],
    ['.speedometer,#speed', 'Actual vehicle speed in kilometres per hour, from simulator ground truth.'],
    ['#charge,.battery-track', 'Actual battery state of charge, from 0 to 100%. Below 10% the instruments show a low-battery warning.'],
    ['#energy', 'Electrical energy currently remaining in the battery, in kilowatt-hours.'],
    ['#capacity', 'Configured total battery capacity in kilowatt-hours, or the vehicle class when capacity is not available.'],
    ['.power-section,.power-track,#power', 'Instantaneous electrical power in kilowatts. Positive values consume battery energy; negative values recover energy through regeneration.'],
    ['#progress,#journey-progress', 'Percentage of the prepared journey completed, calculated from actual driving distance.'],
    ['#remaining', 'Distance left to the destination along the prepared route, in kilometres.'],
    ['#travelled', 'Distance already travelled along the prepared route, in kilometres.'],
    ['#elapsed', 'Elapsed simulation time in seconds, or the selected recording time during replay.'],
    ['#limit', 'Road speed limit in kilometres per hour. A dash indicates no valid limit is available.'],
    ['#gear', 'Instrument drive indication: D while moving or driving, P while parked.'],
    ['#lane', 'Actual lane number, shown starting at one for readability.'],
    ['#heading', 'Actual vehicle heading in degrees, measured clockwise from north.'],
    ['#warnings', 'Vehicle and display warnings, including low battery, red traffic signals, stale updates and incomplete recordings.'],
    ['#route-name', 'Name of the route associated with the selected live drive or recording.'],
    ['.architecture-svg', 'Interactive ECU topology. Select a node to filter its contracts, or a contract to highlight the producer and consumers. CAN is broadcast; navigation intent uses SOME/IP.'],
    ['.sequence-scroll', 'Actual recorded ECU message order. Filter by time, node or transport; scroll horizontally to inspect all participants.'],
    ['.architecture-caption', 'Selected communication contract or node filter, with the message update interval and expiry threshold where shown.'],
    ['.alert,[role="alert"],.result-fail', 'An error, warning or failed assertion requiring attention. Its text describes the current condition.'],
    ['.reveal .progress', 'Presentation progress. Click along this bar to move through the slides.'],
    ['.reveal .slide-number', 'Current main topic and detail slide, for example 3.1, followed by the 19 main topics. Click to open the slide overview.'],
    ['.reveal svg', element => element.getAttribute('aria-label') === 'Platform architecture' ? 'Platform services and their connections: browser views, API, ECUs, road simulator, recorder and signal gateway.' : 'Illustrative ECU communication flow. The test bench’s sequence view shows the actual recorded transmissions and receptions.'],
    ['.reveal .slides section h1,.reveal .slides section h2', 'Title of the current presentation topic. Use the arrow keys or navigation controls to move between slides; Esc opens the overview.'],
    ['.reveal .slides section p,.reveal .slides section li,.reveal .slides section dt,.reveal .slides section dd,.reveal .slides section td,.reveal .slides section th', element => `Presentation explanation: ${text(element)} Speaker notes (S) provide additional context and source references.`],
    ['.deck-header nav>span', 'Use left/right arrows for main topics, up/down for detail slides, Esc for the overview, S for speaker notes and F for fullscreen.'],
    ['.brand,.deck-brand,header img,.cover-layout img', 'Metriczone measurement lab identity: Measure. Understand. Improve.'],
    ['.header-meta,.tiny-label', 'The technologies or signal source used by this part of the measurement lab.'],
    ['footer', 'Platform context, source attribution and scope of the displayed vehicle or imagery.'],
    ['.section-heading h2', element => `The ${text(element).replace(/^\d+\s*/, '')} section groups related controls and readings. Hover over an individual item for its explanation.`],
  ];

  function resolve(target) {
    if(!(target instanceof Element) || target.closest('iframe,[data-ui-help-ignore]')) return null;
    let fallback = null;
    for(let element=target; element && element!==document.body; element=element.parentElement) {
      if(element.dataset.help) return {element, help:element.dataset.help};
      for(const [selector, description] of rules) {
        if(!element.matches(selector)) continue;
        const help = typeof description === 'function' ? description(element) : description;
        if(help) return {element,help:help + (element.dataset.nativeHelp ? ` ${element.dataset.nativeHelp}` : '')};
      }
      if(element.dataset.nativeHelp) return {element, help:element.dataset.nativeHelp};
      if(!fallback && element.matches('h1,h2,h3,p,small,span,strong,b,dt,dd,[role="status"]') && text(element)) {
        fallback = {element,help:`${text(element)}. This label or reading describes the current vehicle, run or display state.`};
      }
    }
    return fallback;
  }

  function init() {
    const style=document.createElement('style');
    style.textContent='#sdv-ui-help{position:fixed;z-index:2147483647;box-sizing:border-box;max-width:min(390px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:hidden;padding:12px 15px;border:1px solid #87aeb8;border-radius:7px;background:#003f4d;color:#fff;box-shadow:0 5px 24px #001e2d45;font:13px/1.5 "Segoe UI",system-ui,sans-serif;letter-spacing:normal;text-align:left;white-space:pre-line;pointer-events:none}#sdv-ui-help[hidden]{display:none}@media print{#sdv-ui-help{display:none!important}}';
    document.head.append(style);
    const tooltip=document.createElement('div');tooltip.id='sdv-ui-help';tooltip.role='tooltip';tooltip.hidden=true;document.body.append(tooltip);
    let current=null,timer,point={x:0,y:0},keyboard=false,previousDescription=null;
    function hide(){
      clearTimeout(timer);tooltip.hidden=true;
      if(current && previousDescription!==null){
        if(previousDescription)current.element.setAttribute('aria-describedby',previousDescription);
        else current.element.removeAttribute('aria-describedby');
      }
      previousDescription=null;current=null;
    }
    function place(){
      const bounds=keyboard?current.element.getBoundingClientRect():null;
      const x=bounds?bounds.left:point.x,y=bounds?bounds.bottom:point.y;
      const width=tooltip.offsetWidth,height=tooltip.offsetHeight;
      tooltip.style.left=`${Math.max(12,Math.min(x+14,innerWidth-width-12))}px`;
      tooltip.style.top=`${Math.max(12,y+18+height<=innerHeight-12?y+18:y-height-14)}px`;
    }
    function schedule(target,focus=false){
      const next=resolve(target);
      if(next?.element===current?.element && next?.help===current?.help)return;
      hide();if(!next)return;current=next;keyboard=focus;
      timer=setTimeout(()=>{
        if(!current?.element.isConnected || document.hidden){hide();return}
        tooltip.textContent=current.help;tooltip.hidden=false;
        previousDescription=current.element.getAttribute('aria-describedby') || '';
        current.element.setAttribute('aria-describedby',[previousDescription,tooltip.id].filter(Boolean).join(' '));place();
      },DELAY);
    }
    function preserveTitles(root){
      if(!(root instanceof Element))return;
      const nodes=[root,...root.querySelectorAll('[title],svg title')];
      for(const element of nodes){
        if(element.hasAttribute('title') && element.tagName!=='IFRAME'){
          const value=element.getAttribute('title');if(value)element.dataset.nativeHelp=value; element.removeAttribute('title');
        }
        if(element.matches('svg title')){element.parentElement.dataset.nativeHelp=element.textContent; element.remove()}
      }
    }
    preserveTitles(document.body);
    const observer=new MutationObserver(records=>{
      for(const record of records){
        if(record.type==='attributes')preserveTitles(record.target);
        else record.addedNodes.forEach(preserveTitles);
      }
      if(current && !current.element.isConnected)hide();
    });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['title']});
    document.addEventListener('pointerover',event=>{if(event.pointerType==='touch')return;point={x:event.clientX,y:event.clientY};schedule(event.target)},true);
    document.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;point={x:event.clientX,y:event.clientY};if(!current)schedule(event.target);if(!tooltip.hidden && !keyboard)place()},true);
    document.addEventListener('pointerout',event=>{if(!current)return;const next=resolve(event.relatedTarget);if(next?.element!==current.element)hide()},true);
    document.addEventListener('focusin',event=>schedule(event.target,true));
    document.addEventListener('focusout',hide);
    document.addEventListener('pointerdown',hide,true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')hide()},true);
    document.addEventListener('scroll',()=>{
      // A scroll event may arrive just after the pointer enters a newly revealed
      // control. Restart the delay at the pointer's new location after scrolling.
      const focused=keyboard;hide();
      schedule(focused?document.activeElement:document.elementFromPoint(point.x,point.y),focused);
    },true);
    document.addEventListener('visibilitychange',hide);window.addEventListener('blur',hide);
    window.addEventListener('pagehide',()=>{hide();observer.disconnect()},{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
