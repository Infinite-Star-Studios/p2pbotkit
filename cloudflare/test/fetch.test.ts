/**
 * fetch.ts: the Worker's fetch never follows a redirect. Every request is
 * sent with redirect "manual" (the runtime has no "error"), and a redirect
 * that comes back fails with a TypeError, as the Fetch standard says
 * redirect "error" fails; every other answer is returned as it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noRedirectFetch } from '../src/fetch.js';

test('every request goes out with redirect "manual"; a redirect answer is a TypeError; other answers pass as they are', async () => {
  const seen: Array<RequestInit | undefined> = [];
  let answer = new Response('{}', { status: 200 });
  const native = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    seen.push(init);
    return answer;
  }) as typeof fetch;
  const f = noRedirectFetch(native);
  for (const redirect of ['error', 'follow', undefined] as const) {
    assert.equal((await f('https://rpc.example/', { method: 'POST', body: 'x', ...(redirect ? { redirect } : {}) })).status, 200);
    assert.equal(seen.at(-1)!.redirect, 'manual', `asked ${redirect ?? 'nothing'}: sent "manual"`);
    assert.equal(seen.at(-1)!.method, 'POST', 'the rest of the request as it was');
  }
  for (const status of [301, 302, 303, 307, 308]) {
    answer = new Response('moved', { status, headers: { location: 'https://elsewhere.example/' } });
    await assert.rejects(f('https://rpc.example/', { redirect: 'error' }), (e: unknown) => e instanceof TypeError && /redirect \(\d+\)/.test(e.message));
  }
  answer = new Response(null, { status: 304 });
  assert.equal((await f('https://rpc.example/')).status, 304, 'not a redirect status');
  answer = new Response('no location', { status: 302 });
  assert.equal((await f('https://rpc.example/')).status, 302, 'a redirect status without a location is an answer (the standard)');
  answer = new Response('ok', { status: 200 });
  await f(new Request('https://board.example/', { redirect: 'follow' }));
  assert.equal(seen.at(-1)!.redirect, 'manual', 'a Request too');
});
