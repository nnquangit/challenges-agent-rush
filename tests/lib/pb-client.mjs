// Minimal ProofBox HTTP client for the black-box probes: one instance = one
// session principal (its own pb_session cookie). Token from PROOFBOX_DEMO_TOKEN.
// Against a server without /api/session (the pre-fix build) it runs cookieless,
// so the same probes show what an unauthenticated stranger could do there.

export function makeClient(base, { token = process.env.PROOFBOX_DEMO_TOKEN, xff } = {}) {
  let cookie = null;
  const state = { sessionStatus: null, legacy: false };
  async function ensure() {
    if (cookie !== null) return;
    const res = await fetch(base + "/api/session", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-proofbox-token": token } : {}) }, body: "{}" });
    state.sessionStatus = res.status;
    if (res.status === 404 || res.status === 405) {
      state.legacy = true; // no session endpoint: pre-fix server
      cookie = "";
      return;
    }
    if (!res.ok) throw new Error(`POST /api/session → ${res.status}`);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  async function req(method, path, body, headers = {}) {
    await ensure();
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(xff ? { "x-forwarded-for": xff } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  }
  return {
    state,
    ensure,
    get: (path, headers) => req("GET", path, undefined, headers),
    post: (path, body, headers) => req("POST", path, body, headers),
  };
}

/** Raw request with no session at all. */
export async function anon(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
