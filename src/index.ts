import {randomBase64Url,encryptString} from "./crypto";
import {authorizationUrl,exchangeCode,userInfo} from "./google-oauth";
import {CodeAssistClient,UpstreamError} from "./code-assist";
import {toInternal,streamToOpenAI,toOpenAI} from "./openai";
import {toAnthropicInternal,anthropicResponse,anthropicStream} from "./anthropic";
import type {Env,ChatRequest,AnthropicRequest} from "./types";
export {AccountPoolDO} from "./account-pool";

async function adminSession(env:Env){
  const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.ADMIN_API_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const s=new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode("ag-admin-v1")));
  return Array.from(s,b=>b.toString(16).padStart(2,"0")).join("");
}
async function admin(req:Request,env:Env){
  if(req.headers.get("authorization")===`Bearer ${env.ADMIN_API_KEY}`)return true;
  const m=(req.headers.get("cookie")||"").match(/(?:^|; )ag_admin=([^;]+)/);
  return !!m&&m[1]===await adminSession(env);
}
function html(v:unknown){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");}
function time(v:unknown){const n=Number(v);return Number.isFinite(n)&&n>0?new Date(n).toLocaleString("zh-CN",{hour12:false}):"—";}
async function adminPage(env:Env){
  const r=await poolGet(env,"/internal/accounts"), a=await r.json<any[]>();
  const active=a.filter(x=>x.status==="active").length, blocked=a.filter(x=>x.status==="blocked").length, cooldown=a.filter(x=>x.status==="cooldown").length;
  const rows=a.map(x=>`<tr><td><b>${html(x.email)}</b><small>${html(x.id)}</small></td><td><span class="s ${html(x.status)}">${html(x.status)}</span></td><td>${Number(x.health_score??0)}</td><td><code>${html(x.project_id||"未解析")}</code></td><td>${html(time(x.access_token_expires_at))}</td><td>${html(time(x.cooldown_until))}</td><td><a href="/admin/accounts/${encodeURIComponent(x.id)}/quota" target="_blank">Quota</a></td></tr>`).join("");
  const doc=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity Accounts</title>
<style>
body{margin:0;background:#0b1020;color:#e9eef8;font:14px system-ui,-apple-system,sans-serif}.wrap{max-width:1200px;margin:35px auto;padding:0 20px}h1{margin:0 0 4px;font-size:25px}.sub,small{display:block;color:#8996ad;font-size:12px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:24px}.btn,a{color:#8db7ff;text-decoration:none}.btn{background:#2563eb;color:#fff;border-radius:9px;padding:9px 14px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.card,.panel{background:#121a2b;border:1px solid #27334d;border-radius:13px}.card{padding:16px}.num{font-size:25px;font-weight:700;margin-top:5px}.green{color:#46d39a}.yellow{color:#f6c85f}.red{color:#ff6b7a}.panel{overflow:auto}table{width:100%;min-width:900px;border-collapse:collapse}th,td{padding:13px 15px;text-align:left;border-bottom:1px solid #27334d}th{color:#8996ad;font-size:12px;background:#10182a}.s{padding:3px 8px;border-radius:99px;background:#29344a}.s.active{color:#46d39a;background:#12352c}.s.blocked{color:#ff6b7a;background:#3b2028}.s.cooldown{color:#f6c85f;background:#3b321d}code{color:#a9c7ff}.empty{text-align:center;padding:40px;color:#8996ad}@media(max-width:700px){.top{align-items:flex-start;flex-direction:column}.cards{grid-template-columns:repeat(2,1fr)}}
</style><div class="wrap"><div class="top"><div><h1>Antigravity Accounts</h1><div class="sub">Google / Code Assist 账号池管理</div></div><div><a class="btn" href="/oauth/google/start">＋ 添加 Google 账号</a>　<a href="/admin/accounts">刷新</a></div></div>
<div class="cards"><div class="card"><div class="sub">账号总数</div><div class="num">${a.length}</div></div><div class="card"><div class="sub">正常</div><div class="num green">${active}</div></div><div class="card"><div class="sub">冷却中</div><div class="num yellow">${cooldown}</div></div><div class="card"><div class="sub">已阻断</div><div class="num red">${blocked}</div></div></div>
<div class="panel"><table><thead><tr><th>Google 账号</th><th>状态</th><th>健康度</th><th>Project</th><th>Token 到期</th><th>冷却结束</th><th>操作</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="empty">暂无账号</td></tr>'}</tbody></table></div>
<p class="sub">Token 不在页面展示，仅在 Worker / Durable Object 内加密保存。</p></div>`;
  return new Response(doc,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
}
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
      if(!adminKey&&await admin(req,env))adminKey=env.ADMIN_API_KEY;
      if(adminKey!==env.ADMIN_API_KEY)return new Response("unauthorized",{status:401});
      if(!code||!state)return new Response("callback_url/code and state are required",{status:400});
      return completeOAuth(req,env,code,state);
    }

    if(u.pathname==="/admin/accounts"){
      if(req.method==="GET"&&await await admin(req,env))return adminPage(env);
      if(req.method==="GET"){
        return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Antigravity Admin</title><style>body{margin:0;background:#0b1020;color:#e9eef8;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.box{background:#121a2b;border:1px solid #27334d;border-radius:14px;padding:28px;width:min(390px,calc(100% - 40px));box-sizing:border-box}input,button{width:100%;box-sizing:border-box;padding:11px;margin-top:10px;border-radius:8px}input{background:#0b1020;color:#fff;border:1px solid #34415e}button{background:#2563eb;color:#fff;border:0;font-weight:600}</style><form class="box" method="post"><h2>Antigravity Admin</h2><div>账号池管理控制台</div><input name="admin_key" type="password" placeholder="ADMIN_API_KEY" required><button>登录</button></form>`,{headers:{"content-type":"text/html; charset=utf-8"}});
      }
      if(req.method==="POST"){
        const f=await req.formData(), k=f.get("admin_key");
        if(typeof k==="string"&&k===env.ADMIN_API_KEY){
          return new Response(null,{status:303,headers:{"location":"/admin/accounts","set-cookie":`ag_admin=${await adminSession(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,"cache-control":"no-store"}});
        }
        return new Response("unauthorized",{status:401});
      }
    }
    if(req.method==="GET"&&u.pathname==="/v1/models"){
      if(!await await admin(req,env))return new Response(JSON.stringify({error:{message:"unauthorized",type:"invalid_request_error"}}),{status:401,headers:{"content-type":"application/json"}});
      // Match Antigravity Tools v4.7.11: dynamic quota models + built-in aliases/variants.
      // Dynamic models come from the official fetchAvailableModels endpoint for every
      // healthy account; built-ins mirror get_supported_models(), plus image combinations.
      const ids=new Set<string>();
      const accounts=await (await poolGet(env,"/internal/accounts")).json<any[]>();
      for(const a of accounts){
        if(a.status!=="ACTIVE")continue;
        try{
          const ar=await poolPost(env,"/internal/allocate",{preferred_account_id:a.id});
          if(!ar.ok)continue;
          const x=await ar.json<any>();
          const q=await new CodeAssistClient(env).fetchAvailableModels(x.access_token,x.project_id??undefined);
          const models=q?.models&&typeof q.models==="object"?Object.keys(q.models):[];
          for(const id of models){
            if(id.startsWith("gemini")||id.startsWith("claude")||id.startsWith("gpt")||id.startsWith("image")||id.startsWith("imagen"))ids.add(id);
          }
        }catch{}
      }
      for(const id of ["claude-sonnet-4-6","claude-sonnet-4-6-thinking","claude-sonnet-4-5","claude-sonnet-4-5-thinking","claude-sonnet-4-5-20250929","claude-3-5-sonnet-20241022","claude-3-5-sonnet-20240620","claude-opus-4","claude-opus-4-5-thinking","claude-opus-4-5-20251101","claude-opus-4-6-thinking","claude-opus-4-6","claude-opus-4.6-thinking","claude-opus-4.6","claude-opus-4-6-20260201","claude-haiku-4","claude-3-haiku-20240307","claude-haiku-4-5-20251001","gpt-4","gpt-4-turbo","gpt-4-turbo-preview","gpt-4-0125-preview","gpt-4-1106-preview","gpt-4-0613","gpt-4o","gpt-4o-2024-05-13","gpt-4o-2024-08-06","gpt-4o-mini","gpt-4o-mini-2024-07-18","gpt-3.5-turbo","gpt-3.5-turbo-16k","gpt-3.5-turbo-0125","gpt-3.5-turbo-1106","gpt-3.5-turbo-0613","gemini-2.5-flash-lite","gemini-2.5-flash-thinking","gemini-3.1-pro-low","gemini-3.1-pro-high","gemini-3.1-pro-preview","gemini-3.1-pro","gemini-3-pro-low","gemini-3-pro-high","gemini-3-pro-preview","gemini-3-pro","gemini-2.5-flash","gemini-3-flash","gemini-3.5-flash","gemini-3.6-flash","gemini-3.7-flash","gemini-3.7-flash-tiered","gemini-3.7-flash-low","gemini-3.7-flash-medium","gemini-3.7-flash-high","gemini-3-pro-image","internal-background-task"])ids.add(id);
      for(const res of ["","-2k","-4k"])for(const ratio of ["","-1x1","-4x3","-3x4","-16x9","-9x16","-21x9"])ids.add("gemini-3-pro-image"+res+ratio);
      ids.add("gemini-2.0-flash-exp");
      ids.add("gemini-2.5-flash");
      ids.add("gemini-3-flash");
      ids.add("gemini-3.1-pro-high");
      ids.add("gemini-3.1-pro-low");
      const data=[...ids].sort().map(id=>({id,object:"model",created:1706745600,owned_by:"antigravity"}));
      return Response.json({object:"list",data});
    }

    if(req.method==="POST"&&u.pathname==="/v1/messages"){
      if(!await admin(req,env))return new Response(JSON.stringify({type:"error",error:{type:"authentication_error",message:"unauthorized"}}),{status:401,headers:{"content-type":"application/json"}});
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
      if(!await admin(req,env))return new Response("unauthorized",{status:401});
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
      if(!await admin(req,env))return new Response("unauthorized",{status:401});
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