import {describe,it,expect} from "vitest";
import {buildInternal,extract} from "../src/responses";

describe("Responses API adapter",()=>{
  it("maps instructions, user input and function declarations to Code Assist",()=>{
    const req=buildInternal({
      model:"gemini-2.5-flash",
      instructions:"Follow the repository rules.",
      input:"Inspect the project",
      tools:[{type:"function",name:"read_file",description:"Read a file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}]
    },"project-1","gemini-2.5-flash");
    expect(req.project).toBe("project-1");
    expect(req.request.systemInstruction?.parts[0].text).toBe("Follow the repository rules.");
    expect(req.request.contents[0].parts[0].text).toBe("Inspect the project");
    expect(req.request.tools?.[0]).toEqual({functionDeclarations:[{
      name:"read_file",description:"Read a file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}
    }]});
  });

  it("maps function calls and their outputs into Gemini parts",()=>{
    const req=buildInternal({
      input:[
        {type:"function_call",call_id:"call_1",name:"read_file",arguments:"{\"path\":\"README.md\"}"},
        {type:"function_call_output",call_id:"call_1",output:"file contents"}
      ]
    },"project-1","gemini-2.5-flash");
    expect(req.request.contents[0].parts[0]).toMatchObject({functionCall:{name:"read_file",args:{path:"README.md"},id:"call_1"}});
    expect(req.request.contents[1].parts[0]).toMatchObject({functionResponse:{name:"read_file",id:"call_1",response:{result:"file contents"}}});
  });

  it("converts text and function calls into a Responses output",()=>{
    const result=extract({response:{candidates:[{content:{parts:[
      {text:"Found it."},
      {functionCall:{name:"read_file",id:"call_2",args:{path:"README.md"}}}
    ]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:8}}},"gemini-2.5-flash");
    expect(result.output[0]).toMatchObject({type:"message",role:"assistant",content:[{type:"output_text",text:"Found it."}]});
    expect(result.output[1]).toMatchObject({type:"function_call",call_id:"call_2",name:"read_file",arguments:"{\"path\":\"README.md\"}"});
    expect(result.usage).toEqual({input_tokens:12,output_tokens:8,total_tokens:20});
  });

  it("round-trips Google thought signatures through Responses function_call items",()=>{
    const signature="A".repeat(96);
    const result=extract({response:{candidates:[{content:{parts:[
      {functionCall:{name:"list_dir",id:"call_sig",args:{path:"/"}},thoughtSignature:signature}
    ]}}]}}, "gemini-3.8-flash-low");
    expect(result.output[0]).toMatchObject({
      type:"function_call",
      extra_content:{google:{thought_signature:signature}}
    });
    const req=buildInternal({input:[
      result.output[0],
      {type:"function_call_output",call_id:"call_sig",output:"[]"}
    ]},"project-1","gemini-3.8-flash-low");
    expect(req.request.contents[0].parts[0]).toMatchObject({
      functionCall:{name:"list_dir",id:"call_sig",args:{path:"/" }},
      thoughtSignature:signature
    });
  });

  it("rejects unsupported multimodal content instead of silently dropping it",()=>{
    expect(()=>buildInternal({input:[{type:"message",role:"user",content:[{type:"input_image",image_url:"data:image/png;base64,AA=="}]}]},"p","m")).toThrow(/unsupported message content type/);
  });

  it("rejects malformed function arguments and unsupported previous response state",()=>{
    expect(()=>buildInternal({input:[{type:"function_call",name:"x",arguments:"{"}]},"p","m")).toThrow(/valid JSON/);
    expect(()=>buildInternal({input:"hi",previous_response_id:"resp_old"},"p","m")).toThrow(/previous_response_id/);
  });
});
