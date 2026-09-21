import type {AnthropicRequest,InternalGenerateRequest} from "./types";

function textOf(c:unknown):string{
  if(typeof c==="string")return c;
  if(Array.isArray(c))return c.filter((x:any)=>x?.type==="text"&&typeof x.text==="string").map((x:any)=>x.text).join("");
  return "";
}

function modelMap(model:string):string{
  const m=model.toLowerCase();
  const map:Record<string,string>={
    "claude-sonnet-4-6":"claude-sonnet-4-6-thinking",
    "claude-sonnet-4-6-thinking":"claude-sonnet-4-6-thinking",
    "claude-opus-4-6":"claude-opus-4-6-thinking",
    "claude-opus-4-6-thinking":"claude-opus-4-6-thinking",
    "claude-sonnet-4-5":"claude-sonnet-4-6-thinking",
    "claude-opus-4-5":"claude-opus-4-6-thinking",
    "claude-haiku-4":"claude-sonnet-4-6-thinking"
  };
  return map[m]??model;
}

export function toAnthropicInternal(input:AnthropicRequest,project:string|undefined,ua:string):InternalGenerateRequest{
  const system=typeof input.system==="string"?input.system:(input.system??[]).map(x=>x.text).join("\n\n");
  const contents=input.messages.map(message=>({
    role:message.role==="assistant"?"model" as const:"user" as const,
    parts:Array.isArray(message.content)
      ? message.content.flatMap((p:any)=>{
          if(p.type==="text")return [{text:p.text??""}];
          if(p.type==="image"&&p.source?.type==="base64")return [{inlineData:{mimeType:p.source.media_type,data:p.source.data}}];
          if(p.type==="tool_use")return [{functionCall:{name:p.name,args:p.input??{},id:p.id}}];
          if(p.type==="tool_result")return [{functionResponse:{name:p.tool_use_id,response:{result:textOf(p.content)}}}];
          return [];
        })
      : [{text:message.content}]
  }));
  const generationConfig:Record<string,unknown>={maxOutputTokens:input.max_tokens};
  if(input.temperature!==undefined)generationConfig.temperature=input.temperature;
  if(input.top_p!==undefined)generationConfig.topP=input.top_p;
  if(input.top_k!==undefined)generationConfig.topK=input.top_k;
  if(input.stop_sequences?.length)generationConfig.stopSequences=input.stop_sequences;
  return {
    project,requestId:"agent/"+Date.now()+"/"+crypto.randomUUID().replaceAll("-","").slice(0,8),
    userAgent:ua,model:modelMap(input.model),
    request:{contents,...(system?{systemInstruction:{parts:[{text:system}]}}:{}),generationConfig}
  };
}

function partsOf(o:any):any[]{
  return o?.response?.candidates?.[0]?.content?.parts??o?.candidates?.[0]?.content?.parts??[];
}

function usageOf(o:any){
  const u=o?.response?.usageMetadata??o?.usageMetadata;
  return {input_tokens:u?.total_input_tokens??u?.promptTokenCount??0,output_tokens:u?.total_output_tokens??u?.candidatesTokenCount??0};
}

export function anthropicResponse(o:any,requestedModel:string){
  const parts=partsOf(o);
  const content=parts.flatMap((p:any)=>{
    if(typeof p.text==="string")return [{type:"text",text:p.text}];
    if(p.functionCall)return [{type:"tool_use",id:p.functionCall.id??crypto.randomUUID(),name:p.functionCall.name,input:p.functionCall.args??{}}];
    return [];
  });
  const finish=o?.response?.candidates?.[0]?.finishReason??o?.candidates?.[0]?.finishReason;
  return {
    id:"msg_"+crypto.randomUUID().replaceAll("-",""),type:"message",role:"assistant",model:requestedModel,content,
    stop_reason:finish==="MAX_TOKENS"?"max_tokens":content.some((x:any)=>x.type==="tool_use")?"tool_use":"end_turn",
    stop_sequence:null,usage:usageOf(o)
  };
}

export function anthropicStream(body:ReadableStream<Uint8Array>,requestedModel:string,onSuccess?:()=>Promise<void>,onFailure?:()=>Promise<void>){
  const dec=new TextDecoder(),enc=new TextEncoder(),id="msg_"+crypto.randomUUID().replaceAll("-","");
  let buf="",index=0,blockOpen=false;
  const emit=(event:string,data:any)=>enc.encode("event: "+event+"\ndata: "+JSON.stringify(data)+"\n\n");
  return new ReadableStream<Uint8Array>({
    start(controller){
      const reader=body.getReader();
      (async()=>{
        try{
          controller.enqueue(emit("message_start",{type:"message_start",message:{id,type:"message",role:"assistant",content:[],model:requestedModel,stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}}));
          for(;;){
            const {done,value}=await reader.read(); if(done)break;
            buf+=dec.decode(value,{stream:true});
            const lines=buf.split(/\r?\n/); buf=lines.pop()??"";
            for(const line of lines){
              let raw=line.trim(); if(!raw||raw.startsWith(":"))continue;
              if(raw.startsWith("data:"))raw=raw.slice(5).trim(); if(!raw||raw==="[DONE]")continue;
              let o:any; try{o=JSON.parse(raw)}catch{continue}
              for(const p of partsOf(o)){
                if(typeof p.text==="string"){
                  if(!blockOpen){controller.enqueue(emit("content_block_start",{type:"content_block_start",index,content_block:{type:"text",text:""}}));blockOpen=true;}
                  controller.enqueue(emit("content_block_delta",{type:"content_block_delta",index,delta:{type:"text_delta",text:p.text}}));
                }
              }
            }
          }
          if(blockOpen){controller.enqueue(emit("content_block_stop",{type:"content_block_stop",index}));index++;}
          controller.enqueue(emit("message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{input_tokens:0,output_tokens:0}}));
          controller.enqueue(emit("message_stop",{type:"message_stop"}));
          controller.close(); await onSuccess?.();
        }catch(e){await onFailure?.(); controller.error(e);}
        finally{reader.releaseLock();}
      })();
    }
  });
}
