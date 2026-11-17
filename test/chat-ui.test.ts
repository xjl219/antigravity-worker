import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";

describe("embedded chat page scripts",()=>{
  it("parses every inline script so a syntax error cannot disable the chat UI",()=>{
    const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
    const scripts=[...source.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for(const match of scripts){
      expect(()=>new Function(match[1])).not.toThrow();
    }
  });

  it("uses the live model catalog in both chat pages",()=>{
    const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
    expect(source.match(/fetch\\("\/v1\/models\\?live=1"/g)?.length??0).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain('chatEl.innerHTML="<div id="empty"');
  });
});
