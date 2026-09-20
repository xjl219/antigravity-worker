import type {Env,InternalGenerateRequest} from "./types";

export class CodeAssistClient {
  constructor(private env:Env){}
  private url(m:string){return `${this.env.GOOGLE_CODE_ASSIST_BASE_URL}/v1internal:${m}`;}
  private async post(m:string,token:string,body:unknown){
    return fetch(this.url(m),{method:"POST",headers:{
      Authorization:`Bearer ${token}`,"Content-Type":"application/json",
      "User-Agent":"antigravity/windows/amd64"
    },body:JSON.stringify(body)});
  }
  async loadCodeAssist(token:string){
    const r=await this.post("loadCodeAssist",token,{metadata:{ideType:"ANTIGRAVITY",pluginType:"GEMINI"}});
    if(!r.ok) throw new UpstreamError(r.status,await r.text()); return r.json<any>();
  }
  async retrieveUserQuota(token:string,project?:string){
    const r=await this.post("retrieveUserQuota",token,project?{project}:{});
    if(!r.ok) throw new UpstreamError(r.status,await r.text()); return r.json<any>();
  }
  async generate(token:string,req:InternalGenerateRequest,stream:boolean){
    const r=await this.post(stream?"streamGenerateContent":"generateContent",token,req);
    if(!r.ok) throw new UpstreamError(r.status,await r.text()); return r;
  }
}
export class UpstreamError extends Error {
  constructor(public status:number,public body:string){super(`upstream ${status}`);}
}