import {describe,it,expect} from "vitest";
import {toInternal} from "../src/openai";
import {toAnthropicInternal} from "../src/anthropic";
import {statusForFailure} from "../src/account-health";
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

describe("Account health",()=>{
  it("only permanently blocks accounts for failed authentication",()=>{
    expect(statusForFailure(401)).toBe("BLOCKED");
    expect(statusForFailure(403)).toBe("ACTIVE");
    expect(statusForFailure(429)).toBe("ACTIVE");
  });
});

describe("Anthropic adapter",()=>{
  it("converts JSON Schema tool inputs to Gemini's compatible schema subset",()=>{
    const inputSchema={
      $schema:"https://json-schema.org/draft/2020-12/schema",
      type:"object",
      propertyNames:{pattern:"^[a-z]+$"},
      properties:{
        query:{type:"string",description:"Search query",minLength:1},
        options:{
          type:"object",
          propertyNames:{format:"email"},
          properties:{limit:{type:["integer","null"]}}
        }
      },
      required:["query"],
      additionalProperties:false
    };
    const request=toAnthropicInternal({
      model:"claude-sonnet-4-6",max_tokens:100,
      messages:[{role:"user",content:"Search."}],
      tools:[{name:"search",input_schema:inputSchema}]
    },"project","test");

    expect(request.request.tools).toEqual([{functionDeclarations:[{
      name:"search",description:"",parameters:{
        type:"object",properties:{
          query:{type:"string",description:"Search query"},
          options:{type:"object",properties:{limit:{type:"integer",nullable:true}}}
        },required:["query"]
      }
    }]}]);
    expect(inputSchema).toHaveProperty("$schema");
    expect(inputSchema).toHaveProperty("propertyNames");
    expect(inputSchema.properties.options).toHaveProperty("propertyNames");
  });
});
