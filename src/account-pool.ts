import {decryptString,encryptString} from "./crypto";
import {refreshToken} from "./google-oauth";
import type {Env,AccountRow,SessionRow} from "./types";

export class AccountPoolDO {
  private initialized=false;
  constructor(private ctx:DurableObjectState,private env:Env){}
  private init(){
    if(this.initialized)return; this.initialized=true;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY,email TEXT NOT NULL,project_id TEXT,access_token_enc TEXT,refresh_token_enc TEXT,
      access_token_expires_at INTEGER,status TEXT NOT NULL DEFAULT 'ACTIVE',cooldown_until INTEGER NOT NULL DEFAULT 0,
      health_score INTEGER NOT NULL DEFAULT 100,failure_count INTEGER NOT NULL DEFAULT 0,last_used_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_pending(
      state TEXT PRIMARY KEY,verifier TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  }
  private rows<T>(q:string,...args:any[]){return this.ctx.storage.sql.exec(q,...args).toArray() as T[];}
  async fetch(req:Request){
    this.init(); const u=new URL(req.url),p=u.pathname;
    if(req.method==="POST"&&p==="/internal/oauth/pending"){const x=await req.json<any>();this.rows("INSERT OR REPLACE INTO oauth_pending VALUES(?,?,?)",x.state,x.verifier,Date.now());return Response.json({ok:true});}
    if(req.method==="POST"&&p==="/internal/oauth/consume"){const x=await req.json<any>(),r=this.rows<any>("SELECT verifier FROM oauth_pending WHERE state=? AND created_at>?",x.state,Date.now()-600000)[0];this.ctx.storage.sql.exec("DELETE FROM oauth_pending WHERE state=?",x.state);return Response.json(r??null);}
    if(req.method==="POST"&&p==="/internal/account/upsert"){const x=await req.json<any>(),now=Date.now();
      this.ctx.storage.sql.exec(`INSERT INTO accounts(id,email,project_id,access_token_enc,refresh_token_enc,access_token_expires_at,status,cooldown_until,health_score,failure_count,last_used_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,project_id=excluded.project_id,access_token_enc=excluded.access_token_enc,refresh_token_enc=COALESCE(excluded.refresh_token_enc,accounts.refresh_token_enc),access_token_expires_at=excluded.access_token_expires_at,status='ACTIVE',updated_at=?`,
      x.id,x.email,x.project_id,x.access_token_enc,x.refresh_token_enc,x.expires_at,"ACTIVE",0,100,0,0,now,now,now);return Response.json({ok:true});
    }
    if(req.method==="GET"&&p==="/internal/accounts")return Response.json(this.rows("SELECT id,email,project_id,status,health_score,failure_count,last_used_at,updated_at FROM accounts ORDER BY health_score DESC,last_used_at ASC"));
    if(req.method==="POST"&&p==="/internal/allocate"){const x=await req.json<any>(),now=Date.now();
      let a=this.rows<AccountRow>(x.preferred_account_id ? "SELECT * FROM accounts WHERE id=? AND status='ACTIVE' LIMIT 1" : "SELECT * FROM accounts WHERE status='ACTIVE' AND cooldown_until<=? ORDER BY health_score DESC,last_used_at ASC LIMIT 1", x.preferred_account_id ? x.preferred_account_id : now)[0];
      if(!a)return new Response("no healthy account", {status:503});
      let access=a.access_token_enc?await decryptString(a.access_token_enc,this.env.TOKEN_ENCRYPTION_KEY):"";
      if(!access||!a.access_token_expires_at||a.access_token_expires_at<Date.now()+60000){
        if(!a.refresh_token_enc)return new Response("account has no refresh token",{status:503});
        const rt=await decryptString(a.refresh_token_enc,this.env.TOKEN_ENCRYPTION_KEY),t=await refreshToken(this.env,rt);
        access=t.access_token; const exp=Date.now()+(t.expires_in??3600)*1000;
        this.ctx.storage.sql.exec("UPDATE accounts SET access_token_enc=?,access_token_expires_at=?,last_used_at=?,updated_at=? WHERE id=?",await encryptString(access,this.env.TOKEN_ENCRYPTION_KEY),exp,now,now,a.id);
        a.access_token_expires_at=exp;
      }
      this.ctx.storage.sql.exec("UPDATE accounts SET last_used_at=? WHERE id=?",now,a.id);
      return Response.json({account_id:a.id,email:a.email,project_id:a.project_id,access_token:access});
    }
    if(req.method==="POST"&&p==="/internal/failure"){const x=await req.json<any>();const cooldown=x.status===429?60000:x.status===401||x.status===403?86400000:10000;this.ctx.storage.sql.exec("UPDATE accounts SET health_score=MAX(0,health_score-?),failure_count=failure_count+1,cooldown_until=?,status=? WHERE id=?",x.status===429?5:10,Date.now()+cooldown,x.status===401||x.status===403?"BLOCKED":"ACTIVE",x.account_id);return Response.json({ok:true});}
    if(req.method==="POST"&&p==="/internal/success"){const x=await req.json<any>();this.ctx.storage.sql.exec("UPDATE accounts SET health_score=MIN(100,health_score+2),cooldown_until=0,status='ACTIVE' WHERE id=?",x.account_id);return Response.json({ok:true});}
    return new Response("not found",{status:404});
  }
}