import type {AnthropicRequest,InternalGenerateRequest} from "./types";

const PLACEHOLDER_THOUGHT_SIGNATURE="skip_thought_signature_validator";
const CLAUDE_TO_GEMINI:Record<string,string>={
"claude-sonnet-4-6":"claude-sonnet-4-6-thinking","claude-sonnet-4-6-20260219":"claude-sonnet-4-6-thinking","claude-sonnet-4-5":"claude-sonnet-4-6-thinking","claude-sonnet-4-5-thinking":"claude-sonnet-4-6-thinking","claude-sonnet-4-5-20250929":"claude-sonnet-4-6-thinking","claude-3-5-sonnet-20241022":"claude-sonnet-4-6-thinking","claude-3-5-sonnet-20240620":"claude-sonnet-4-6-thinking","claude-opus-4":"claude-opus-4-6-thinking","claude-opus-4-5-thinking":"claude-opus-4-6-thinking","claude-opus-4-5-20251101":"claude-opus-4-6-thinking","claude-opus-4-6":"claude-opus-4-6-thinking","claude-opus-4.6":"claude-opus-4-6-thinking","claude-opus-4.6-thinking":"claude-opus-4-6-thinking","claude-opus-4-6-20260201":"claude-opus-4-6-thinking","claude-haiku-4":"claude-sonnet-4-6-thinking","claude-3-haiku-20240307":"claude-sonnet-4-6-thinking","claude-haiku-4-5-20251001":"claude-sonnet-4-6-thinking"};
function modelMap(m:string){return CLAUDE_TO_GEMINI[m.toLowerCase()]??m;}
function textOf(c:unknown):string{return typeof c==="string"?c:Array.isArray(c)?c.filter((x:any)=>x?.type==="text").map((x:any)=>x.text??"").join("\n"):"";}
function systemOf(s:AnthropicRequest["system"]):string{return typeof s==="string"?s:(s??[]).map((x:any)=>x.text??"").join("\n\n");}
function toolsOf(ts:AnthropicRequest["tools"]){if(!ts?.length)return;const d=ts.filter(x=>x.name).map(x=>({name:x.name,description:x.description,parameters:x.input_schema??{}}));return d.length?[{functionDeclarations:d}]:undefined;}
function toolConfig(c:AnthropicRequest["tool_choice"]){let mode="VALIDATED";if(typeof c==="string")mode=c==="none"?"NONE":c==="auto"?"AUTO":"ANY";else if(c)mode="ANY";return {functionCallingConfig:{mode},includeServerSideToolInvocations:true};}

function contentsOf(ms:AnthropicRequest["messages"],thinking:boolean){
 const out:Array<{role:"user"|"model";parts:Array<Record<string,unknown>>}>=[];const names=new Map<string,string>();let sig:string|undefined;
 for(const m of ms){const ps:Array<Record<string,unknown>>=[];const bs:any[]=Array.isArray(m.content)?m.content:[{type:"text",text:m.content}];
  for(const b of bs){
   if(b.type==="text"&&b.text)ps.push({text:b.text});
   else if(b.type==="image"&&b.source?.type==="base64")ps.push({inlineData:{mimeType:b.source.media_type,data:b.source.data}});
   else if(b.type==="thinking"){if(b.thinking)ps.push({text:b.thinking,thought:true});if(b.signature){sig=b.signature;if(ps.length)Object.assign(ps[ps.length-1],{thoughtSignature:sig,thought_signature:sig});}}
   else if(b.type==="tool_use"){names.set(b.id,b.name);const s=b.signature??sig??(thinking?PLACEHOLDER_THOUGHT_SIGNATURE:undefined);ps.push({functionCall:{name:b.name,args:b.input??{},id:b.id},...(s?{thoughtSignature:s,thought_signature:s}:{})});}
   else if(b.type==="tool_result"){const name=names.get(b.tool_use_id)??b.tool_use_id;ps.push({functionResponse:{name,id:b.tool_use_id,response:{result:textOf(b.content)||"Command executed successfully."}},...(sig?{thoughtSignature:sig,thought_signature:sig}:{})});}
  }
  if(ps.length)out.push({role:m.role==="assistant"?"model":"user",parts:ps});
 }
 return out;
}

