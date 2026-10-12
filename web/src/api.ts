import {useEffect,useRef,useState} from 'react';
import type {Packet} from './types';
export async function api<T=any>(path:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch('/api/v1'+path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if(!response.ok)throw new Error(typeof value.detail==='string'?value.detail:JSON.stringify(value.detail));
  return value;
}
export function useStream(id:string|undefined,onPacket:(p:Packet)=>void){
  const callback=useRef(onPacket);callback.current=onPacket;
  const [connected,setConnected]=useState(false);
  useEffect(()=>{if(!id)return;let stopped=false,timer:ReturnType<typeof setTimeout>,socket:WebSocket;
    function connect(){socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/v1/runs/${id}/stream`);socket.onopen=()=>setConnected(true);socket.onmessage=e=>callback.current(JSON.parse(e.data));socket.onclose=()=>{setConnected(false);if(!stopped)timer=setTimeout(connect,1200)};socket.onerror=()=>socket.close();}
    connect();return()=>{stopped=true;clearTimeout(timer);socket.close();setConnected(false)};
  },[id]);return connected;
}
