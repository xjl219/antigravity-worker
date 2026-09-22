import type {AnthropicContentBlock,AnthropicRequest,InternalGenerateRequest,GeminiPart} from "./types";

const SENTINEL_SIGNATURE="skip_thought_signature_validator";
const MIN_SIGNATURE_LENGTH=50;

const CLAUDE_TO_GEMINI:Record<string,string>={
  "claude-sonnet-4-6":"claude-sonnet-4-6-thinking",
  "claude-sonnet-4-6-20260219":"claude-sonnet-4-6-thinking",
  "claude-sonnet-4-5":"claude-sonnet-4-6-thinking",
  "claude-sonnet-4-5-thinking":"claude-sonnet-4-6-thinking",
  "claude-sonnet-4-5-20250929":"claude-sonnet-4-6-thinking",
  "claude-opus-4":"claude-opus-4-6-thinking",
  "claude-opus-4-5-thinking":"claude-opus-4-6-thinking",
  "claude-opus-4-5-20251101":"claude-opus-4-6-thinking",
  "claude-opus-4-6":"claude-opus-4-6-thinking",
  "claude-opus-4.6":"claude-opus-4-6-thinking",
  "claude-opus-4.6-thinking":"claude-opus-4-6-thinking",
  "claude-opus-4-6-20260201":"claude-opus-4-6-thinking",
  "claude-haiku-4":"claude-sonnet-4-6-thinking",
  "claude-3-haiku-20240307":"claude-sonnet-4-6-thinking"
};

function modelMap(m:string){return CLAUDE_TO_GEMINI[m.toLowerCase()]??m;}
function validSignature(v:unknown):v is string{return typeof v==="string"&&v.length>=MIN_SIGNATURE_LENGTH;}
function textOf(c:unknown):string{
  if(typeof c==="string")return c;
  if(Array.isArray(c))return c.filter((x:any)=>x?.type==="text").map((x:any)=>x.text??"").join("\n");
  return "";
}
function systemOf(s:AnthropicRequest["system"]):string{
  return typeof s==="string"?s:(s??[]).map(x=>x.text??"").join("\n\n");
}

/**
 * Gemini function declarations use an OpenAPI-style Schema, not full JSON
 * Schema. Tool clients commonly send JSON Schema draft metadata (for example
 * `$schema` and `propertyNames`), which the Code Assist API rejects with 400.
 * Keep the compatible subset and apply it recursively to nested schemas.
 */
function geminiSchema(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const schema=value as Record<string,unknown>;
  const out:Record<string,unknown>={};
  const type=Array.isArray(schema.type)
    ?schema.type.find((item):item is string=>typeof item==="string"&&item!=="null")
    :schema.type;

  if(typeof type==="string")out.type=type;
  if(Array.isArray(schema.type)&&schema.type.includes("null"))out.nullable=true;
  if(typeof schema.description==="string")out.description=schema.description;
  if(typeof schema.format==="string")out.format=schema.format;
  if(typeof schema.nullable==="boolean")out.nullable=schema.nullable;
  if(Array.isArray(schema.enum))out.enum=schema.enum.filter((item):item is string=>typeof item==="string");
  if(Array.isArray(schema.required))out.required=schema.required.filter((item):item is string=>typeof item==="string");
  if(schema.items&&typeof schema.items==="object"&&!Array.isArray(schema.items))out.items=geminiSchema(schema.items);
  if(schema.properties&&typeof schema.properties==="object"&&!Array.isArray(schema.properties)){
    out.properties=Object.fromEntries(Object.entries(schema.properties).map(([name,child])=>[name,geminiSchema(child)]));
  }
  return out;
}

function toolsOf(ts:AnthropicRequest["tools"]){
  if(!ts?.length)return undefined;
  const declarations=ts.filter(x=>x.name).map(x=>({
    name:x.name,description:x.description??"",parameters:geminiSchema(x.input_schema)
  }));
  return declarations.length?[{functionDeclarations:declarations}]:undefined;
}
function toolConfig(c:AnthropicRequest["tool_choice"]){
  if(c==="none")return {functionCallingConfig:{mode:"NONE"}};
  if(c==="auto"||!c)return {functionCallingConfig:{mode:"AUTO"},includeServerSideToolInvocations:true};
  return {functionCallingConfig:{mode:"ANY"}};
}

