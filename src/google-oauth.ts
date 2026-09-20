import {pkceChallenge} from "./crypto";
import type {Env} from "./types";

const AUTH="https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN="https://oauth2.googleapis.com/token";
const SCOPES=[
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

export async function authorizationUrl(env:Env,state:string,verifier:string){
  const u=new URL(AUTH); u.searchParams.set("client_id",env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri",env.PUBLIC_BASE_URL+env.GOOGLE_OAUTH_REDIRECT_PATH);
  u.searchParams.set("response_type","code"); u.searchParams.set("scope",SCOPES.join(" "));
  u.searchParams.set("access_type","offline"); u.searchParams.set("prompt","consent");
  u.searchParams.set("state",state); u.searchParams.set("code_challenge",await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method","S256"); return u.toString();
}
async function post(env:Env,params:URLSearchParams){
  const r=await fetch(TOKEN,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:params});
  if(!r.ok) throw new Error(`Google OAuth ${r.status}: ${await r.text()}`);
  return r.json<any>();
}
export function exchangeCode(env:Env,code:string,verifier:string){
  return post(env,new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,
    grant_type:"authorization_code",redirect_uri:env.PUBLIC_BASE_URL+env.GOOGLE_OAUTH_REDIRECT_PATH,
    code_verifier:verifier
  }));
}
export function refreshToken(env:Env,refresh_token:string){
  return post(env,new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
    refresh_token,grant_type:"refresh_token"
  }));
}
export async function userInfo(accessToken:string){
  const r=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!r.ok) throw new Error(`userinfo ${r.status}: ${await r.text()}`);
  return r.json<{email?:string;sub?:string}>();
}