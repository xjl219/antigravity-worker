import type {Env} from "./types";

const CLIENT_ID="1071006060591-"+"tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET="GOCSPX-"+"K58FWR486LdLJ1mLB8sXC4z6qDAf";
const TOKEN_URL="https://oauth2.googleapis.com/token";
const USERINFO_URL="https://www.googleapis.com/oauth2/v2/userinfo";
const AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_OAUTH_CLIENT_KEY="antigravity_enterprise";

const SCOPES=[
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
];

export const ANTIGRAVITY_OAUTH_CLIENT_KEY=DEFAULT_OAUTH_CLIENT_KEY;

export function authorizationUrl(_env:Env,state:string,redirectUri:string){
  const u=new URL(AUTH_URL);
  u.searchParams.set("client_id",CLIENT_ID);
  u.searchParams.set("redirect_uri",redirectUri);
  u.searchParams.set("response_type","code");
  u.searchParams.set("scope",SCOPES.join(" "));
  u.searchParams.set("access_type","offline");
  u.searchParams.set("prompt","consent");
  u.searchParams.set("include_granted_scopes","true");
  u.searchParams.set("state",state);
  return u.toString();
}

async function post(params:URLSearchParams){
  const r=await fetch(TOKEN_URL,{
    method:"POST",
    headers:{
      "content-type":"application/x-www-form-urlencoded",
      "user-agent":"Antigravity Tools"
    },
    body:params
  });
  if(!r.ok)throw new Error(`Google OAuth ${r.status}: ${await r.text()}`);
  return r.json<any>();
}

export function exchangeCode(_env:Env,code:string,redirectUri:string){
  return post(new URLSearchParams({
    client_id:CLIENT_ID,
    client_secret:CLIENT_SECRET,
    code,
    redirect_uri:redirectUri,
    grant_type:"authorization_code"
  }));
}

export function refreshToken(_env:Env,refresh_token:string){
  return post(new URLSearchParams({
    client_id:CLIENT_ID,
    client_secret:CLIENT_SECRET,
    refresh_token,
    grant_type:"refresh_token"
  }));
}

export async function userInfo(accessToken:string){
  const r=await fetch(USERINFO_URL,{
    headers:{
      Authorization:`Bearer ${accessToken}`,
      "user-agent":"Antigravity Tools"
    }
  });
  if(!r.ok)throw new Error(`userinfo ${r.status}: ${await r.text()}`);
  return r.json<{id?:string;email?:string;name?:string}>();
}
