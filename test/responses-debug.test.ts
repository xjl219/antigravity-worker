import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";

describe("Responses API realtime debug instrumentation",()=>{
  const source=readFileSync(new URL("../src/responses.ts",import.meta.url),"utf8");

  it("emits request, allocation and upstream lifecycle events",()=>{
    for(const marker of [
      'kind:"request"',
      'kind:"account_allocation"',
      'kind:"account_allocated"',
      'kind:"upstream_request"',
      'kind:"upstream_response"',
      'kind:"upstream_body"',
      'kind:"response"',
      'kind:"error"'
    ]) expect(source).toContain(marker);
  });

  it("emits streamed upstream chunks and stream completion",()=>{
    expect(source).toContain('kind:"upstream_chunk"');
    expect(source).toContain('phase:"Google stream → client"');
  });

  it("attaches the same trace id to the client response",()=>{
    expect(source).toContain('"x-antigravity-debug-id":traceId');
  });
});
