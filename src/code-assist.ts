import type {Env,InternalGenerateRequest} from "./types";

export class CodeAssistClient {
  constructor(private env:Env){}
  private bases(){
    return [this.env.GOOGLE_CODE_ASSIST_BASE_URL,"https://cloudcode-pa.googleapis.com"]
      .filter((v,i,a)=>v && a.indexOf(v)===i).map(v=>v.replace(/\/+$/,""));
  }
  private async request(m:string,token:string,body:unknown,stream=false){
    const bases=this.bases(); let last:Response|undefined;
    for(const base of bases){
      const r=await fetch(base+"/v1internal:"+m+(stream?"?alt=sse":""),{
        method:"POST",
        headers:{
          Authorization:"Bearer "+token,
          "Content-Type":"application/json",
          "User-Agent":"antigravity/1.11.3 Darwin/arm64"
        },
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
    const r=await this.request("loadCodeAssist",token,{metadata:{ideType:"ANTIGRAVITY"}});
    return r.json<any>();
  }
  async retrieveUserQuota(token:string,project?:string){
    const r=await this.request("retrieveUserQuotaSummary",token,project?{project}:{});
    return r.json<any>();
  }
  async generate(token:string,req:InternalGenerateRequest,stream:boolean){
    return this.request(stream?"streamGenerateContent":"generateContent",token,req,stream);
  }
}
export class UpstreamError extends Error {
  constructor(public status:number,public body:string){super("upstream "+status);}
}
