import type {Env,InternalGenerateRequest} from "./types";

const DEFAULT_INTERNAL_BASES=[
  "https://cloudcode-pa.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.googleapis.com/v1internal"
];
const QUOTA_ENDPOINTS=[
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
];

function userAgent(env:Env){return env.ANTIGRAVITY_USER_AGENT||"antigravity/2.0.3 linux/amd64";}

export class CodeAssistClient{
  constructor(private env:Env){}
  private bases(){
    const configured=this.env.GOOGLE_CODE_ASSIST_BASE_URL?.trim();
    if(!configured)return DEFAULT_INTERNAL_BASES;
    const normalized=configured.replace(/\/+$/,"");
    return [...new Set([normalized.endsWith("/v1internal")?normalized:normalized+"/v1internal",...DEFAULT_INTERNAL_BASES])];
  }
  private async request(path:string,token:string,body:unknown,stream=false){
    let last:Response|undefined;
    for(const base of this.bases()){
      const r=await fetch(base+path.replace(/^\/v1internal/,"")+(stream?"?alt=sse":""),{
        method:"POST",
        headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","User-Agent":userAgent(this.env)},
        body:JSON.stringify(body)
      });
      if(r.ok)return r;
      last=r;
      if(r.status===401||r.status===403)break;
      if(![408,429,499].includes(r.status)&&r.status<500)break;
    }
    throw new UpstreamError(last?.status??502,last?await last.text():"upstream unavailable");
  }
  async loadCodeAssist(token:string){
    return (await this.request(":loadCodeAssist",token,{metadata:{ideType:"ANTIGRAVITY"}})).json<any>();
  }
  async retrieveUserQuota(token:string,project?:string){
    let last:Response|undefined;
    for(const endpoint of QUOTA_ENDPOINTS){
      const headers={Authorization:"Bearer "+token,"Content-Type":"application/json","User-Agent":userAgent(this.env),...(project?{"x-goog-user-project":project}:{})};
      const r=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(project?{project}:{})});
      if(r.ok)return r.json<any>();
      last=r;
      if(r.status===403&&project){
        const retry=await fetch(endpoint,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","User-Agent":userAgent(this.env)},body:"{}"});
        if(retry.ok)return retry.json<any>(); last=retry;
      }
      if(![408,429,499].includes(r.status)&&r.status<500)break;
    }
    throw new UpstreamError(last?.status??502,last?await last.text():"quota unavailable");
  }
  async generate(token:string,req:InternalGenerateRequest,stream:boolean){
    return this.request(stream?":streamGenerateContent":":generateContent",token,req,stream);
  }
}
export class UpstreamError extends Error{constructor(public status:number,public body:string){super("upstream "+status);}}
