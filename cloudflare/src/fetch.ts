/**
 * The fetch of every request the kits send from the Worker: the board's
 * (KitInternals.fetch) and both chains' (KitInternals.rpcFetch).
 *
 * The kit asks every request never to follow a redirect, with
 * `redirect: 'error'`: a redirect must never take a request (and a signed
 * transaction in it) to a host the kit did not check (check 67). The Workers
 * runtime does not implement that value; it throws on it. So here every
 * request is sent with `redirect: 'manual'`, whatever it asked for, and a
 * redirect that comes back fails as the Fetch standard says
 * `redirect: 'error'` fails: a TypeError, its body unread, never followed.
 */

/** The statuses that redirect (the Fetch standard's "redirect status"). */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** A fetch that never follows a redirect: each one is a TypeError, as with `redirect: 'error'`. */
export function noRedirectFetch(native: typeof fetch): typeof fetch {
  const strict = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await native(input instanceof Request ? new Request(input, { redirect: 'manual' }) : input, { ...init, redirect: 'manual' });
    if (REDIRECTS.has(res.status) && res.headers.has('location')) {
      await res.body?.cancel().catch(() => undefined);
      throw new TypeError(`fetch failed: the answer was a redirect (${res.status}), which this request never follows`);
    }
    return res;
  };
  return strict as typeof fetch;
}
