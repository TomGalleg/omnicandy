import type { ModelProvider, ProviderReply } from '../types';

export interface OpenAICompatibleOptions {
  model: string; baseUrl: string; getKey?: () => Promise<string>;
  fetchImpl?: typeof fetch; timeoutMs?: number; allowLocalHttp?: boolean;
}
/** Chat Completions-compatible tool calling (not the OpenAI Responses API). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible'; readonly supportsVision = true;
  constructor(private readonly options: OpenAICompatibleOptions) {
    const url = new URL(options.baseUrl);
    const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(options.allowLocalHttp && loopback && url.protocol === 'http:')) throw new Error('Model endpoint must be HTTPS, or an explicitly allowed loopback HTTP server.');
    if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint credentials, query and fragment are not permitted.');
  }
  async complete({system,messages,tools,signal}: Parameters<ModelProvider['complete']>[0]):Promise<ProviderReply> {
    const url = new URL(this.options.baseUrl.replace(/\/$/,'') + '/chat/completions');
    const payload = { model:this.options.model, messages:[{role:'system',content:system}, ...messages.map(m => m.role === 'tool' ? {role:'tool',tool_call_id:m.toolCallId,content:m.content} : m.role === 'user' ? {role:'user',content:m.imageDataUrl ? [{type:'text',text:m.content},{type:'image_url',image_url:{url:m.imageDataUrl}}] : m.content} : {role:'assistant',content:m.content, ...(m.toolCalls?.length ? {tool_calls:m.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))} : {})})], tools:tools.map(t => ({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})), tool_choice:'auto' };
    const abort = new AbortController();
    const propagate=()=>abort.abort();
    signal.addEventListener('abort',propagate,{once:true});
    const timeout=setTimeout(()=>abort.abort(),this.options.timeoutMs??120000);
    try {
      const key = this.options.getKey ? await this.options.getKey() : undefined;
      if (signal.aborted) throw new Error('Aborted');
      const res = await (this.options.fetchImpl ?? fetch)(url,{method:'POST',headers:{'content-type':'application/json',...(key ? {authorization:`Bearer ${key}`} : {})},body:JSON.stringify(payload),signal:abort.signal});
      if (!res.ok) throw new Error(`Provider HTTP ${res.status}`);
      const data:unknown = await res.json();
      return parseResponse(data);
    } catch(e) {
      // Never include provider bodies or auth headers in errors.
      if (signal.aborted) throw new Error('Aborted');
      if (e instanceof Error && /Provider HTTP \d+/.test(e.message)) throw e;
      throw new Error('Model request failed or returned invalid data.');
    } finally {clearTimeout(timeout);signal.removeEventListener('abort',propagate);}
  }
}
export function parseResponse(value:unknown):ProviderReply {
  const o = value as {
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: Array<{
          id?: unknown;
          type?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const m=o?.choices?.[0]?.message;
  if (!m || (m.content != null && typeof m.content !== 'string') || (m.tool_calls != null && !Array.isArray(m.tool_calls))) throw new Error('Invalid provider response.');
  const toolCalls=(m.tool_calls??[]).map((c,i)=>{
    if(typeof c.id!=='string' || typeof c.function?.name!=='string' || typeof c.function.arguments!=='string') throw new Error(`Invalid tool call ${i}`);
    let args:unknown;
    try {args=JSON.parse(c.function.arguments);} catch {throw new Error(`Malformed tool arguments in call ${i}`);}
    return {id:c.id,name:c.function.name,args};
  });
  return {text:typeof m.content==='string'?m.content:null,toolCalls,usage:o.usage?{input:o.usage.prompt_tokens??0,output:o.usage.completion_tokens??0}:undefined};
}
