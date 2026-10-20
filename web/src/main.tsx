import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import {Dashboard} from './Dashboard';
import {Driver} from './Driver';
import {CarlaPortal} from './CarlaView';
import {SimilarityDashboard} from './SimilarityDashboard';
import {ManagementDashboard} from './ManagementDashboard';
import './style.css';
import './metriczone.css';
import './management.css';
function App(){if(location.pathname==='/carla')return <CarlaPortal/>;if(location.pathname==='/management')return <ManagementDashboard/>;if(location.pathname==='/image-similarity')return <SimilarityDashboard/>;return <VehicleApp/>;}
function VehicleApp(){const [token,setToken]=useState<string>(),[error,setError]=useState('');useEffect(()=>{api('/config').then(c=>setToken(c.mapillary_access_token||'')).catch(e=>setError(e.message))},[]);if(error)return <div className="startup"><h1>SDV Lab</h1><p>Platform API unavailable: {error}</p><button onClick={()=>location.reload()}>Retry</button></div>;if(token===undefined)return <div className="startup">Connecting to your vehicle platform…</div>;const driver=location.pathname.match(/^\/driver\/([^/]+)$/);return driver?<Driver id={driver[1]} accessToken={token}/>:<Dashboard/>}
createRoot(document.getElementById('root')!).render(<App/>);

