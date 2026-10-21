import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, parseResponse } from './openaiCompatible';

describe('OpenAI-compatible tool-calling protocol', () => {
  it('parses calls and usage', () => {
    expect(parseResponse({choices:[{message:{content:null,tool_calls:[{id:'abc',type:'function',function:{name:'get_status',arguments:'{}'}}]}}],usage:{prompt_tokens:10,completion_tokens:5}})).toEqual({text:null,toolCalls:[{id:'abc',name:'get_status',args:{}}],usage:{input:10,output:5}});
  });
  it('encodes calls and matching tool results', async () => {
    const mock=vi.fn(async (_url: unknown, req: RequestInit) => {
      const body=JSON.parse(String(req.body));
      expect(body.tools[0].function.name).toBe('get_status');
      expect(body.messages[1].tool_calls[0].id).toBe('call_1');
      expect(body.messages[2]).toEqual({role:'tool',tool_call_id:'call_1',content:'ok'});
      return {ok:true,json:async ()=>({choices:[{message:{content:'done'}}]})} as Response;
    });
    const p=new OpenAICompatibleProvider({baseUrl:'https://api.example.com/v1',model:'a-model',fetchImpl:mock as typeof fetch});
    const r=await p.complete({system:'system',messages:[{role:'assistant',content:null,toolCalls:[{id:'call_1',name:'get_status',args:{}}]},{role:'tool',toolCallId:'call_1',content:'ok'}],tools:[{name:'get_status',description:'status',parameters:{type:'object',properties:{}}}],signal:new AbortController().signal});
    expect(r.text).toBe('done'); expect(mock).toHaveBeenCalledOnce();
  });
  it('encodes an image preview for vision models', async () => {
    const mock=vi.fn(async (_url:unknown,req:RequestInit) => {
      const body=JSON.parse(String(req.body));
      expect(body.messages[1].content[0]).toEqual({type:'text',text:'Current preview'});
      expect(body.messages[1].content[1]).toEqual({type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}});
      return {ok:true,json:async()=>({choices:[{message:{content:'I can see it.'}}]})} as Response;
    });
    const provider=new OpenAICompatibleProvider({baseUrl:'https://api.example.com/v1',model:'test',fetchImpl:mock as typeof fetch});
    expect(provider.supportsVision).toBe(true);
    await provider.complete({system:'x',messages:[{role:'user',content:'Current preview',imageDataUrl:'data:image/png;base64,aGVsbG8='}],tools:[],signal:new AbortController().signal});
  });
  it('rejects insecure remote endpoints and malformed responses', () => {
    expect(()=>new OpenAICompatibleProvider({baseUrl:'http://example.com/v1',model:'model'})).toThrow();
    expect(()=>new OpenAICompatibleProvider({baseUrl:'http://localhost:11434/v1',model:'model',allowLocalHttp:true})).not.toThrow();
    expect(()=>parseResponse({choices:[{message:{tool_calls:[{id:'x',function:{name:'edit',arguments:'{'}}]}}]})).toThrow();
  });
});
