const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const { createOutfitStore } = require("../services/outfits");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
const analysis = {
  style_category: "Casual", outfit_title: "Everyday", overall_score: 80, summary: "A look",
  color_description: "Blue", primary_colors: ["blue"], strengths: ["Color"], next_direction: "Try a jacket",
  scores: { color_harmony_score: 80, style_matching_score: 80, balance_layering_score: 80, accessories_score: 80 },
};

function fakeFirestore() {
  const records = new Map();
  let running = Promise.resolve();
  const snapshot = (ref) => ({
    exists: records.has(ref.path),
    data: () => records.get(ref.path),
  });
  const ref = (path) => ({ path, get: async () => snapshot({ path }) });
  const writer = () => {
    const writes = [];
    return {
      writes,
      set: (target, value) => writes.push(["set", target, value]),
      create: (target, value) => writes.push(["create", target, value]),
      update: (target, value) => writes.push(["update", target, value]),
    };
  };
  const commit = (writes) => {
    for (const [operation, target] of writes) {
      if (operation === "create" && records.has(target.path)) throw new Error("Already exists");
      if (operation === "update" && !records.has(target.path)) throw new Error("Missing record");
    }
    for (const [operation, target, value] of writes) {
      records.set(target.path, operation === "update" ? { ...records.get(target.path), ...value } : value);
    }
  };
  return {
    records,
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    batch: () => {
      const batch = writer();
      batch.commit = async () => commit(batch.writes);
      return batch;
    },
    runTransaction: async (callback) => {
      const run = running.then(async () => {
        const transaction = writer();
        transaction.get = async (target) => snapshot(target);
        const result = await callback(transaction);
        commit(transaction.writes);
        return result;
      });
      running = run.catch(() => {});
      return run;
    },
  };
}

function fakeBucket() {
  const files = new Map();
  return {
    name: "private-bucket",
    files,
    file: (name) => ({
      name,
      save: async (data) => { files.set(name, data); },
      delete: async () => { files.delete(name); },
    }),
  };
}

