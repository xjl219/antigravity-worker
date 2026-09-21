import {randomBase64Url,encryptString} from "./crypto";
import {authorizationUrl,exchangeCode,userInfo} from "./google-oauth";
import {CodeAssistClient,UpstreamError} from "./code-assist";
import {toInternal,streamToOpenAI,toOpenAI} from "./openai";
import {toAnthropicInternal,anthropicResponse,anthropicStream} from "./anthropic";
import type {Env,ChatRequest,AnthropicRequest} from "./types";
export {AccountPoolDO} from "./account-pool";

function admin(req:Request,env:Env){return req.headers.get("authorization")===`Bearer ${env.ADMIN_API_KEY}`;}
function pool(env:Env){return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName("default"));}
async function poolPost(env:Env,path:string,body:unknown){
  return pool(env).fetch(`https://pool${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}
async function poolGet(env:Env,path:string){return pool(env).fetch(`https://pool${path}`);}

function retryable(status:number){return status===401||status===403||status===429||status>=500;}

export default {async fetch(req:Request,env:Env):Promise<Response>{
  const u=new URL(req.url);
  try{
    if(req.method==="GET"&&u.pathname==="/health")return Response.json({ok:true,service:"antigravity-worker",time:new Date().toISOString()});

    if(u.pathname==="/oauth/google/start"){
      if(!admin(req,env))return new Response("unauthorized",{status:401});
      const state=randomBase64Url(),verifier=randomBase64Url();
      await poolPost(env,"/internal/oauth/pending",{state,verifier});
      const redirectUri=new URL(env.GOOGLE_OAUTH_REDIRECT_PATH,req.url).toString();
      return Response.redirect(await authorizationUrl(env,state,verifier,redirectUri),302);
    }

    if(u.pathname==="/oauth/google/callback"){
      const code=u.searchParams.get("code"),state=u.searchParams.get("state");
      if(!code||!state)return new Response("missing code/state",{status:400});
      const pending=await poolPost(env,"/internal/oauth/consume",{state});
      const pv=await pending.json<any>();
      if(!pv?.verifier)return new Response("invalid or expired state",{status:400});
      const redirectUri=new URL(env.GOOGLE_OAUTH_REDIRECT_PATH,req.url).toString();
      const token=await exchangeCode(env,code,pv.verifier,redirectUri),info=await userInfo(token.access_token);
      const client=new CodeAssistClient(env),meta=await client.loadCodeAssist(token.access_token);
      const project=meta?.cloudaicompanionProject??meta?.projectId??meta?.project?.id??null;
      const id=info.sub??info.email??crypto.randomUUID();
      await poolPost(env,"/internal/account/upsert",{
        id,email:info.email??id,project_id:typeof project==="string"?project:null,
        access_token_enc:await encryptString(token.access_token,env.TOKEN_ENCRYPTION_KEY),
        refresh_token_enc:token.refresh_token?await encryptString(token.refresh_token,env.TOKEN_ENCRYPTION_KEY):null,
        expires_at:Date.now()+(token.expires_in??3600)*1000
      });
      return new Response("Google account connected. You can close this tab.");
    }

    if(u.pathname==="/admin/accounts"){
      if(!admin(req,env))return new Response("unauthorized",{status:401});
      return poolGet(env,"/internal/accounts");
    }

    if(req.method==="POST"&&u.pathname==="/v1/messages"){
      if(!admin(req,env))return new Response(JSON.stringify({type:"error",error:{type:"authentication_error",message:"unauthorized"}}),{status:401,headers:{"content-type":"application/json"}});
      const input=await req.json<AnthropicRequest>();
      if(!input.messages?.length||!input.max_tokens)return new Response(JSON.stringify({type:"error",error:{type:"invalid_request_error",message:"messages and max_tokens are required"}}),{status:400,headers:{"content-type":"application/json"}});
      let sessionId=req.headers.get("x-antigravity-session-id")||undefined; const failed:string[]=[]; let last:UpstreamError|undefined;
      for(let attempt=0;attempt<3;attempt++){
        const a=await poolPost(env,"/internal/allocate",{session_id:sessionId,exclude_account_ids:failed}); if(!a.ok)return a;
        const account=await a.json<any>(); sessionId=account.session_id as string;
         const currentSessionId=sessionId;
        const projectId=account.project_id as string;
         if(!projectId)return new Response("account has no Code Assist project",{status:503});
        try{
          const upstream=await new CodeAssistClient(env).generate(account.access_token,toAnthropicInternal(input,projectId,env.ANTIGRAVITY_USER_AGENT||"antigravity/2.0.3 linux/amd64"),!!input.stream);
          if(input.stream){
            const stream=anthropicStream(upstream.body!,input.model,async()=>{await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:sessionId});},async()=>{await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:sessionId,status:502});});
            return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache","x-antigravity-session-id":currentSessionId}});
          }
          await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:sessionId});
          const out=Response.json(anthropicResponse(await upstream.json(),input.model)); out.headers.set("x-antigravity-session-id",sessionId); return out;
        }catch(e){
          if(e instanceof UpstreamError){last=e;await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:sessionId,status:e.status});failed.push(account.account_id);if((e.status===401||e.status===403||e.status===429||e.status>=500)&&attempt<2)continue;return new Response(JSON.stringify({type:"error",error:{type:"api_error",message:e.body}}),{status:e.status,headers:{"content-type":"application/json"}});}
          throw e;
        }
      }
      return new Response(JSON.stringify({type:"error",error:{type:"api_error",message:last?.body??"upstream unavailable"}}),{status:last?.status??503,headers:{"content-type":"application/json"}});
    }

    if(req.method==="POST"&&u.pathname==="/v1/chat/completions"){
      if(!admin(req,env))return new Response("unauthorized",{status:401});
      const input=await req.json<ChatRequest>();
      if(!input.messages?.length)return new Response("messages is required",{status:400});

      const requestedSession=req.headers.get("x-antigravity-session-id")||undefined;
      const maxAttempts=3;
      const failedAccounts:string[]=[];
      let lastError:UpstreamError|undefined;
      let sessionId=requestedSession;

      for(let attempt=0;attempt<maxAttempts;attempt++){
        const a=await poolPost(env,"/internal/allocate",{
          session_id:sessionId,
          exclude_account_ids:failedAccounts
        });
        if(!a.ok){
          if(lastError)return new Response(lastError.body,{status:lastError.status,headers:{"content-type":"application/json"}});
          return a;
        }

        const account=await a.json<any>();
        const currentSessionId = account.session_id as string;
        sessionId=currentSessionId;
        if(!account.project_id)return new Response("account has no Code Assist project",{status:503});

        const internal=toInternal(input,account.project_id,env.DEFAULT_MODEL);
        const client=new CodeAssistClient(env);

        try{
          const upstream=await client.generate(account.access_token,internal,!!input.stream);

          if(input.stream){
            const stream=streamToOpenAI(
              upstream.body!,
              internal.model,
              async()=>{await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:sessionId});},
              async()=>{await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:sessionId,status:502});}
            );
            return new Response(stream,{
              headers:{
                "content-type":"text/event-stream; charset=utf-8",
                "cache-control":"no-cache",
                "connection":"keep-alive",
                "x-antigravity-session-id":currentSessionId
              }
            });
          }

          await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:sessionId});
          const response=await toOpenAI(upstream,internal.model);
          response.headers.set("x-antigravity-session-id",currentSessionId);
          return response;
        }catch(e){
          if(e instanceof UpstreamError){
            lastError=e;
            await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:sessionId,status:e.status});
            failedAccounts.push(account.account_id);
            if(retryable(e.status)&&attempt<maxAttempts-1)continue;
            return new Response(e.body,{status:e.status,headers:{"content-type":"application/json"}});
          }
          await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:sessionId,status:502});
          throw e;
        }
      }

      if(lastError)return new Response(lastError.body,{status:lastError.status,headers:{"content-type":"application/json"}});
      return new Response("upstream unavailable",{status:503});
    }

    if(u.pathname.startsWith("/admin/accounts/")&&u.pathname.endsWith("/quota")){
      if(!admin(req,env))return new Response("unauthorized",{status:401});
      const id=u.pathname.split("/")[3];
      const a=await poolPost(env,"/internal/allocate",{preferred_account_id:id});
      if(!a.ok)return a;
      const x=await a.json<any>();
      const q=await new CodeAssistClient(env).retrieveUserQuota(x.access_token,x.project_id??undefined);
      return Response.json(q);
    }

    return new Response("not found",{status:404});
  }catch(e){return new Response(e instanceof Error?e.message:"internal error",{status:500});}
}};