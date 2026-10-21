import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openaiCompatible';

/** Local-only factory; the existing provider supplies transport and tool-call parsing. */
export function createLocalModelProvider(options: Omit<OpenAICompatibleOptions, 'allowLocalHttp' | 'getKey'>): OpenAICompatibleProvider {
  const url = new URL(options.baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Local models must use a loopback HTTP endpoint.');
  }
  return new OpenAICompatibleProvider({ ...options, allowLocalHttp: true });
}