async function setup(t, analyze = async () => analysis) {
  const db = fakeFirestore();
  const bucket = fakeBucket();
  const auth = {
    verifyIdToken: async (token) => {
      if (!["alice", "bob"].includes(token)) throw Object.assign(new Error("invalid"), { code: "auth/invalid-id-token" });
      return { uid: token };
    },
  };
  const server = createApp({ auth, analyze, store: createOutfitStore(db, bucket) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { db, bucket, url: `http://127.0.0.1:${server.address().port}` };
}

async function createDraft(url, token = "alice") {
  return fetch(`${url}/outfits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ outfitName: "Weekend", occasion: "Party", category: "Casual" }),
  });
}

async function upload(url, token, fields = {}) {
  const body = new FormData();
  body.append("image", new Blob([png], { type: "image/png" }), "outfit.png");
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return fetch(`${url}/analyze`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
}

test("creates pending details and empty media before the upload, then completes the same outfit", async (t) => {
  const { db, bucket, url } = await setup(t);
  const draftResponse = await createDraft(url);
  assert.equal(draftResponse.status, 201);
  const { outfit, media } = await draftResponse.json();
  assert.equal(outfit.status, "pending");
  assert.equal(outfit.userId, "alice");
  assert.equal(media.outfitId, outfit.outfitId);
  assert.equal(media.PhotoStoragePath, "");
  assert.equal(media.PhotoUrl, "");
  assert.equal(media.AudioStoragePath, "");
  assert.equal(media.AudioUrl, "");
  assert.equal(media.uploadedAt, null);
  assert.equal(bucket.files.size, 0);
  assert.equal(db.records.size, 2);

  const response = await upload(url, "alice", { outfitId: outfit.outfitId });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.outfit.outfitId, outfit.outfitId);
  assert.equal(saved.outfit.outfitName, "Weekend");
  assert.equal(saved.outfit.status, "uploaded");
  assert.equal(saved.media.mediaId, media.mediaId);
  assert.equal(saved.analysis.outfit_id, outfit.outfitId);
  assert.equal(saved.scores.analysis_id, saved.analysis.analysis_id);
  assert.ok(bucket.files.has(saved.media.PhotoStoragePath));
  assert.equal(db.records.size, 4);
});

test("does not analyze another user's draft or an already completed draft", async (t) => {
  let calls = 0;
  const { url } = await setup(t, async () => { calls++; return analysis; });
  const draft = await (await createDraft(url)).json();
  assert.equal((await upload(url, "bob", { outfitId: draft.outfit.outfitId })).status, 404);
  assert.equal(calls, 0);
  assert.equal((await upload(url, "alice", { outfitId: draft.outfit.outfitId })).status, 201);
  assert.equal((await upload(url, "alice", { outfitId: draft.outfit.outfitId })).status, 409);
  assert.equal(calls, 1);
});

test("keeps a draft unchanged when analysis fails", async (t) => {
  const { db, bucket, url } = await setup(t, async () => { throw new Error("Analysis unavailable"); });
  const draft = await (await createDraft(url)).json();
  assert.equal((await upload(url, "alice", { outfitId: draft.outfit.outfitId })).status, 500);
  assert.equal(db.records.get(`fitcheck_outfit_details/${draft.outfit.outfitId}`).status, "pending");
  assert.equal(db.records.get(`fitcheck_outfit_media/${draft.outfit.outfitId}`).PhotoStoragePath, "");
  assert.equal(bucket.files.size, 0);
});

test("allows only one concurrent completion and cleans up the losing upload", async (t) => {
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const { db, bucket, url } = await setup(t, async () => {
    if (++arrived === 2) release();
    await ready;
    return analysis;
  });
  const draft = await (await createDraft(url)).json();
  const responses = await Promise.all([
    upload(url, "alice", { outfitId: draft.outfit.outfitId }),
    upload(url, "alice", { outfitId: draft.outfit.outfitId }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(db.records.size, 4);
  assert.equal(bucket.files.size, 1);
});

test("keeps the draft and removes its file when storage fails", async () => {
  const db = fakeFirestore();
  const bucket = fakeBucket();
  const originalFile = bucket.file;
  bucket.file = (name) => {
    const file = originalFile(name);
    return {
      ...file,
      save: async (data) => {
        await file.save(data);
        throw new Error("Storage failed");
      },
    };
  };
  const store = createOutfitStore(db, bucket);
  const { outfit } = await store.createDraft({ userId: "alice", outfitName: "Weekend", occasion: "Party", category: "Casual" });
  await assert.rejects(store.save({ outfitId: outfit.outfitId, userId: "alice", image: png, mimeType: "image/png", analysis }), /Storage failed/);
  assert.equal(db.records.get(`fitcheck_outfit_details/${outfit.outfitId}`).status, "pending");
  assert.equal(db.records.get(`fitcheck_outfit_media/${outfit.outfitId}`).PhotoStoragePath, "");
  assert.equal(bucket.files.size, 0);
});

test("retains files when the draft transaction outcome is uncertain", async () => {
  const db = fakeFirestore();
  const bucket = fakeBucket();
  const store = createOutfitStore(db, bucket);
  const { outfit } = await store.createDraft({ userId: "alice", outfitName: "Weekend", occasion: "Party", category: "Casual" });
  db.runTransaction = async () => { throw new Error("Transaction unavailable"); };
  await assert.rejects(store.save({ outfitId: outfit.outfitId, userId: "alice", image: png, mimeType: "image/png", analysis }), /Transaction unavailable/);
  assert.equal(bucket.files.size, 1);
});

test("preserves one-step uploads and rejects invalid draft requests", async (t) => {
  const { url } = await setup(t);
  assert.equal((await upload(url, "alice", { outfitName: "Old flow", occasion: "Party", category: "Casual" })).status, 201);
  assert.equal((await upload(url, "alice", { outfitId: "not-an-id" })).status, 400);
  assert.equal((await fetch(`${url}/outfits`, {
    method: "POST", headers: { Authorization: "Bearer alice", "Content-Type": "application/json" }, body: "{",
  })).status, 400);
  assert.equal((await fetch(`${url}/outfits`, {
    method: "POST", headers: { Authorization: "Bearer alice", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "bob" }),
  })).status, 400);
  assert.equal((await upload(url, "alice", { outfitId: "123e4567-e89b-42d3-a456-426614174000", category: "Casual" })).status, 400);
  assert.equal((await fetch(`${url}/outfits`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).status, 401);
});