function contentsOf(ms:AnthropicRequest["messages"],thinking:boolean){
  const out:Array<{role:"user"|"model";parts:GeminiPart[]}>= [];
  const toolNames=new Map<string,string>();
  let signatureAnchor:string|undefined;

  for(const m of ms){
    const parts:GeminiPart[]=[];
    const blocks:AnthropicContentBlock[]=Array.isArray(m.content)?m.content:[{type:"text",text:m.content}];

    for(const b of blocks){
      if(b.type==="text"){
        if(b.text)parts.push({text:b.text});
      } else if(b.type==="image"&&b.source?.type==="base64"){
        parts.push({inlineData:{mimeType:b.source.media_type,data:b.source.data}});
      } else if(b.type==="thinking"){
        if(b.thinking)parts.push({text:b.thinking,thought:true});
        if(validSignature(b.signature)){
          signatureAnchor=b.signature;
          const last=parts[parts.length-1];
          if(last)last.thoughtSignature=b.signature;
        }
      } else if(b.type==="redacted_thinking"){
        if(b.data)parts.push({text:b.data,thought:true});
      } else if(b.type==="tool_use"){
        toolNames.set(b.id,b.name);
        // v4.7.x compatibility: preserve one real signature anchor; parallel
        // function calls after the anchor use the upstream sentinel.
        const sig=validSignature(b.signature)?b.signature:(signatureAnchor??(thinking?SENTINEL_SIGNATURE:undefined));
        if(validSignature(b.signature))signatureAnchor=b.signature;
        parts.push({functionCall:{name:b.name,args:b.input??{},id:b.id},...(sig?{thoughtSignature:sig}:{})});
      } else if(b.type==="tool_result"){
        const name=toolNames.get(b.tool_use_id)??b.tool_use_id;
        // v4.7.x: functionResponse must not carry thoughtSignature.
        parts.push({
          functionResponse:{
            name,
            id:b.tool_use_id,
            response:{
              result:textOf(b.content)||"Command executed successfully.",
              ...(b.is_error?{isError:true}:{})
            }
          }
        });
      }
    }
    if(parts.length)out.push({role:m.role==="assistant"?"model":"user",parts});
  }
  return out;
}

export function toAnthropicInternal(input:AnthropicRequest,project:string|undefined,ua:string):InternalGenerateRequest{
  const model=modelMap(input.model);
  const thinking=input.thinking?.type==="enabled"||model.includes("thinking")||model.includes("claude");
  const request:InternalGenerateRequest["request"]={
    contents:contentsOf(input.messages,thinking),
    generationConfig:{maxOutputTokens:input.max_tokens}
  };
  const system=systemOf(input.system);
  if(system)request.systemInstruction={parts:[{text:system}]};
  if(input.temperature!==undefined)request.generationConfig!.temperature=input.temperature;
  if(input.top_p!==undefined)request.generationConfig!.topP=input.top_p;
  if(input.top_k!==undefined)request.generationConfig!.topK=input.top_k;
  if(input.stop_sequences?.length)request.generationConfig!.stopSequences=input.stop_sequences;
  if(thinking){
    const budget=input.thinking?.type==="enabled"?input.thinking.budget_tokens:undefined;
    request.generationConfig!.thinkingConfig={
      includeThoughts:true,
      ...(budget?{thinkingBudget:budget}:{})
    };
  }
  const tools=toolsOf(input.tools);
  if(tools){
    request.tools=tools;
    request.toolConfig=toolConfig(input.tool_choice);
    request.tool_config=request.toolConfig;
  }
  return {
    project,
    requestId:"agent/"+Date.now()+"/"+crypto.randomUUID().replaceAll("-","").slice(0,8),
    userAgent:ua,
    model,
    request
  };
}

function partsOf(o:any):any[]{
  return o?.response?.candidates?.[0]?.content?.parts??o?.candidates?.[0]?.content?.parts??[];
}
function usageOf(o:any){
  const u=o?.response?.usageMetadata??o?.usageMetadata??{};
  return {
    input_tokens:u.total_input_tokens??u.promptTokenCount??u.totalInputTokens??0,
    output_tokens:u.total_output_tokens??u.candidatesTokenCount??u.totalOutputTokens??0,
    cache_read_input_tokens:u.total_cached_tokens??u.cachedContentTokenCount??u.cachedTokens??0,
    reasoning_tokens:u.total_thought_tokens??u.totalThoughtTokens??u.thoughtsTokenCount??0
  };
}
function finishOf(o:any):string|undefined{
  return o?.response?.candidates?.[0]?.finishReason??o?.candidates?.[0]?.finishReason;
}

export function anthropicResponse(o:any,requestedModel:string){
  const ps=partsOf(o);
  const content:any[] = ps.flatMap((p:any): any[]=>{
    if(p.thought)return [{type:"thinking",thinking:p.text??"",...(validSignature(p.thoughtSignature)?{signature:p.thoughtSignature}:{})}];
    if(p.text!==undefined)return [{type:"text",text:p.text}];
    if(p.functionCall)return [{type:"tool_use",id:p.functionCall.id??crypto.randomUUID(),name:p.functionCall.name,input:p.functionCall.args??{}}];
    return [];
  });
  const finish=finishOf(o);
  const stop_reason=finish==="MAX_TOKENS"?"max_tokens":content.some((x:any)=>x.type==="tool_use")||finish==="STOP"&&content.some((x:any)=>x.type==="tool_use")?"tool_use":"end_turn";
  return {
    id:"msg_"+crypto.randomUUID().replaceAll("-",""),type:"message",role:"assistant",
    model:requestedModel,content,stop_reason,stop_sequence:null,usage:usageOf(o)
  };
}

