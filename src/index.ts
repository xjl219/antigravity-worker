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

function parseOAuthCallback(value:string):{code?:string;state?:string}{
  try{
    const u=new URL(value);
    return {code:u.searchParams.get("code")??undefined,state:u.searchParams.get("state")??undefined};
  }catch{
    return {code:value.trim()||undefined,state:undefined};
  }
}

async function completeOAuth(_req:Request,env:Env,code:string,state:string):Promise<Response>{
  const pending=await poolPost(env,"/internal/oauth/consume",{state});
  const pv=await pending.json<any>();
  if(!pv?.verifier)return new Response("invalid or expired OAuth state",{status:400});
  let payload:{redirectUri:string;clientKey?:string};
  try{payload=JSON.parse(pv.verifier)}catch{return new Response("invalid OAuth state payload",{status:400});}
  const token=await exchangeCode(env,code,payload.redirectUri);
  if(!token.refresh_token)return new Response("Google did not return a refresh_token; revoke the existing Antigravity Tools authorization and retry.",{status:400});
  const info=await userInfo(token.access_token);
  if(!info.email)return new Response("Google userinfo did not contain email",{status:502});
  const client=new CodeAssistClient(env);
  const meta=await client.loadCodeAssist(token.access_token);
  const project=meta?.cloudaicompanionProject??meta?.projectId??meta?.project?.id??null;
  const id=info.id??info.email;
  await poolPost(env,"/internal/account/upsert",{
    id,email:info.email,project_id:typeof project==="string"?project:null,
    access_token_enc:await encryptString(token.access_token,env.TOKEN_ENCRYPTION_KEY),
    refresh_token_enc:await encryptString(token.refresh_token,env.TOKEN_ENCRYPTION_KEY),
    expires_at:Date.now()+(token.expires_in??3600)*1000
  });
  return new Response(`Google account connected: ${info.email}. Code Assist project: ${typeof project==="string"?project:"not resolved"}`,{headers:{"content-type":"text/plain; charset=utf-8"}});
}

