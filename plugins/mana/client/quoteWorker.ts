import { measureSculpt, type QuoteReply, type QuoteRequest } from './quote.ts';

interface QuoteWorkerScope {
  onmessage: ((event: MessageEvent<QuoteRequest>) => void) | null;
  postMessage(reply: QuoteReply): void;
}

const scope = globalThis as unknown as QuoteWorkerScope;
scope.onmessage = ({ data }): void => {
  let measurement: QuoteReply['measurement'] = null;
  try {
    measurement = measureSculpt(data.sample);
  } catch (error) {
    console.error('[mana] hover quote failed', error);
  }
  scope.postMessage({ id: data.id, measurement });
};
