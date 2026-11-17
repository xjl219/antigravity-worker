import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";

describe("API test model selection",()=>{
  const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
  const start=source.indexOf('if((u.pathname==="/admin/test"||u.pathname==="/test"))');
  const end=source.indexOf('if(u.pathname==="/admin/debug/ws")',start);
  const page=source.slice(start,end);

  it("loads the live model catalog",()=>{
    expect(page).toContain('/v1/models?live=1');
    expect(page).toContain('credentials:"same-origin"');
  });

  it("synchronizes the selected model into the editable request and outgoing payload",()=>{
    expect(page).toContain('modelEl.addEventListener("change",syncModelToRequest)');
    expect(page).toContain('x.model=modelEl.value');
    expect(page).toContain('body.model=modelEl.value||DEFAULT_MODEL');
  });
});
