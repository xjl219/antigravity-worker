import {CodeAssistClient,UpstreamError} from "./code-assist";
import {toInternal} from "./openai";
import {geminiSchema} from "./anthropic";
import type {Env,ChatRequest,InternalGenerateRequest,GeminiPart} from "./types";

type ResponseInputItem = Record<string,any>;
type ResponsesRequest = {
  model?:string;
  input:string|ResponseInputItem[];
  instructions?:string;
  tools?:Array<Record<string,any>>;
  tool_choice?:unknown;
  temperature?:number;
  top_p?:number;
  max_output_tokens?:number;
  stream?:boolean;
  previous_response_id?:string;
  store?:boolean;
  metadata?:Record<string,unknown>;
  prompt_cache_key?:string;
  client_metadata?:Record<string,unknown>|string;
};
type OutputItem = Record<string,any>;

const id=(prefix:string)=>prefix+"_"+crypto.randomUUID().replaceAll("-","");
const asText=(value:any):string=>{
  if(typeof value==="string")return value;
  if(!Array.isArray(value))return "";
  const unsupported=value.find(x=>x&&x.type&&!["input_text","output_text","text"].includes(x.type));
  if(unsupported)throw new Error(`unsupported message content type: ${String(unsupported.type)}`);
  return value.filter(x=>x&&["input_text","output_text","text"].includes(x.type)&&typeof x.text==="string").map(x=>x.text).join("");
};
function invalid(message:string,status=400){return Response.json({error:{message,type:"invalid_request_error",param:null,code:null}},{status});}

export function buildInternal(input:ResponsesRequest,project:string,defaultModel:string):InternalGenerateRequest{
  if(input.previous_response_id)throw new Error("previous_response_id is not supported yet; resend the conversation input explicitly");
  const items:ResponseInputItem[]=typeof input.input==="string"
    ?[{type:"message",role:"user",content:[{type:"input_text",text:input.input}]}]
    :Array.isArray(input.input)?input.input:[];
  const messages:ChatRequest["messages"]=input.instructions?[{role:"system",content:input.instructions}]:[];
  const contents:Array<{role:"user"|"model";parts:GeminiPart[]}>=[];
  const functionNames=new Map<string,string>();
  for(const item of items){
    if(!item||typeof item!=="object")continue;
    if(item.type==="message"){
      const role=item.role==="assistant"?"assistant":item.role==="system"||item.role==="developer"?"system":"user";
      const value=asText(item.content);
      if(role==="system")messages.push({role:"system",content:value});
      else contents.push({role:role==="assistant"?"model":"user",parts:[{text:value}]});
    }else if(item.type==="function_call"){
      let args:Record<string,unknown>={};
      try{args=typeof item.arguments==="string"?JSON.parse(item.arguments):item.arguments??{};}catch{throw new Error("function_call.arguments must contain valid JSON");}
      const callId=String(item.call_id??item.id??id("call"));
      functionNames.set(callId,String(item.name));
      contents.push({role:"model",parts:[{functionCall:{name:String(item.name),args,id:callId}}]});
    }else if(item.type==="function_call_output"){
      const callId=String(item.call_id??"");
      contents.push({role:"user",parts:[{functionResponse:{name:functionNames.get(callId)??String(item.name??"function"),id:callId,response:{result:item.output}}}]});
    }else{
      throw new Error(`unsupported Responses input item type: ${String(item.type)}`);
    }
  }
  const chat:ChatRequest={model:input.model,messages:[...messages,...(contents.length?[]:[{role:"user" as const,content:""}])],temperature:input.temperature,top_p:input.top_p,max_tokens:input.max_output_tokens};
  const base=toInternal(chat,project,defaultModel);
  base.request.contents=contents.length?contents:[{role:"user",parts:[{text:""}]}];
  const tools=(input.tools??[]).filter(t=>t?.type==="function").map(t=>({
    name:String(t.name??t.function?.name??""),
    description:String(t.description??t.function?.description??""),
    parameters:geminiSchema(t.parameters??t.function?.parameters??{type:"object",properties:{}})
  })).filter(t=>t.name);
  if(tools.length){
    base.request.tools=[{functionDeclarations:tools}];
    base.request.toolConfig={functionCallingConfig:{mode:"AUTO"}};
  }
  if(input.tool_choice&&typeof input.tool_choice==="object"&&(input.tool_choice as any).type==="function"){
    base.request.toolConfig={functionCallingConfig:{mode:"ANY",allowedFunctionNames:[(input.tool_choice as any).name]}};
  }else if(input.tool_choice==="none"){
    base.request.toolConfig={functionCallingConfig:{mode:"NONE"}};
  }else if(input.tool_choice==="required"){
    base.request.toolConfig={functionCallingConfig:{mode:"ANY"}};
  }
  return base;
}

