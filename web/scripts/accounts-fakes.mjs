// Local stand-ins for WorkOS and Supabase's REST endpoint, used only by
// web/scripts/verify-accounts-e2e.mjs to run the real Pages Function (wrangler pages dev) through a
// full sign-in, follow, watchlist, share, sign-out and delete cycle without any outside service.
//
// Fake WorkOS: /user_management/authorize (redirects straight back with a code for the "next
// user"), /user_management/authenticate (code or refresh token → RS256 access token),
// /sso/jwks/<client>, DELETE /user_management/users/<id>, /user_management/sessions/logout.
// Fake Supabase: POST /rest/v1/rpc/<fn> → `select fn(...)` in a local Postgres as role anon or
// authenticated with request.jwt.claims set, the way PostgREST does, so row-level security and
// grants are the real ones (the database needs web/scripts/supabase-stubs.sql). The token's signature is checked against the fake WorkOS key.

import http from "node:http";
import crypto from "node:crypto";
import postgres from "postgres";

const b64u = (b) => Buffer.from(b).toString("base64url");

export async function startFakes({ dbUrl, workosPort = 8701, supabasePort = 8702, anonKey = "anon-test-key", clientId = "client_test" }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const iss = `http://localhost:${workosPort}/user_management/${clientId}`;
  const sign = (claims) => {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
    const body = b64u(JSON.stringify(claims));
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey);
    return `${head}.${body}.${b64u(sig)}`;
  };
  const verify = (token) => {
    const [h, p, s] = String(token).split(".");
    if (!s) return null;
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    return claims.exp && claims.exp * 1000 < Date.now() ? null : claims;
  };

  const users = new Map();          // id → user
  const codes = new Map();          // code → user id
  const refresh = new Map();        // refresh token → user id
  const log = [];                   // calls, for assertions
  const rpcCalls = [];              // { fn, role } of every REST call the app made
  let nextUser = { id: "user_e2e_A00000000000000001", email: "a@example.test" };
  let accessTtl = 300;

  const userJson = (u) => ({ object: "user", id: u.id, email: u.email, email_verified: true, first_name: null, last_name: null,
    profile_picture_url: null, last_sign_in_at: new Date().toISOString(), created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), external_id: null, metadata: {}, locale: null });
  const issue = (u) => {
    const now = Math.floor(Date.now() / 1000);
    const access = sign({ iss, sub: u.id, sid: `session_${u.id.slice(-6)}`, role: "authenticated", iat: now, exp: now + accessTtl });
    const rt = crypto.randomBytes(16).toString("hex");
    refresh.set(rt, u.id);
    return { user: userJson(u), access_token: access, refresh_token: rt, authentication_method: "MagicAuth" };
  };
  const body = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
  const send = (res, status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };

  const workos = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${workosPort}`);
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/user_management/authorize") {
      const code = crypto.randomBytes(8).toString("hex");
      users.set(nextUser.id, nextUser); codes.set(code, nextUser.id);
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code); back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (url.pathname === `/sso/jwks/${clientId}`) return send(res, 200, { keys: [jwk] });
    if (url.pathname === "/user_management/authenticate" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}");
      const id = b.grant_type === "refresh_token" ? refresh.get(b.refresh_token) : codes.get(b.code);
      if (!id) return send(res, 400, { error: "invalid_grant", error_description: "bad code" });
      if (b.grant_type === "refresh_token") refresh.delete(b.refresh_token); else codes.delete(b.code);
      return send(res, 200, issue(users.get(id)));
    }
    const del = url.pathname.match(/^\/user_management\/users\/([^/]+)$/);
    if (del && req.method === "DELETE") { users.delete(decodeURIComponent(del[1])); return send(res, 202, undefined); }
    if (url.pathname === "/user_management/sessions/logout") { res.writeHead(302, { Location: url.searchParams.get("return_to") ?? "/" }); return res.end(); }
    send(res, 404, { error: "not found in fake" });
  });

  const sql = postgres(dbUrl, { max: 4, onnotice: () => {} });
  const supabase = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${supabasePort}`);
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (!m || req.method !== "POST") return send(res, 404, { message: "not found in fake" });
    if (req.headers.apikey !== anonKey) return send(res, 401, { message: "No API key found in request" });
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    let claims;
    if (!bearer || bearer === anonKey) claims = { role: "anon" };
    else { claims = verify(bearer); if (!claims) return send(res, 401, { code: "PGRST301", message: "JWT expired or invalid" }); }
    const args = JSON.parse((await body(req)) || "{}");
    const keys = Object.keys(args);
    log.push(`rpc ${m[1]} as ${claims.role}`);
    rpcCalls.push({ fn: m[1], role: claims.role });
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${claims.role === "authenticated" ? "authenticated" : "anon"}`);
        await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        return tx.unsafe(`select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? tx.json(args[k]) : args[k])));
      });
      return rows[0].r === null ? (res.writeHead(204), res.end()) : send(res, 200, rows[0].r);
    } catch (e) {
      // P0001 (raise exception) comes back as 400 with the message, as PostgREST does
      return send(res, e.code === "42501" ? 403 : 400, { code: e.code, message: e.message });
    }
  });

  await new Promise((r) => workos.listen(workosPort, "127.0.0.1", r));
  await new Promise((r) => supabase.listen(supabasePort, "127.0.0.1", r));
  return {
    log, users, rpcCalls,
    setNextUser: (u) => { nextUser = u; },
    setAccessTtl: (s) => { accessTtl = s; },
    async close() { workos.close(); supabase.close(); await sql.end(); },
  };
}
