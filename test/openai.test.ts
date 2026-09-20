import {describe,it,expect} from "vitest";
import {toInternal} from "../src/openai";
describe("OpenAI adapter",()=>{
  it("maps system/user/assistant messages",()=>{
    const x=toInternal({messages:[
      {role:"system",content:"be concise"},
      {role:"user",content:"hello"},
      {role:"assistant",content:"hi"}
    ]},"p","gemini-2.5-flash");
    expect(x.project).toBe("p"); expect(x.request.systemInstruction?.parts[0].text).toBe("be concise");
    expect(x.request.contents[1].role).toBe("model");
  });
});