export function extract(raw:any,model:string):{output:OutputItem[];usage:Record<string,number>;finishReason:string}{
  const root=raw?.response??raw;
  const parts:GeminiPart[]=root?.candidates?.[0]?.content?.parts??[];
  const output:OutputItem[]=[];
  const text=parts.filter(p=>typeof p.text==="string"&&!p.thought).map(p=>p.text).join("");
  if(text)output.push({id:id("msg"),type:"message",status:"completed",role:"assistant",content:[{type:"output_text",text,annotations:[]}]});
  for(const p of parts){
    if(p.functionCall?.name)output.push({id:id("fc"),type:"function_call",status:"completed",call_id:p.functionCall.id??id("call"),name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args??{})});
  }
  const u=root?.usageMetadata??{};
  const input_tokens=Number(u.promptTokenCount??u.total_input_tokens??0);
  const output_tokens=Number(u.candidatesTokenCount??u.total_output_tokens??0);
  return {output,usage:{input_tokens,output_tokens,total_tokens:input_tokens+output_tokens},finishReason:String(root?.candidates?.[0]?.finishReason??"STOP")};
}
function responseObject(result:{output:OutputItem[];usage:Record<string,number>;finishReason:string},model:string,respId:string){
  return {id:respId,object:"response",created_at:Math.floor(Date.now()/1000),status:"completed",background:false,completed_at:Math.floor(Date.now()/1000),error:null,incomplete_details:null,instructions:null,max_output_tokens:null,model,output:result.output,parallel_tool_calls:true,previous_response_id:null,reasoning:{effort:null,summary:null},store:false,temperature:null,text:{format:{type:"text"}},tool_choice:"auto",tools:[],top_p:null, truncation:"disabled",usage:result.usage,metadata:{}};
}
const enc=new TextEncoder();
function event(controller:ReadableStreamDefaultController<Uint8Array>,type:string,data:unknown){
  controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
}
function streamResponse(body:ReadableStream<Uint8Array>,model:string,respId:string,onSuccess:()=>Promise<void>,onFailure:()=>Promise<void>){
  return new ReadableStream<Uint8Array>({
    start(controller){
      const reader=body.getReader(),decoder=new TextDecoder();
      let buffer="",text="",roleAdded=false;
      let usage={input_tokens:0,output_tokens:0,total_tokens:0};
      const output:OutputItem[]=[];
      const messageId=id("msg"),itemIndex=0;
      event(controller,"response.created",{type:"response.created",response:{id:respId,object:"response",status:"in_progress",model,output:[]}});
      event(controller,"response.in_progress",{type:"response.in_progress",response:{id:respId,object:"response",status:"in_progress",model,output:[]}});
      const consume=(line:string)=>{
        let data=line.trim();
        if(data.startsWith("data:"))data=data.slice(5).trim();
        if(!data||data==="[DONE]")return;
        let parsed:any;try{parsed=JSON.parse(data)}catch{return;}
        const root=parsed.response??parsed,parts:GeminiPart[]=root?.candidates?.[0]?.content?.parts??[];
        const meta=root?.usageMetadata??{};
        if(meta.promptTokenCount!==undefined||meta.candidatesTokenCount!==undefined){
          usage.input_tokens=Number(meta.promptTokenCount??meta.total_input_tokens??usage.input_tokens);
          usage.output_tokens=Number(meta.candidatesTokenCount??meta.total_output_tokens??usage.output_tokens);
          usage.total_tokens=usage.input_tokens+usage.output_tokens;
        }
        for(const p of parts){
          if(typeof p.text==="string"&&!p.thought&&p.text){
            if(!roleAdded){
              event(controller,"response.output_item.added",{type:"response.output_item.added",output_index:itemIndex,item:{id:messageId,type:"message",status:"in_progress",role:"assistant",content:[]}});
              event(controller,"response.content_part.added",{type:"response.content_part.added",item_id:messageId,output_index:itemIndex,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
              roleAdded=true;
            }
            text+=p.text;
            event(controller,"response.output_text.delta",{type:"response.output_text.delta",item_id:messageId,output_index:itemIndex,content_index:0,delta:p.text});
          }
          if(p.functionCall?.name)output.push({id:id("fc"),type:"function_call",status:"completed",call_id:p.functionCall.id??id("call"),name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args??{})});
        }
      };
      (async()=>{
        try{
          for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??"";for(const line of lines)consume(line);}
          if(buffer.trim())consume(buffer);
          if(roleAdded){
            event(controller,"response.output_text.done",{type:"response.output_text.done",item_id:messageId,output_index:itemIndex,content_index:0,text});
            event(controller,"response.content_part.done",{type:"response.content_part.done",item_id:messageId,output_index:itemIndex,content_index:0,part:{type:"output_text",text,annotations:[]}});
            const msg={id:messageId,type:"message",status:"completed",role:"assistant",content:[{type:"output_text",text,annotations:[]}]};
            output.unshift(msg);
            event(controller,"response.output_item.done",{type:"response.output_item.done",output_index:itemIndex,item:msg});
          }
          for(let i=0;i<output.length;i++){
            if(output[i].type!=="function_call")continue;
            event(controller,"response.output_item.added",{type:"response.output_item.added",output_index:i,item:{...output[i],status:"in_progress",arguments:""}});
            event(controller,"response.function_call_arguments.delta",{type:"response.function_call_arguments.delta",item_id:output[i].id,output_index:i,delta:String(output[i].arguments??"")});
            event(controller,"response.function_call_arguments.done",{type:"response.function_call_arguments.done",item_id:output[i].id,output_index:i,arguments:String(output[i].arguments??"")});
            event(controller,"response.output_item.done",{type:"response.output_item.done",output_index:i,item:output[i]});
          }
          const result={output,usage,finishReason:"STOP"};
          event(controller,"response.completed",{type:"response.completed",response:responseObject(result,model,respId)});
          controller.close();await onSuccess();
        }catch(error){await onFailure();event(controller,"error",{type:"error",error:{type:"server_error",message:error instanceof Error?error.message:String(error)}});controller.close();}
        finally{reader.releaseLock();}
      })();
    }
  });
}

