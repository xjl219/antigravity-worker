const enc = new TextEncoder(), dec = new TextDecoder();

function b64u(bytes: Uint8Array): string {
  let s=""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function unb64u(s:string):Uint8Array {
  const p=s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4);
  const raw=atob(p); return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function key(secret:string):Promise<CryptoKey> {
  const d=await crypto.subtle.digest("SHA-256",enc.encode(secret));
  return crypto.subtle.importKey("raw",d,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
export async function encryptString(v:string,secret:string):Promise<string>{
  const k=await key(secret), iv=crypto.getRandomValues(new Uint8Array(12));
  const c=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},k,enc.encode(v)));
  const out=new Uint8Array(iv.length+c.length); out.set(iv); out.set(c,iv.length); return b64u(out);
}
export async function decryptString(v:string,secret:string):Promise<string>{
  const k=await key(secret), d=unb64u(v), iv=d.slice(0,12), c=d.slice(12);
  return dec.decode(await crypto.subtle.decrypt({name:"AES-GCM",iv},k,c));
}
export function randomBase64Url(n=32){return b64u(crypto.getRandomValues(new Uint8Array(n)));}
export async function pkceChallenge(v:string){return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(v))));}