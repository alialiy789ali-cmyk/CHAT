import 'fake-indexeddb/auto';
import { ApiClient } from '../src/lib/api';
import { E2eeEngine } from '../src/lib/e2ee/engine';
const BASE = 'http://127.0.0.1:8787';
const nk = () => { const c = new ApiClient(); c.setBaseUrl(BASE); return c; };
const s = Date.now().toString(36);
const a = nk(), b = nk();
const ua = await a.register({ username: `dg2a${s}`.slice(0,24), email: `dg2a${s}@x.local`, password: 'Sovereign-Live-Passw0rd' });
const ub = await b.register({ username: `dg2b${s}`.slice(0,24), email: `dg2b${s}@x.local`, password: 'Sovereign-Live-Passw0rd' });
const devA = (await a.get<any[]>('/api/auth/sessions')).find(x=>x.current)!.deviceId;
const devB = (await b.get<any[]>('/api/auth/sessions')).find(x=>x.current)!.deviceId;
const ea = await E2eeEngine.create(ua.user.id, devA, a);
await E2eeEngine.create(ub.user.id, devB, b);
const conv = await a.post<any>('/api/conversations/direct', { userId: ub.user.id });
const st = await ea.conversationStatus(conv.conversation.id);
await ea.setConversationEncryption(conv.conversation.id, true);
const st2 = await ea.conversationStatus(conv.conversation.id);
console.log('status2:', JSON.stringify(st2.participants));
const bundles = await ea.bundlesFor(ub.user.id);
console.log('bundle used:', JSON.stringify(bundles[0]).slice(0, 400));
try {
  const out = await ea.encryptForConversation(st2, 'hello');
  console.log('envelopes:', out.envelopes.length, 'skipped:', JSON.stringify(out.skipped));
} catch (e) { console.error('THREW', e); }
