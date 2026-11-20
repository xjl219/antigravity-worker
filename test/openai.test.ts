import {describe,it,expect} from "vitest";
import {toInternal} from "../src/openai";
import {toAnthropicInternal,anthropicResponse} from "../src/anthropic";
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

  it("routes high-reasoning compatibility aliases to Code Assist",()=>{
    for(const model of ["gemini-3.1-pro-high","o1","o3","gpt-4","gpt-4-turbo","gpt-4-turbo-preview"]){
      const x=toInternal({model,messages:[{role:"user",content:"hello"}]},"p","gemini-2.5-flash");
      expect(x.model).toBe("gemini-pro-agent");
    }
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
  it("preserves Google thought signatures on tool_use blocks and restores them",()=>{
    const signature="B".repeat(96);
    const response=anthropicResponse({response:{candidates:[{content:{parts:[
      {functionCall:{name:"list_dir",id:"tool_1",args:{path:"/"}},thoughtSignature:signature}
    ]}}]}},"claude-sonnet-4-6");
    expect(response.content[0]).toMatchObject({type:"tool_use",signature});
    const request=toAnthropicInternal({
      model:"claude-sonnet-4-6",max_tokens:100,
      messages:[
        {role:"assistant",content:response.content},
        {role:"user",content:[{type:"tool_result",tool_use_id:"tool_1",content:"[]"}]}
      ]
    },"project","test");
    expect(request.request.contents[0].parts[0]).toMatchObject({
      functionCall:{name:"list_dir",id:"tool_1",args:{path:"/"}},
      thoughtSignature:signature
    });
  });

  it("adds Google's sentinel signature to unsigned Gemini tool calls",()=>{
    const request=toAnthropicInternal({
      model:"gemini-3.8-flash-high",max_tokens:1024,
      messages:[
        {role:"assistant",content:[
          {type:"tool_use",id:"tool_grep_1",name:"default_api:grep",input:{pattern:"TODO",path:"src"}}
        ]},
        {role:"user",content:[
          {type:"tool_result",tool_use_id:"tool_grep_1",content:"src/index.ts:23"}
        ]}
      ]
    },"project","test");

    expect(request.model).toBe("gemini-3.8-flash-high");
    expect(request.request.contents[0].parts[0]).toMatchObject({
      functionCall:{name:"default_api:grep",id:"tool_grep_1",args:{pattern:"TODO",path:"src"}},
      thoughtSignature:"skip_thought_signature_validator"
    });
    expect(request.request.contents[1].parts[0]).toMatchObject({
      functionResponse:{name:"default_api:grep",id:"tool_grep_1"}
    });
  });

  it("does not add the signature-bypass sentinel to older Gemini tool calls",()=>{
    const request=toAnthropicInternal({
      model:"gemini-2.5-flash",max_tokens:1024,
      messages:[{role:"assistant",content:[
        {type:"tool_use",id:"tool_old_1",name:"search",input:{query:"test"}}
      ]}]
    },"project","test");

    expect(request.request.contents[0].parts[0]).toMatchObject({
      functionCall:{name:"search",id:"tool_old_1",args:{query:"test"}}
    });
    expect(request.request.contents[0].parts[0]).not.toHaveProperty("thoughtSignature");
  });

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
