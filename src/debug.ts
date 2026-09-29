import {DurableObject} from "cloudflare:workers";
import type {Env} from "./types";

const MAX_EVENT_BYTES=256*1024;

function clip(v:unknown){
  const s=typeof v==="string"?v:JSON.stringify(v);
  return s.length<=MAX_EVENT_BYTES?s:s.slice(0,MAX_EVENT_BYTES)+"\n...[truncated]";
}

export type DebugEvent={
  traceId?:string;
  ts?:number;
  kind:string;
  phase?:string;
  [key:string]:unknown;
};

export function redact(value:unknown):unknown{
  if(value===null||value===undefined)return value;
  if(Array.isArray(value))return value.map(redact);
  if(typeof value!=="object")return value;
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(value as Record<string,unknown>)){
    if(/authorization|access.?token|refresh.?token|api.?key|secret|cookie|set-cookie/i.test(k)){
      out[k]="[REDACTED]";
    }else{
      out[k]=redact(v);
    }
  }
  return out;
}

export function redactHeaders(headers:Headers){
  const out:Record<string,string>={};
  for(const [k,v] of headers){
    out[k]=/authorization|cookie|api-key|x-api-key|token|secret/i.test(k)?"[REDACTED]":v;
  }
  return out;
}

export function debugEvent(env:Env,event:DebugEvent){
  const payload=JSON.stringify({
    ...event,
    ts:event.ts??Date.now(),
  });
  if(payload.length>MAX_EVENT_BYTES){
    return env.DEBUG_BUS.get(env.DEBUG_BUS.idFromName("default")).fetch("https://debug/internal/event",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({...event,ts:event.ts??Date.now(),data:clip(event.data)})
    }).catch(()=>undefined);
  }
  return env.DEBUG_BUS.get(env.DEBUG_BUS.idFromName("default")).fetch("https://debug/internal/event",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:payload
  }).catch(()=>undefined);
}

export class DebugBusDO extends DurableObject<Env>{
  async fetch(req:Request){
    const u=new URL(req.url);
    if(req.method==="GET"&&u.pathname==="/ws"){
      if(req.headers.get("Upgrade")?.toLowerCase()!=="websocket"){
        return new Response("Expected WebSocket",{status:426});
      }
      const [client,server]=Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({connectedAt:Date.now()});
      server.send(JSON.stringify({kind:"ready",ts:Date.now(),message:"debug stream connected"}));
      return new Response(null,{status:101,webSocket:client});
    }
    if(req.method==="POST"&&u.pathname==="/internal/event"){
      const raw=await req.text();
      let message:string;
      try{
        const parsed=JSON.parse(raw);
        message=JSON.stringify(parsed);
      }catch{
        message=JSON.stringify({kind:"debug_error",ts:Date.now(),message:"invalid debug event"});
      }
      for(const ws of this.ctx.getWebSockets()){
        if(ws.readyState===WebSocket.OPEN){
          try{ws.send(message)}catch{}
        }
      }
      return new Response(null,{status:204});
    }
    return new Response("not found",{status:404});
  }

  webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
    if(typeof message==="string"&&message==="ping"){
      try{ws.send(JSON.stringify({kind:"pong",ts:Date.now()}))}catch{}
    }
  }

  webSocketClose(ws:WebSocket,code:number,reason:string){
    try{ws.close(code,reason)}catch{}
  }
}
