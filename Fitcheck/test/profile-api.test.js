const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

const docs = new Map();
const firebaseAuth = {
  verifyIdToken: async (token) => {
    if (token !== "test-token") throw Object.assign(new Error("invalid"), { code: "auth/invalid-id-token" });
    return { uid: "test-user" };
  },
};
const db = {
  collection: (collection) => ({
    doc: (id) => {
      const key = `${collection}/${id}`;
      return {
        get: async () => ({ exists: docs.has(key), data: () => (docs.has(key) ? { ...docs.get(key) } : undefined) }),
        update: async (data) => {
          if (!docs.has(key)) throw Object.assign(new Error("NOT_FOUND"), { code: 5 });
          docs.set(key, { ...docs.get(key), ...data });
        },
      };
    },
  }),
};
const configPath = require.resolve("../config/firebaseAdmin");
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { firebaseAuth, db } };
const apiRoutes = [["/api/profile", require("../routes/profileRoutes")]];

test("profile API reads and patches the signed-in user's profile", async (t) => {
  docs.set("users/test-user", {
    uid: "test-user",
    email: "test@example.test",
    name: "Test User",
    photoURL: "",
    createdAt: "created",
  });

  const server = createApp({ auth: firebaseAuth, analyze: async () => ({}), store: {} }, { apiRoutes }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/profile`;
  const auth = { Authorization: "Bearer test-token" };
  const json = { "Content-Type": "application/json" };

  assert.equal((await fetch(url)).status, 401);

  const get = await fetch(url, { headers: auth });
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).profile, {
    uid: "test-user",
    email: "test@example.test",
    name: "Test User",
    photoURL: "",
    styleGoal: "",
    aesthetics: [],
  });

  const patch = await fetch(url, {
    method: "PATCH",
    headers: { ...auth, ...json },
    body: JSON.stringify({ name: "  Sammy Butler ", styleGoal: "Build a more intentional everyday wardrobe", aesthetics: ["Minimalist", "Casual"] }),
  });
  assert.equal(patch.status, 200);
  const updated = (await patch.json()).profile;
  assert.equal(updated.name, "Sammy Butler");
  assert.equal(updated.styleGoal, "Build a more intentional everyday wardrobe");
  assert.deepEqual(updated.aesthetics, ["Minimalist", "Casual"]);
  assert.equal(updated.email, "test@example.test");

  const invalidBodies = [
    {},
    { email: "hacker@example.test" },
    { aesthetics: ["Punk"] },
    { aesthetics: ["Casual", "Casual"] },
    { name: "   " },
    { styleGoal: "x".repeat(501) },
  ];
  for (const body of invalidBodies) {
    const response = await fetch(url, { method: "PATCH", headers: { ...auth, ...json }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  docs.delete("users/test-user");
  assert.equal((await fetch(url, { headers: auth })).status, 404);
  const missingPatch = await fetch(url, {
    method: "PATCH", headers: { ...auth, ...json }, body: JSON.stringify({ name: "Nobody" }),
  });
  assert.equal(missingPatch.status, 404);
});
