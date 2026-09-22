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
  const normStatus=(v:unknown)=>String(v??"").toUpperCase();
  const active=a.filter(x=>normStatus(x.status)==="ACTIVE").length, blocked=a.filter(x=>normStatus(x.status)==="BLOCKED").length, cooldown=a.filter(x=>normStatus(x.status)==="COOLDOWN").length;
  const rows=a.map(x=>{
    const email=String(x.email||x.id), id=String(x.id);
    return \`<tr><td><div class="account"><div class="avatar">\${html(email.slice(0,1).toUpperCase())}</div><div><b>\${html(email)}</b><small>\${html(id)}</small></div></div></td><td><span class="s \${html(normStatus(x.status).toLowerCase())}">\${html(normStatus(x.status))}</span></td><td><div class="health"><span>\${Number(x.health_score??0)}</span><div><i style="width:\${Math.max(0,Math.min(100,Number(x.health_score??0)))}%"></i></div></div></td><td><code>\${html(x.project_id||"未解析")}</code></td><td>\${html(time(x.access_token_expires_at))}</td><td>\${html(time(x.cooldown_until))}</td><td><div class="actions"><a class="actionBtn quotaBtn" href="/admin/accounts/\${encodeURIComponent(id)}/quota">额度</a><form method="post" action="/admin/accounts/\${encodeURIComponent(id)}/delete" onsubmit="return confirm('确定删除账号 '+\${JSON.stringify(email)}+'？\\n\\n将删除加密 token、会话和账号记录，无法撤销。')"><button class="actionBtn deleteBtn" type="submit">删除账号</button></form></div></td></tr>\`;
  }).join("");
  const doc=String.raw\`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity · Accounts</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#080d17;color:#edf3ff;font:14px/1.5 system-ui,-apple-system,sans-serif}.shell{width:min(1280px,calc(100% - 32px));margin:34px auto}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:24px}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#4f7cff,#8b5cf6);display:grid;place-items:center;font-weight:800;font-size:19px}.brand h1{margin:0;font-size:22px}.sub{color:#8797b0;font-size:12px}.btn{display:inline-flex;align-items:center;border-radius:10px;padding:10px 14px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;border:1px solid #3b82f6}.btn.secondary{margin-left:8px;background:#111b2c;border-color:#2b3b56}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:16px}.card{background:#101827;border:1px solid #22314a;border-radius:15px;padding:17px}.label{color:#8797b0;font-size:12px}.num{font-size:27px;font-weight:750;margin-top:4px}.green{color:#55ddb0}.yellow{color:#f6ca61}.red{color:#ff7482}.panel{background:#101827;border:1px solid #22314a;border-radius:17px;overflow:hidden}.table-head{padding:16px 18px;border-bottom:1px solid #22314a;display:flex;justify-content:space-between}.table-head b{font-size:15px}table{width:100%;border-collapse:collapse;min-width:1020px}th,td{padding:14px 16px;text-align:left;border-bottom:1px solid #1e2b40}th{background:#0d1523;color:#8191aa;font-size:11px;text-transform:uppercase}tr:last-child td{border-bottom:0}.account{display:flex;align-items:center;gap:11px}.avatar{width:34px;height:34px;border-radius:10px;background:#1d2d4b;display:grid;place-items:center;color:#9fc0ff;font-weight:800}.account small{display:block;color:#73839c;font-size:10px;margin-top:2px}.s{display:inline-block;padding:4px 9px;border-radius:99px;background:#273348;font-size:11px}.s.active{color:#55ddb0;background:#10372e}.s.blocked{color:#ff7482;background:#3d2029}.s.cooldown{color:#f6ca61;background:#3c321e}.health{display:flex;align-items:center;gap:8px}.health>span{width:24px}.health>div{width:55px;height:5px;border-radius:99px;background:#243249;overflow:hidden}.health i{display:block;height:100%;background:#55ddb0;border-radius:99px}.link{color:#9fc0ff;text-decoration:none}.actions{display:flex;align-items:center;gap:8px;white-space:nowrap}.actions form{margin:0}.actionBtn{display:inline-flex;align-items:center;justify-content:center;min-width:58px;padding:6px 10px;border-radius:8px;font:inherit;font-size:12px;text-decoration:none;cursor:pointer}.quotaBtn{color:#b8d0ff;background:#172642;border:1px solid #2d4770}.deleteBtn{color:#ff9ca6;background:#321b23;border:1px solid #69303d}.deleteBtn:hover{background:#48202b;border-color:#9b3d50}code{color:#a9c7ff;font-size:11px}.empty{text-align:center;padding:55px!important;color:#7f8da4}.foot{padding:13px 18px;color:#718098;font-size:11px;border-top:1px solid #1e2b40}@media(max-width:760px){.shell{margin:20px auto}.top{align-items:flex-start;flex-direction:column}.cards{grid-template-columns:repeat(2,1fr)}.panel{overflow:auto}}</style></head>
<body><main class="shell"><div class="top"><div class="brand"><div class="logo">A</div><div><h1>Antigravity Accounts</h1><div class="sub">Google / Code Assist 账号池 · 管理控制台</div></div></div><div><a class="btn" href="/oauth/google/start">＋ 添加 Google 账号</a><a class="btn secondary" href="/admin/accounts">刷新</a></div></div>
<div class="cards"><div class="card"><div class="label">账号总数</div><div class="num">%%TOTAL%%</div></div><div class="card"><div class="label">正常</div><div class="num green">%%ACTIVE%%</div></div><div class="card"><div class="label">冷却中</div><div class="num yellow">%%COOLDOWN%%</div></div><div class="card"><div class="label">已阻断</div><div class="num red">%%BLOCKED%%</div></div></div>
<section class="panel"><div class="table-head"><b>账号池</b><span class="sub">Token 仅在 Worker / Durable Object 内加密保存</span></div><table><thead><tr><th>Google 账号</th><th>状态</th><th>健康度</th><th>Project</th><th>Token 到期</th><th>冷却结束</th><th>操作</th></tr></thead><tbody>%%ROWS%%</tbody></table><div class="foot">删除账号会同时删除加密 access/refresh token、会话与账号记录；删除后不可恢复，需要重新授权。</div></section></main></body></html>\`;
  const page=doc.replaceAll("%%TOTAL%%",String(a.length)).replaceAll("%%ACTIVE%%",String(active)).replaceAll("%%COOLDOWN%%",String(cooldown)).replaceAll("%%BLOCKED%%",String(blocked)).replace("%%ROWS%%",rows||'<tr><td colspan="7" class="empty">暂无账号，点击右上角添加 Google 账号</td></tr>');
  return new Response(page,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
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
      const state=randomBase64Url(24);
      const port=49152+(crypto.getRandomValues(new Uint16Array(1))[0]%12000);
      const redirectUri=\`http://localhost:\${port}/oauth-callback\`;
      await poolPost(env,"/internal/oauth/pending",{state,verifier:JSON.stringify({redirectUri,clientKey:"antigravity_enterprise"})});
      const authUrl=authorizationUrl(env,state,redirectUri);
      const esc=(v:string)=>v.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
      const loggedIn=await admin(req,env);
      const doc=String.raw\`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>添加 Google 账号 · Antigravity</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0%,#19315f,#080d17 48%);color:#eef4ff;font:14px/1.6 system-ui,-apple-system,sans-serif}.shell{width:min(860px,calc(100% - 32px));margin:45px auto}.brand{display:flex;gap:12px;align-items:center;margin-bottom:22px}.logo{width:43px;height:43px;border-radius:13px;background:linear-gradient(135deg,#4f7cff,#8b5cf6);display:grid;place-items:center;font-weight:800;font-size:19px}.brand h1{margin:0;font-size:20px}.muted{color:#91a0b7}.card{background:#101827ee;border:1px solid #263653;border-radius:20px;box-shadow:0 25px 70px #0008;overflow:hidden}.head{padding:25px 28px;border-bottom:1px solid #263653}.head h2{margin:0 0 4px;font-size:24px}.body{padding:28px}.steps{display:grid;gap:11px;margin-bottom:23px}.step{display:flex;gap:13px;padding:15px;border:1px solid #263653;background:#0c1422;border-radius:14px}.num{width:28px;height:28px;border-radius:50%;background:#2563eb;display:grid;place-items:center;font-weight:800;flex:0 0 auto}.step b{display:block}.action{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:11px;border:1px solid #3b82f6;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;cursor:pointer}.btn.secondary{background:#172238;border-color:#33445f}.field{margin-top:18px}.field label{display:block;font-weight:650;margin-bottom:7px}.field textarea,.field input{width:100%;background:#080e19;color:#edf4ff;border:1px solid #33445f;border-radius:11px;padding:12px;outline:none}.field textarea{min-height:110px;resize:vertical;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.hint{font-size:12px;color:#8191aa;margin-top:7px}.warn{margin-top:18px;padding:12px 14px;border:1px solid #6b5524;background:#302612;color:#f4d98a;border-radius:11px}.adminkey{display:%%ADMIN_DISPLAY%%}.footer{padding:15px 28px;border-top:1px solid #263653;background:#0c1422;display:flex;justify-content:space-between;gap:12px;font-size:12px}@media(max-width:600px){.shell{margin:22px auto}.body,.head{padding:20px}}</style></head>
<body><main class="shell"><div class="brand"><div class="logo">A</div><div><h1>Antigravity Worker</h1><div class="muted">Google / Code Assist 账号接入</div></div></div>
<section class="card"><div class="head"><h2>添加 Google 账号</h2><div class="muted">沿用 Antigravity Tools 的真实 OAuth 协议；Worker 只负责安全保存授权结果。</div></div><div class="body">
<div class="steps"><div class="step"><span class="num">1</span><div><b>打开 Google 授权</b><span class="muted">使用需要接入的 Google 账号完成授权。</span></div></div>
<div class="step"><span class="num">2</span><div><b>复制授权后的完整地址</b><span class="muted">当前协议使用 localhost loopback redirect。远程 Worker 没有你的本机监听端口，所以看到 localhost 无法连接是预期现象。</span></div></div>
<div class="step"><span class="num">3</span><div><b>粘贴回调地址并完成绑定</b><span class="muted">Worker 从 callback URL 中读取 code/state，并在服务端完成 token exchange。</span></div></div></div>
<div class="action"><a class="btn" href="%%AUTH_URL%%" target="_blank" rel="noopener">继续 Google 授权 ↗</a><a class="btn secondary" href="/admin/accounts">返回账号池</a></div>
<form method="post" action="/oauth/google/complete"><div class="field"><label>Google 授权后的完整地址</label><textarea name="callback_url" placeholder="http://localhost:%%PORT%%/oauth-callback?code=...&state=..."></textarea><div class="hint">请从浏览器地址栏完整复制，不要只复制 code。</div></div>
<div class="field adminkey"><label>管理员密钥</label><input name="admin_key" type="password" autocomplete="off" placeholder="当前浏览器没有管理会话时填写"></div>
<div class="action" style="margin-top:16px"><button class="btn" type="submit">完成账号绑定</button></div></form>
<div class="warn">安全提示：不要粘贴 Google access token / refresh token。本页面只需要 OAuth 回调地址。</div></div>
<div class="footer"><span class="muted">OAuth state：<code>%%STATE%%</code></span><span class="muted">有效期约 10 分钟</span></div></section></main></body></html>\`;
      const page=doc.replaceAll("%%AUTH_URL%%",esc(authUrl)).replaceAll("%%PORT%%",String(port)).replaceAll("%%STATE%%",esc(state)).replaceAll("%%ADMIN_DISPLAY%%",loggedIn?"none":"block");
      return new Response(page,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
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

    if(u.pathname.startsWith("/admin/accounts/")&&u.pathname.endsWith("/delete")&&req.method==="POST"){
      if(!await admin(req,env))return new Response("unauthorized",{status:401});
      const id=decodeURIComponent(u.pathname.split("/")[3]||"");
      if(!id)return new Response("account id is required",{status:400});
      const r=await pool(env).fetch(`https://pool/internal/account/${encodeURIComponent(id)}`,{method:"DELETE"});
      if(!r.ok)return new Response(await r.text(),{status:r.status});
      return new Response(null,{status:303,headers:{"location":"/admin/accounts","cache-control":"no-store"}});
    }

    if(u.pathname==="/admin/accounts"){
      if(req.method==="GET"&&await admin(req,env))return adminPage(env);
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
      if(!await admin(req,env))return new Response(JSON.stringify({error:{message:"unauthorized",type:"invalid_request_error"}}),{status:401,headers:{"content-type":"application/json"}});
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
      const id=decodeURIComponent(u.pathname.split("/")[3]||"");
      const accounts=await (await poolGet(env,"/internal/accounts")).json<any[]>();
      const account=accounts.find(x=>x.id===id);
      if(!account)return new Response("account not found",{status:404});
      if(u.searchParams.get("format")==="json"){
        const a=await poolPost(env,"/internal/allocate",{preferred_account_id:id});
        if(!a.ok)return a;
        const x=await a.json<any>();
        const q=await new CodeAssistClient(env).retrieveUserQuota(x.access_token,x.project_id??undefined);
        return Response.json(q,{headers:{"cache-control":"no-store"}});
      }
      const doc=String.raw\`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>额度 · %%EMAIL%%</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#080d17;color:#edf3ff;font:14px/1.5 system-ui,-apple-system,sans-serif}.shell{width:min(1180px,calc(100% - 32px));margin:32px auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:20px}.brand{display:flex;gap:12px;align-items:center}.logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#4f7cff,#8b5cf6);display:grid;place-items:center;font-weight:800}.h1{font-size:22px;font-weight:750}.muted{color:#8797b0;font-size:12px}.actions{display:flex;gap:8px}.btn{display:inline-flex;border:1px solid #2b3b56;background:#111b2c;color:#b8cbef;border-radius:10px;padding:9px 13px;text-decoration:none;font-weight:650;cursor:pointer}.btn.primary{background:#2563eb;border-color:#3b82f6;color:#fff}.hero{background:#101827;border:1px solid #22314a;border-radius:17px;padding:19px;margin-bottom:16px}.meta{display:flex;gap:28px;flex-wrap:wrap}.meta b{display:block;margin-top:3px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:16px}.card{background:#101827;border:1px solid #22314a;border-radius:15px;padding:17px}.label{color:#8797b0;font-size:12px}.value{font-size:21px;font-weight:750;margin-top:5px}.panel{background:#101827;border:1px solid #22314a;border-radius:17px;overflow:hidden}.panel-head{padding:16px 18px;border-bottom:1px solid #22314a;display:flex;justify-content:space-between}.quota-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:16px}.bucket{background:#0c1422;border:1px solid #22314a;border-radius:13px;padding:15px}.bucket h3{font-size:13px;margin:0 0 12px;word-break:break-word}.bar{height:7px;background:#243249;border-radius:99px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:#4f8cff;border-radius:99px}.row{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#95a4bb}.loading,.error{padding:35px;text-align:center;color:#8797b0}.error{color:#ff8b96}.raw{margin:0 16px 16px;border-top:1px solid #22314a;padding-top:14px}.raw summary{cursor:pointer;color:#9db7e8}.raw pre{white-space:pre-wrap;word-break:break-word;color:#aebbd0;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:#080e19;padding:14px;border-radius:10px;max-height:520px;overflow:auto}@media(max-width:760px){.shell{margin:20px auto}.top{flex-direction:column}.grid,.quota-grid{grid-template-columns:1fr}}</style></head>
<body><main class="shell"><div class="top"><div class="brand"><div class="logo">A</div><div><div class="h1">账号额度</div><div class="muted">%%EMAIL%%</div></div></div><div class="actions"><a class="btn" href="/admin/accounts">← 账号池</a><button class="btn primary" id="refresh">刷新额度</button></div></div>
<section class="hero"><div class="meta"><div><span class="muted">Google 账号</span><b>%%EMAIL%%</b></div><div><span class="muted">Project</span><b>%%PROJECT%%</b></div><div><span class="muted">账号状态</span><b>%%STATUS%%</b></div><div><span class="muted">健康度</span><b>%%HEALTH%% / 100</b></div></div></section>
<section class="grid"><div class="card"><div class="label">额度来源</div><div class="value">Google Code Assist</div></div><div class="card"><div class="label">查询接口</div><div class="value">retrieveUserQuotaSummary</div></div><div class="card"><div class="label">协议基线</div><div class="value">Antigravity 4.7.11</div></div></section>
<section class="panel"><div class="panel-head"><b>模型额度</b><span id="updated" class="muted">加载中…</span></div><div id="quota" class="quota-grid"><div class="loading">正在读取 Google 额度…</div></div><div class="raw"><details><summary>查看原始 quota JSON（调试）</summary><pre id="raw"></pre></details></div></section></main>
<script>
const quotaEl=document.getElementById("quota"),raw=document.getElementById("raw"),updated=document.getElementById("updated");
const esc=v=>String(v??"").replace(/[&<>"']/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\" : "&quot;","'":"&#39;"}[s]||s));
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
function render(q){raw.textContent=JSON.stringify(q,null,2);const models=q&&q.models&&typeof q.models==="object"?q.models:{};const es=Object.entries(models);if(!es.length){quotaEl.innerHTML='<div class="loading" style="grid-column:1/-1">当前返回未包含可识别的 models 额度结构，请展开下方原始 JSON 查看。</div>';return}quotaEl.innerHTML=es.map(([id,m])=>{const o=m&&typeof m==="object"?m:{};const rem=n(o.remainingQuota??o.remaining??o.remainingRequests??o.remainingTokens),lim=n(o.quotaLimit??o.limit??o.maxQuota??o.totalQuota),pct=rem!==null&&lim&&lim>0?Math.max(0,Math.min(100,rem/lim*100)):null;return '<div class="bucket"><h3>'+esc(id)+'</h3><div class="row"><span>剩余</span><b>'+(rem??"—")+'</b></div>'+(pct!==null?'<div class="bar"><i style="width:'+pct+'%"></i></div><div class="row"><span>使用率</span><span>'+((100-pct).toFixed(1))+'%</span></div>':'')+'<div class="row" style="margin-top:8px"><span>重置</span><span>'+esc(o.resetTime??o.resetAt??"—")+'</span></div></div>'}).join("")}
async function load(){quotaEl.innerHTML='<div class="loading" style="grid-column:1/-1">正在读取 Google 额度…</div>';updated.textContent="刷新中…";try{const r=await fetch(location.pathname+"?format=json",{cache:"no-store"});if(!r.ok)throw new Error(await r.text());const q=await r.json();render(q);updated.textContent="更新于 "+new Date().toLocaleTimeString("zh-CN",{hour12:false})}catch(e){quotaEl.innerHTML='<div class="error" style="grid-column:1/-1">额度读取失败：'+esc(e.message||e)+'</div>';updated.textContent="读取失败"}}
document.getElementById("refresh").onclick=load;load();
</script></body></html>\`;
      const page=doc.replaceAll("%%EMAIL%%",html(account.email||id)).replaceAll("%%PROJECT%%",html(account.project_id||"未解析")).replaceAll("%%STATUS%%",html(account.status)).replaceAll("%%HEALTH%%",String(Number(account.health_score??0)));
      return new Response(page,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }

    return new Response("not found",{status:404});
  }catch(e){return new Response(e instanceof Error?e.message:"internal error",{status:500});}
}};