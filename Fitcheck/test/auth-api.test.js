const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

const users = new Map();
const firebaseAuth = {
  createUser: async ({ email, displayName }) => {
    if (email === "existing@example.test") throw Object.assign(new Error("exists"), { code: "auth/email-already-exists" });
    return { uid: "test-user", email, displayName };
  },
  deleteUser: async () => {},
  verifyIdToken: async (token) => {
    if (token !== "test-token") throw new Error("invalid token");
    return { uid: "test-user", email: "test@example.test" };
  },
};
const db = {
  collection: () => ({
    doc: (id) => ({
      set: async (data) => users.set(id, data),
      get: async () => ({ exists: users.has(id), data: () => users.get(id) }),
      update: async (data) => users.set(id, { ...users.get(id), ...data }),
    }),
    add: async () => ({ id: "message-id" }),
  }),
};
const configPath = require.resolve("../config/firebaseAdmin");
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { firebaseAuth, db } };
const apiRoutes = [
  ["/api/auth", require("../routes/authRoutes")],
  ["/api", require("../routes/firebaseTestRoutes")],
  ["/api", require("../routes/fitcheckRoutes")],
];

test("merged authentication and analyzer routes are mounted together", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.FIREBASE_WEB_API_KEY;
  process.env.FIREBASE_WEB_API_KEY = "test-key";
  global.fetch = async (url, options) => {
    if (typeof url === "string" && url.startsWith("https://identitytoolkit.googleapis.com/")) {
      const { password } = JSON.parse(options.body);
      if (password === "invalid") {
        return new Response(JSON.stringify({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }), { status: 400 });
      }
      return Response.json({ idToken: "fake-id-token", refreshToken: "fake-refresh", expiresIn: "3600", localId: "test-user", email: "test@example.test" });
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
    else process.env.FIREBASE_WEB_API_KEY = originalKey;
  });
  const server = createApp({
    auth: { verifyIdToken: async () => ({ uid: "test-user" }) },
    analyze: async () => ({}),
    store: {},
  }, { apiRoutes, allowedOrigins: ["http://localhost:3000"] }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await post("/api/auth/signup", { email: "test@example.test", password: "123456", fullName: "Test User" })).status, 201);
  assert.equal((await post("/api/auth/signup", { email: "existing@example.test", password: "123456", fullName: "Test User" })).status, 409);
  assert.equal((await post("/api/auth/signup", { email: "test@example.test", password: "short", fullName: "Test User" })).status, 400);
  const signIn = await post("/api/auth/signin", { email: "test@example.test", password: "123456" });
  assert.equal(signIn.status, 200);
  assert.equal((await signIn.json()).idToken, "fake-id-token");
  assert.equal((await post("/api/auth/signin", { email: "test@example.test", password: "invalid" })).status, 401);
  assert.equal((await post("/api/auth/session", {})).status, 401);
  assert.equal((await post("/api/auth/session", {}, "test-token")).status, 200);
  assert.equal((await fetch(`${url}/analyze`, { method: "POST" })).status, 401);
  const preflight = await fetch(`${url}/api/auth/signin`, {
    method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);
});