export async function handleResponses(req:Request,env:Env):Promise<Response>{
  let input:ResponsesRequest;
  try{input=await req.json() as ResponsesRequest;}catch{return invalid("request body must be valid JSON");}
  if(input.input===undefined)return invalid("input is required");
  if(input.previous_response_id)return invalid("previous_response_id is not supported yet; resend the conversation input explicitly");
  const traceId=crypto.randomUUID(),respId=id("resp");
  let sessionId=req.headers.get("x-antigravity-session-id")??req.headers.get("session-id")??req.headers.get("thread-id")??input.prompt_cache_key??undefined;
  if(!sessionId&&input.client_metadata){
    try{const meta=typeof input.client_metadata==="string"?JSON.parse(input.client_metadata):input.client_metadata;sessionId=meta?.session_id??meta?.thread_id;}catch{}
  }
  const responseModel=input.model??env.DEFAULT_MODEL;
  const failed:string[]=[];
  let last:UpstreamError|undefined;
  for(let attempt=0;attempt<3;attempt++){
    const allocation=await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default")).fetch("https://pool/internal/allocate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session_id:sessionId,exclude_account_ids:failed})});
    if(!allocation.ok)return new Response(last?.body??await allocation.text(),{status:last?.status??allocation.status,headers:{"content-type":"application/json","x-antigravity-debug-id":traceId}});
    const account=await allocation.json<any>();
    const currentSessionId=String(account.session_id??sessionId??"");
    if(!currentSessionId)return Response.json({error:{message:"account pool returned no session id",type:"server_error"}},{status:503});
    sessionId=currentSessionId;
    if(!account.project_id)return Response.json({error:{message:"account has no Code Assist project",type:"server_error"}},{status:503});
    let internal:InternalGenerateRequest;
    try{internal=buildInternal(input,account.project_id,env.DEFAULT_MODEL);}catch(e){return invalid(e instanceof Error?e.message:String(e));}
    try{
      const upstream=await new CodeAssistClient(env).generate(account.access_token,internal,!!input.stream);
      if(input.stream){
        const stream=streamResponse(upstream.body!,responseModel,respId,
          async()=>{await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default")).fetch("https://pool/internal/success",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:account.account_id,session_id:currentSessionId})});},
          async()=>{await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default")).fetch("https://pool/internal/failure",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:account.account_id,session_id:currentSessionId,status:502})});});
        return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","x-antigravity-session-id":currentSessionId,"x-antigravity-debug-id":traceId}});
      }
      const raw=await upstream.json();
      await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default")).fetch("https://pool/internal/success",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:account.account_id,session_id:currentSessionId})});
      const out=extract(raw,internal.model);
      return Response.json(responseObject(out,internal.model,respId),{headers:{"x-antigravity-session-id":sessionId,"x-antigravity-debug-id":traceId}});
    }catch(e){
      if(e instanceof UpstreamError){
        last=e;failed.push(account.account_id);
        await env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default")).fetch("https://pool/internal/failure",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account_id:account.account_id,session_id:sessionId,status:e.status})});
        if([401,403,429].includes(e.status)||e.status>=500)continue;
        return Response.json({error:{message:e.body,type:"upstream_error"}},{status:e.status});
      }
      return Response.json({error:{message:e instanceof Error?e.message:String(e),type:"server_error"}},{status:500});
    }
  }
  return Response.json({error:{message:last?.body??"upstream unavailable",type:"upstream_error"}},{status:last?.status??503});
}