export default {async fetch(req:Request,env:Env):Promise<Response>{
  const u=new URL(req.url);
  try{
    if(req.method==="GET"&&u.pathname==="/health")return Response.json({ok:true,service:"antigravity-worker",time:new Date().toISOString()});

    if(u.pathname==="/oauth/google/start"){
      // Match Antigravity Tools v4.7.11 Web/Docker behavior:
      // use the built-in OAuth client and a loopback redirect, then manually submit
      // the callback URL when no local listener exists on the user's machine.
      const state=randomBase64Url(24);
      const port=49152+(crypto.getRandomValues(new Uint16Array(1))[0]%12000);
      const redirectUri=`http://localhost:${port}/oauth-callback`;
      const pendingPayload=JSON.stringify({redirectUri,clientKey:"antigravity_enterprise"});
      await poolPost(env,"/internal/oauth/pending",{state,verifier:pendingPayload});
      const authUrl=authorizationUrl(env,state,redirectUri);
      const esc=(v:string)=>v.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
      const html=`<!doctype html><html><head><meta charset="utf-8"><title>Antigravity OAuth</title></head>
      <body style="font-family:system-ui;max-width:900px;margin:40px auto;padding:0 20px">
      <h2>Antigravity Google OAuth</h2>
      <p>1. Open the authorization link below and finish Google authorization.</p>
      <p><a href="${esc(authUrl)}" target="_blank" rel="noopener">Open Google Authorization</a></p>
      <p>2. After authorization, the browser may show <b>localhost refused connection</b>. This is expected for a remote Worker.</p>
      <p>3. Copy the complete URL from that browser address bar and paste it below.</p>
      <form method="post" action="/oauth/google/complete" style="display:grid;gap:10px">
        <label>Callback URL or code</label>
        <textarea name="callback_url" rows="4" style="width:100%" placeholder="http://localhost:.../oauth-callback?code=...&amp;state=..."></textarea>
        <label>Worker ADMIN_API_KEY</label>
        <input name="admin_key" type="password" autocomplete="off" style="width:100%"/>
        <button type="submit">Complete OAuth</button>
      </form>
      <p style="color:#666">OAuth state: <code>${esc(state)}</code></p>
      </body></html>`;
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8"}});
    }

    if(u.pathname==="/oauth/google/callback"){
      const code=u.searchParams.get("code"),state=u.searchParams.get("state");
      if(!code||!state)return new Response("missing code/state",{status:400});
      return completeOAuth(req,env,code,state);
    }

    if(req.method==="POST"&&u.pathname==="/oauth/google/complete"){
      let code:string|undefined,state:string|undefined,adminKey:string|undefined;
      const contentType=req.headers.get("content-type")||"";
      if(contentType.includes("application/json")){
        const x=await req.json<any>();
        code=typeof x.code==="string"?x.code:undefined;
        state=typeof x.state==="string"?x.state:undefined;
        adminKey=typeof x.admin_key==="string"?x.admin_key:undefined;
        if(!code&&typeof x.callback_url==="string")({code,state}=parseOAuthCallback(x.callback_url));
      }else{
        const form=await req.formData();
        const callback=form.get("callback_url");
        const st=form.get("state");
        if(typeof callback==="string")({code,state}=parseOAuthCallback(callback));
        if(typeof st==="string"&&st)state=st;
        const k=form.get("admin_key"); adminKey=typeof k==="string"?k:undefined;
      }
      if(!adminKey&&admin(req,env))adminKey=env.ADMIN_API_KEY;
      if(adminKey!==env.ADMIN_API_KEY)return new Response("unauthorized",{status:401});
      if(!code||!state)return new Response("callback_url/code and state are required",{status:400});
      return completeOAuth(req,env,code,state);
    }

    if(u.pathname==="/admin/accounts"){
      if(!(await admin(req,env))){
        if(req.method==="GET"){
          const html="<!doctype html><html><head><meta charset=\"utf-8\"><title>Antigravity Admin</title></head><body style=\"font-family:system-ui;max-width:700px;margin:60px auto;padding:20px\"><h2>Antigravity Admin</h2><p>请输入 ADMIN_API_KEY 查看账号登录状态。</p><form method=\"post\"><input name=\"admin_key\" type=\"password\" placeholder=\"ADMIN_API_KEY\" required style=\"width:70%;padding:10px\"><button style=\"padding:10px 18px\">登录</button></form></body></html>";
          return new Response(html,{headers:{"content-type":"text/html; charset=utf-8"}});
        }
        if(req.method==="POST"){
          const f=await req.formData(); const k=f.get("admin_key");
          if(typeof k==="string"&&k===env.ADMIN_API_KEY){
            const r=await poolGet(env,"/internal/accounts");
            return new Response(await r.text(),{headers:{"content-type":"application/json; charset=utf-8"}});
          }
        }
        return new Response("unauthorized",{status:401});
      }
      return poolGet(env,"/internal/accounts");
    }
    if(req.method==="GET"&&u.pathname==="/v1/models"){
      if(!admin(req,env))return new Response(JSON.stringify({error:{message:"unauthorized",type:"invalid_request_error"}}),{status:401,headers:{"content-type":"application/json"}});
      const now=Math.floor(Date.now()/1000);
      // /v1/models is a discovery surface. Generation already passes an explicit
      // Gemini model through to Code Assist, so do not collapse the inventory to
      // DEFAULT_MODEL. Keep this list aligned with Antigravity's supported Gemini
      // families; upstream remains the source of truth for account-specific access.
      const ids=[
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3-flash",
        "gemini-3.1-pro-preview",
        "gemini-3.1-pro-low",
        "gemini-3.1-pro-high",
        "gemini-3.5-flash",
        "gemini-3.6-flash-tiered",
        "gemini-3.7-flash-tiered",
        "gemini-3.7-flash-low",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-high",
        "gemini-3.8-flash-tiered"
      ];
      return Response.json({
        object:"list",
        data:ids.map(id=>({id,object:"model",created:now,owned_by:"google"}))
      });
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
            const stream=anthropicStream(upstream.body!,input.model,async()=>{await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:currentSessionId});},async()=>{await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:currentSessionId,status:502});});
            return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache","x-antigravity-session-id":currentSessionId}});
          }
          await poolPost(env,"/internal/success",{account_id:account.account_id,session_id:sessionId});
          const out=Response.json(anthropicResponse(await upstream.json(),input.model)); out.headers.set("x-antigravity-session-id",sessionId); return out;
        }catch(e){
          if(e instanceof UpstreamError){last=e;await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:currentSessionId,status:e.status});failed.push(account.account_id);if((e.status===401||e.status===403||e.status===429||e.status>=500)&&attempt<2)continue;return new Response(JSON.stringify({type:"error",error:{type:"api_error",message:e.body}}),{status:e.status,headers:{"content-type":"application/json"}});}
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
            await poolPost(env,"/internal/failure",{account_id:account.account_id,session_id:currentSessionId,status:e.status});
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