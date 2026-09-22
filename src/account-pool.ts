import { DurableObject } from "cloudflare:workers";
import {decryptString,encryptString,randomBase64Url} from "./crypto";
import {refreshToken} from "./google-oauth";
import type {Env,AccountRow,SessionRow} from "./types";

const SESSION_TTL_MS=24*60*60*1000;
const REFRESH_LOCK_MS=15_000;

export class AccountPoolDO extends DurableObject<Env> {
  private initialized=false;
  constructor(ctx:DurableObjectState,env:Env){ super(ctx,env); }

  private init(){
    if(this.initialized)return; this.initialized=true;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY,email TEXT NOT NULL,project_id TEXT,access_token_enc TEXT,refresh_token_enc TEXT,
      access_token_expires_at INTEGER,status TEXT NOT NULL DEFAULT 'ACTIVE',cooldown_until INTEGER NOT NULL DEFAULT 0,
      health_score INTEGER NOT NULL DEFAULT 100,failure_count INTEGER NOT NULL DEFAULT 0,last_used_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS refresh_locks(
      account_id TEXT PRIMARY KEY,owner TEXT NOT NULL,locked_until INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_pending(
      state TEXT PRIMARY KEY,verifier TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  }

  private rows<T>(q:string,...args:any[]){return this.ctx.storage.sql.exec(q,...args).toArray() as T[];}

  private async sleep(ms:number){await new Promise<void>(r=>setTimeout(r,ms));}

  private async refreshAccess(a:AccountRow):Promise<{access:string;expiresAt:number}>{
    const now=Date.now();
    if(a.access_token_enc&&a.access_token_expires_at&&a.access_token_expires_at>now+60_000){
      return {access:await decryptString(a.access_token_enc,this.env.TOKEN_ENCRYPTION_KEY),expiresAt:a.access_token_expires_at};
    }
    if(!a.refresh_token_enc)throw new Error("account has no refresh token");

    const owner=randomBase64Url(16);
    for(let attempt=0;attempt<20;attempt++){
      const t=Date.now();
      this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE locked_until<=?",t);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO refresh_locks(account_id,owner,locked_until) VALUES(?,?,?)",a.id,owner,t+REFRESH_LOCK_MS);
      const lock=this.rows<{owner:string;locked_until:number}>("SELECT owner,locked_until FROM refresh_locks WHERE account_id=?",a.id)[0];
      if(lock?.owner===owner){
        try{
          const current=this.rows<AccountRow>("SELECT * FROM accounts WHERE id=?",a.id)[0];
          if(!current)throw new Error("account not found");
          if(current.access_token_enc&&current.access_token_expires_at&&current.access_token_expires_at>Date.now()+60_000){
            return {access:await decryptString(current.access_token_enc,this.env.TOKEN_ENCRYPTION_KEY),expiresAt:current.access_token_expires_at};
          }
          const rt=current.refresh_token_enc?await decryptString(current.refresh_token_enc,this.env.TOKEN_ENCRYPTION_KEY):"";
          if(!rt)throw new Error("account has no refresh token");
          try{
            const token=await refreshToken(this.env,rt);
            const access=token.access_token;
            const expiresAt=Date.now()+(token.expires_in??3600)*1000;
            this.ctx.storage.sql.exec(
              "UPDATE accounts SET access_token_enc=?,access_token_expires_at=?,last_used_at=?,updated_at=? WHERE id=?",
              await encryptString(access,this.env.TOKEN_ENCRYPTION_KEY),expiresAt,Date.now(),Date.now(),a.id
            );
            return {access,expiresAt};
          }catch(e){
            this.ctx.storage.sql.exec(
              "UPDATE accounts SET health_score=MAX(0,health_score-10),failure_count=failure_count+1,cooldown_until=?,status='ACTIVE',updated_at=? WHERE id=?",
              Date.now()+60_000,Date.now(),a.id
            );
            throw e;
          }
        }finally{
          this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE account_id=? AND owner=?",a.id,owner);
        }
      }
      await this.sleep(50+attempt*25);
      const current=this.rows<AccountRow>("SELECT * FROM accounts WHERE id=?",a.id)[0];
      if(current?.access_token_enc&&current.access_token_expires_at&&current.access_token_expires_at>Date.now()+60_000){
        return {access:await decryptString(current.access_token_enc,this.env.TOKEN_ENCRYPTION_KEY),expiresAt:current.access_token_expires_at};
      }
    }
    throw new Error("account token refresh is busy");
  }

  private chooseAccount(excluded:string[],preferred?:string):AccountRow|undefined{
    const now=Date.now();
    if(preferred){
      const a=this.rows<AccountRow>(
        "SELECT * FROM accounts WHERE id=? AND status='ACTIVE' AND cooldown_until<=? LIMIT 1",preferred,now
      )[0];
      if(a&&!excluded.includes(a.id))return a;
    }
    return this.rows<AccountRow>(
      `SELECT * FROM accounts
       WHERE status='ACTIVE' AND cooldown_until<=?
         AND id NOT IN (${excluded.length?"("+excluded.map(()=>"?").join(",")+")":"('')"})
       ORDER BY health_score DESC,last_used_at ASC LIMIT 1`,
      now,...excluded
    )[0];
  }

  async fetch(req:Request){
    this.init();
    const u=new URL(req.url),p=u.pathname;

    if(req.method==="POST"&&p==="/internal/oauth/pending"){
      const x=await req.json<any>();
      this.rows("DELETE FROM oauth_pending WHERE created_at<=?",Date.now()-600000);
      this.rows("INSERT OR REPLACE INTO oauth_pending VALUES(?,?,?)",x.state,x.verifier,Date.now());
      return Response.json({ok:true});
    }

    if(req.method==="POST"&&p==="/internal/oauth/consume"){
      const x=await req.json<any>();
      const r=this.rows<any>("SELECT verifier FROM oauth_pending WHERE state=? AND created_at>?",x.state,Date.now()-600000)[0];
      this.ctx.storage.sql.exec("DELETE FROM oauth_pending WHERE state=?",x.state);
      return Response.json(r??null);
    }

    if(req.method==="POST"&&p==="/internal/account/upsert"){
      const x=await req.json<any>(),now=Date.now();
      this.ctx.storage.sql.exec(`INSERT INTO accounts(id,email,project_id,access_token_enc,refresh_token_enc,access_token_expires_at,status,cooldown_until,health_score,failure_count,last_used_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET email=excluded.email,project_id=excluded.project_id,
        access_token_enc=excluded.access_token_enc,refresh_token_enc=COALESCE(excluded.refresh_token_enc,accounts.refresh_token_enc),
        access_token_expires_at=excluded.access_token_expires_at,status='ACTIVE',cooldown_until=0,health_score=100,updated_at=?`,
        x.id,x.email,x.project_id,x.access_token_enc,x.refresh_token_enc,x.expires_at,"ACTIVE",0,100,0,0,now,now,now);
      return Response.json({ok:true});
    }

    if(req.method==="GET"&&p==="/internal/accounts"){
      return Response.json(this.rows("SELECT id,email,project_id,status,health_score,failure_count,access_token_expires_at,cooldown_until,last_used_at,updated_at FROM accounts ORDER BY health_score DESC,last_used_at ASC"));
    }

    if(req.method==="DELETE"&&p.startsWith("/internal/account/")){
      const id=decodeURIComponent(p.slice("/internal/account/".length));
      if(!id)return new Response("account id is required",{status:400});
      const existing=this.rows<AccountRow>("SELECT id FROM accounts WHERE id=?",id)[0];
      if(!existing)return new Response("account not found",{status:404});
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE account_id=?",id);
      this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE account_id=?",id);
      this.ctx.storage.sql.exec("DELETE FROM accounts WHERE id=?",id);
      return Response.json({ok:true,id});
    }

    if(req.method==="POST"&&p==="/internal/allocate"){
      const x=await req.json<any>(),now=Date.now(),excluded:Array<string>=Array.isArray(x.exclude_account_ids)?x.exclude_account_ids:[];
      let session:SessionRow|undefined;
      if(x.session_id){
        session=this.rows<SessionRow>("SELECT * FROM sessions WHERE session_id=? AND expires_at>?",x.session_id,now)[0];
        if(session&&!excluded.includes(session.account_id)){
          const sticky=this.rows<AccountRow>(
            "SELECT * FROM accounts WHERE id=? AND status='ACTIVE' AND cooldown_until<=? LIMIT 1",session.account_id,now
          )[0];
          if(sticky){
            try{
              const {access,expiresAt}=await this.refreshAccess(sticky);
              this.ctx.storage.sql.exec("UPDATE sessions SET last_used_at=?,expires_at=? WHERE session_id=?",now,now+SESSION_TTL_MS,session.session_id);
              this.ctx.storage.sql.exec("UPDATE accounts SET last_used_at=? WHERE id=?",now,sticky.id);
              return Response.json({account_id:sticky.id,email:sticky.email,project_id:sticky.project_id,access_token:access,session_id:session.session_id,access_token_expires_at:expiresAt});
            }catch{
              this.ctx.storage.sql.exec("DELETE FROM sessions WHERE session_id=?",session.session_id);
              session=undefined;
            }
          }else{
            this.ctx.storage.sql.exec("DELETE FROM sessions WHERE session_id=?",session.session_id);
            session=undefined;
          }
        }
      }

      const a=this.chooseAccount(excluded,x.preferred_account_id);
      if(!a)return new Response("no healthy account",{status:503});
      try{
        const {access,expiresAt}=await this.refreshAccess(a);
        const sessionId=x.session_id||randomBase64Url(24);
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO sessions(session_id,account_id,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?)",
          sessionId,a.id,session?.created_at??now,now,now+SESSION_TTL_MS
        );
        this.ctx.storage.sql.exec("UPDATE accounts SET last_used_at=? WHERE id=?",now,a.id);
        return Response.json({account_id:a.id,email:a.email,project_id:a.project_id,access_token:access,session_id:sessionId,access_token_expires_at:expiresAt});
      }catch(e){
        this.ctx.storage.sql.exec(
          "UPDATE accounts SET health_score=MAX(0,health_score-10),failure_count=failure_count+1,cooldown_until=?,updated_at=? WHERE id=?",
          Date.now()+30_000,Date.now(),a.id
        );
        return new Response(e instanceof Error?e.message:"account token refresh failed",{status:503});
      }
    }

    if(req.method==="POST"&&p==="/internal/failure"){
      const x=await req.json<any>(),status=Number(x.status)||500;
      const cooldown=status===429?60_000:status===401||status===403?24*60*60*1000:status>=500?15_000:10_000;
      const penalty=status===429?5:10;
      this.ctx.storage.sql.exec(
        "UPDATE accounts SET health_score=MAX(0,health_score-?),failure_count=failure_count+1,cooldown_until=?,status=?,updated_at=? WHERE id=?",
        penalty,Date.now()+cooldown,status===401||status===403?"BLOCKED":"ACTIVE",Date.now(),x.account_id
      );
      if(x.session_id)this.ctx.storage.sql.exec("DELETE FROM sessions WHERE session_id=?",x.session_id);
      return Response.json({ok:true});
    }

    if(req.method==="POST"&&p==="/internal/success"){
      const x=await req.json<any>();
      this.ctx.storage.sql.exec("UPDATE accounts SET health_score=MIN(100,health_score+2),cooldown_until=0,status='ACTIVE',updated_at=? WHERE id=?",Date.now(),x.account_id);
      if(x.session_id)this.ctx.storage.sql.exec("UPDATE sessions SET last_used_at=?,expires_at=? WHERE session_id=?",Date.now(),Date.now()+SESSION_TTL_MS,x.session_id);
      return Response.json({ok:true});
    }

    return new Response("not found",{status:404});
  }
}