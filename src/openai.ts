import type {ChatRequest,InternalGenerateRequest} from "./types";

function text(c:ChatRequest["messages"][number]["content"]){
  return typeof c==="string"?c:c.filter(x=>!x.type||x.type==="text").map(x=>x.text??"").join("");
}

export function toInternal(input:ChatRequest,project:string,defaultModel:string):InternalGenerateRequest{
  const system=input.messages.filter(x=>x.role==="system").map(x=>text(x.content)).filter(Boolean).join("\n\n");
  const contents=input.messages.filter(x=>x.role!=="system").map(x=>({
    role:x.role==="assistant"?"model" as const:"user" as const,parts:[{text:text(x.content)}]
  }));
  const generationConfig:Record<string,unknown>={};
  if(input.temperature!==undefined)generationConfig.temperature=input.temperature;
  if(input.top_p!==undefined)generationConfig.topP=input.top_p;
  if(input.max_tokens!==undefined)generationConfig.maxOutputTokens=input.max_tokens;
  return {
    requestId:`agent/${Date.now()}/${crypto.randomUUID().replaceAll("-","").slice(0,8)}`,
    userAgent:"antigravity/windows/amd64",
    model:input.model??defaultModel,project,request:{
    contents,...(system?{systemInstruction:{parts:[{text:system}]}}:{}),
    ...(Object.keys(generationConfig).length?{generationConfig}:{})
  }};
}

function sse(x:unknown){return `data: ${JSON.stringify(x)}\n\n`;}

export function streamToOpenAI(
  body:ReadableStream<Uint8Array>,
  model:string,
  onSuccess?:()=>Promise<void>,
  onFailure?:()=>Promise<void>
){
  const dec=new TextDecoder(),enc=new TextEncoder();
  let buf="",role=false,chatId=`chatcmpl-${crypto.randomUUID()}`,created=Math.floor(Date.now()/1000);
  return new ReadableStream<Uint8Array>({
    start(controller){
      const reader=body.getReader();
      (async()=>{
        try{
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
              let o:any;
              try{o=JSON.parse(raw)}catch{continue}
              const a=o.response??o,parts=a?.candidates?.[0]?.content?.parts??[];
              const t=parts.filter((p:any)=>typeof p.text==="string").map((p:any)=>p.text).join("");
              if(!t)continue;
              const chunk={
                id:chatId,
                object:"chat.completion.chunk",
                created,
                model,
                choices:[{index:0,delta:role?{content:t}:{role:"assistant",content:t},finish_reason:null}]
              };
              role=true;controller.enqueue(enc.encode(sse(chunk)));
            }
          }
          controller.enqueue(enc.encode(sse({
            id:`chatcmpl-${crypto.randomUUID()}`,
            object:"chat.completion.chunk",
            created:Math.floor(Date.now()/1000),
            model,
            choices:[{index:0,delta:{},finish_reason:"stop"}]
          })));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
          await onSuccess?.();
        }catch(e){
          await onFailure?.();
          controller.error(e);
        }finally{
          reader.releaseLock();
        }
      })();
    }
  });
}

export async function toOpenAI(r:Response,model:string){
  const o:any=await r.json(),a=o.response??o,parts=a?.candidates?.[0]?.content?.parts??[];
  const content=parts.filter((p:any)=>typeof p.text==="string").map((p:any)=>p.text).join("");
  return Response.json({
    id:`chatcmpl-${crypto.randomUUID()}`,
    object:"chat.completion",
    created:Math.floor(Date.now()/1000),
    model,
    choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}]
  });
}