export function anthropicStream(
  body:ReadableStream<Uint8Array>,
  requestedModel:string,
  onSuccess?:()=>Promise<void>,
  onFailure?:()=>Promise<void>
){
  const dec=new TextDecoder(),enc=new TextEncoder();
  const id="msg_"+crypto.randomUUID().replaceAll("-","");
  let buf="",index=0,block:any=null,lastBlockType:string|undefined;
  let stopReason:string|undefined;
  let usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,reasoning_tokens:0};

  const emit=(e:string,d:any)=>enc.encode("event: "+e+"\ndata: "+JSON.stringify(d)+"\n\n");
  const normalizeUsage=(o:any)=>{
    const u=usageOf(o);
    usage={
      input_tokens:u.input_tokens||usage.input_tokens,
      output_tokens:u.output_tokens||usage.output_tokens,
      cache_read_input_tokens:u.cache_read_input_tokens||usage.cache_read_input_tokens,
      reasoning_tokens:u.reasoning_tokens||usage.reasoning_tokens
    };
  };

  return new ReadableStream<Uint8Array>({
    start(controller){
      const reader=body.getReader();
      (async()=>{
        try{
          controller.enqueue(emit("message_start",{
            type:"message_start",
            message:{id,type:"message",role:"assistant",content:[],model:requestedModel,stop_reason:null,stop_sequence:null,
              usage:{input_tokens:0,output_tokens:0}}
          }));

          const close=()=>{
            if(!block)return;
            controller.enqueue(emit("content_block_stop",{type:"content_block_stop",index}));
            lastBlockType=block.type;
            index++;
            block=null;
          };

          for(;;){
            const {done,value}=await reader.read();
            if(done)break;
            buf+=dec.decode(value,{stream:true});
            const lines=buf.split(/\r?\n/);buf=lines.pop()??"";
            for(const line of lines){
              let raw=line.trim();
              if(!raw||raw.startsWith(":"))continue;
              if(raw.startsWith("data:"))raw=raw.slice(5).trim();
              if(!raw||raw==="[DONE]")continue;
              let o:any;try{o=JSON.parse(raw)}catch{continue}
              normalizeUsage(o);
              const f=finishOf(o);if(f)stopReason=f;

              for(const p of partsOf(o)){
                if(p.functionCall){
                  close();
                  block={type:"tool_use",id:p.functionCall.id??crypto.randomUUID(),name:p.functionCall.name};
                  controller.enqueue(emit("content_block_start",{
                    type:"content_block_start",index,
                    content_block:{type:"tool_use",id:block.id,name:block.name,input:{}}
                  }));
                  controller.enqueue(emit("content_block_delta",{
                    type:"content_block_delta",index,
                    delta:{type:"input_json_delta",partial_json:JSON.stringify(p.functionCall.args??{})}
                  }));
                } else if(p.thought){
                  if(block?.type!=="thinking"){
                    close();block={type:"thinking"};
                    controller.enqueue(emit("content_block_start",{
                      type:"content_block_start",index,
                      content_block:{type:"thinking",thinking:""}
                    }));
                  }
                  if(p.text)controller.enqueue(emit("content_block_delta",{
                    type:"content_block_delta",index,delta:{type:"thinking_delta",thinking:p.text}
                  }));
                  if(validSignature(p.thoughtSignature))controller.enqueue(emit("content_block_delta",{
                    type:"content_block_delta",index,delta:{type:"signature_delta",signature:p.thoughtSignature}
                  }));
                } else if(typeof p.text==="string"){
                  if(block?.type!=="text"){
                    close();block={type:"text"};
                    controller.enqueue(emit("content_block_start",{
                      type:"content_block_start",index,
                      content_block:{type:"text",text:""}
                    }));
                  }
                  controller.enqueue(emit("content_block_delta",{
                    type:"content_block_delta",index,delta:{type:"text_delta",text:p.text}
                  }));
                }
              }
            }
          }

          close();
          const mappedStop=stopReason==="MAX_TOKENS"?"max_tokens":lastBlockType==="tool_use"?"tool_use":"end_turn";
          controller.enqueue(emit("message_delta",{
            type:"message_delta",
            delta:{stop_reason:mappedStop,stop_sequence:null},
            usage:{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}
          }));
          controller.enqueue(emit("message_stop",{type:"message_stop"}));
          controller.close();
          await onSuccess?.();
        }catch(e){
          await onFailure?.();
          controller.error(e);
        }finally{reader.releaseLock();}
      })();
    }
  });
}