export function toAnthropicInternal(input:AnthropicRequest,project:string|undefined,ua:string):InternalGenerateRequest{
 const model=modelMap(input.model),thinking=Boolean(input.thinking)||model.includes("thinking")||model.includes("claude");
 const request:any={contents:contentsOf(input.messages,thinking),generationConfig:{maxOutputTokens:input.max_tokens}};
 const system=systemOf(input.system);if(system)request.systemInstruction={parts:[{text:system}]};
 if(input.temperature!==undefined)request.generationConfig.temperature=input.temperature;
 if(input.top_p!==undefined)request.generationConfig.topP=input.top_p;
 if(input.top_k!==undefined)request.generationConfig.topK=input.top_k;
 if(input.stop_sequences?.length)request.generationConfig.stopSequences=input.stop_sequences;
 if(thinking)request.generationConfig.thinkingConfig={includeThoughts:true,...(input.thinking?.budget_tokens?{thinkingBudget:input.thinking.budget_tokens}:{})};
 const tools=toolsOf(input.tools);if(tools){request.tools=tools;request.toolConfig=toolConfig(input.tool_choice);request.tool_config=request.toolConfig;}
 return {project,requestId:"agent/"+Date.now()+"/"+crypto.randomUUID().replaceAll("-","").slice(0,8),userAgent:ua,model,request};
}
function partsOf(o:any){return o?.response?.candidates?.[0]?.content?.parts??o?.candidates?.[0]?.content?.parts??[];}
function usageOf(o:any){const u=o?.response?.usageMetadata??o?.usageMetadata??{};return {input_tokens:u.total_input_tokens??u.promptTokenCount??0,output_tokens:u.total_output_tokens??u.candidatesTokenCount??0,cache_read_input_tokens:u.total_cached_tokens??u.cachedContentTokenCount??u.cachedTokens??0,reasoning_tokens:u.total_thought_tokens??u.totalThoughtTokens??u.thoughtsTokenCount??0};}
export function anthropicResponse(o:any,requestedModel:string){const ps=partsOf(o);const content=ps.flatMap((p:any)=>p.thought?[{type:"thinking",thinking:p.text??"",...(p.thoughtSignature?{signature:p.thoughtSignature}:{})}]:p.text!==undefined?[{type:"text",text:p.text}]:p.functionCall?[{type:"tool_use",id:p.functionCall.id??crypto.randomUUID(),name:p.functionCall.name,input:p.functionCall.args??{}}]:[]);const f=o?.response?.candidates?.[0]?.finishReason??o?.candidates?.[0]?.finishReason;return {id:"msg_"+crypto.randomUUID().replaceAll("-",""),type:"message",role:"assistant",model:requestedModel,content,stop_reason:f==="MAX_TOKENS"?"max_tokens":content.some((x:any)=>x.type==="tool_use")?"tool_use":"end_turn",stop_sequence:null,usage:usageOf(o)};}

export function anthropicStream(body:ReadableStream<Uint8Array>,requestedModel:string,onSuccess?:()=>Promise<void>,onFailure?:()=>Promise<void>){
 const dec=new TextDecoder(),enc=new TextEncoder(),id="msg_"+crypto.randomUUID().replaceAll("-","");let buf="",index=0;let block:any=null;
 const emit=(e:string,d:any)=>enc.encode("event: "+e+"\ndata: "+JSON.stringify(d)+"\n\n");
 return new ReadableStream<Uint8Array>({start(controller){const reader=body.getReader();(async()=>{try{
  controller.enqueue(emit("message_start",{type:"message_start",message:{id,type:"message",role:"assistant",content:[],model:requestedModel,stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}}));
  const close=()=>{if(block){controller.enqueue(emit("content_block_stop",{type:"content_block_stop",index}));index++;block=null;}};
  for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split(/\r?\n/);buf=lines.pop()??"";
   for(const line of lines){let raw=line.trim();if(!raw||raw.startsWith(":"))continue;if(raw.startsWith("data:"))raw=raw.slice(5).trim();if(!raw||raw==="[DONE]")continue;let o:any;try{o=JSON.parse(raw)}catch{continue}
    for(const p of partsOf(o)){
     if(p.functionCall){close();block={type:"tool_use",id:p.functionCall.id??crypto.randomUUID(),name:p.functionCall.name};controller.enqueue(emit("content_block_start",{type:"content_block_start",index,content_block:{type:"tool_use",id:block.id,name:block.name,input:{}}}));if(p.functionCall.args)controller.enqueue(emit("content_block_delta",{type:"content_block_delta",index,delta:{type:"input_json_delta",partial_json:JSON.stringify(p.functionCall.args)}}));}
     else if(p.thought){if(block?.type!=="thinking"){close();block={type:"thinking"};controller.enqueue(emit("content_block_start",{type:"content_block_start",index,content_block:{type:"thinking",thinking:""}}));}if(p.text)controller.enqueue(emit("content_block_delta",{type:"content_block_delta",index,delta:{type:"thinking_delta",thinking:p.text}}));if(p.thoughtSignature)controller.enqueue(emit("content_block_delta",{type:"content_block_delta",index,delta:{type:"signature_delta",signature:p.thoughtSignature}}));}
     else if(typeof p.text==="string"){if(block?.type!=="text"){close();block={type:"text"};controller.enqueue(emit("content_block_start",{type:"content_block_start",index,content_block:{type:"text",text:""}}));}controller.enqueue(emit("content_block_delta",{type:"content_block_delta",index,delta:{type:"text_delta",text:p.text}}));}
    }
   }
  }
  close();controller.enqueue(emit("message_delta",{type:"message_delta",delta:{stop_reason:block?.type==="tool_use"?"tool_use":"end_turn",stop_sequence:null},usage:{input_tokens:0,output_tokens:0}}));controller.enqueue(emit("message_stop",{type:"message_stop"}));controller.close();await onSuccess?.();
 }catch(e){await onFailure?.();controller.error(e)}finally{reader.releaseLock()}})();}});
}
