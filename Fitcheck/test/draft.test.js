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

async function setup(
  t,
  analyze = async () => analysis,
  fetchImage = async () => ({ buffer: png, mimeType: "image/png" })
) {
  const db = fakeFirestore();
  const bucket = fakeBucket();
  const auth = {
    verifyIdToken: async (token) => {
      if (!["alice", "bob"].includes(token)) throw Object.assign(new Error("invalid"), { code: "auth/invalid-id-token" });
      return { uid: token };
    },
  };
  const server = createApp({
    auth,
    analyze,
    fetchImage,
    store: createOutfitStore(db, bucket),
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { db, bucket, url: `http://127.0.0.1:${server.address().port}/api` };
}

async function createDraftDirectly(db, bucket, userId = "alice") {
  return createOutfitStore(db, bucket).createDraft({
    userId,
    outfitName: "Weekend",
    occasion: "Party",
    category: "Casual",
  });
}

async function upload(url, token, fields = {}) {
  return fetch(`${url}/analyze`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image: "https://example.com/outfit.jpg",
      audio: "",
      outfitName: "Weekend look",
      occasion: "wedding",
      category: "Casual",
      ...fields,
    }),
  });
}

test("analyzes the JSON image URL and stores analysis with the original media URLs", async (t) => {
  const imageUrl = "https://example.com/outfit.jpg";
  const audioUrl = "https://example.com/voice-note.mp3";
  let analyzedImage;
  const { db, bucket, url } = await setup(
    t,
    async (input) => {
      analyzedImage = input;
      return analysis;
    },
    async (inputUrl) => {
      assert.equal(inputUrl, imageUrl);
      return { buffer: png, mimeType: "image/png" };
    }
  );
  const response = await upload(url, "alice", {
    image: imageUrl,
    audio: audioUrl,
    outfitName: "Weekend look",
    occasion: "wedding",
    category: "Casual",
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  const { outfit, media } = result;
  assert.equal(outfit.userId, "alice");
  assert.equal(outfit.outfitName, "Weekend look");
  assert.equal(outfit.occasion, "wedding");
  assert.equal(outfit.category, "Casual");
  assert.equal(media.PhotoUrl, imageUrl);
  assert.equal(media.AudioUrl, audioUrl);
  assert.equal(media.PhotoStoragePath, "");
  assert.equal(media.AudioStoragePath, "");
  assert.equal(result.analysis.image_url, imageUrl);
  assert.equal(result.analysis.summary, analysis.summary);
  assert.equal(result.scores.color_harmony_score, analysis.scores.color_harmony_score);
  assert.equal(analyzedImage.mimeType, "image/png");
  assert.deepEqual(analyzedImage.image, png);
  assert.equal(bucket.files.size, 0);
  assert.equal(db.records.size, 4);
  assert.equal(
    [...db.records.keys()].filter((path) => path.startsWith("fitcheck_outfit_analysis/")).length,
    1
  );
  assert.equal(
    [...db.records.keys()].filter((path) => path.startsWith("fitcheck_outfit_analysis_scores/")).length,
    1
  );

  const minimalResponse = await upload(url, "alice");
  assert.equal(minimalResponse.status, 201);
  const minimalResult = await minimalResponse.json();
  assert.equal(minimalResult.media.AudioUrl, "");
});

test("requires JSON input and Firebase authentication", async (t) => {
  const { url } = await setup(t);
  for (const field of ["image", "outfitName", "occasion", "category"]) {
    const body = {
      image: "https://example.com/outfit.jpg",
      outfitName: "Weekend look",
      occasion: "wedding",
      category: "Casual",
    };
    delete body[field];
    const response = await fetch(`${url}/analyze`, {
      method: "POST",
      headers: {
        Authorization: "Bearer alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await upload(url, "alice", { image: "" })).status, 400);

  const multipart = await fetch(`${url}/analyze`, {
    method: "POST",
    headers: {
      Authorization: "Bearer alice",
      "Content-Type": "multipart/form-data",
    },
    body: "",
  });
  assert.equal(multipart.status, 415);

  const unauthenticated = await fetch(`${url}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "https://example.com/outfit.jpg" }),
  });
  assert.equal(unauthenticated.status, 401);
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

test("rejects unknown analyze fields and keeps the draft endpoint removed", async (t) => {
  const { db, url } = await setup(t);
  assert.equal((await upload(url, "alice", { unexpected: "value" })).status, 400);
  const removedEndpoint = await fetch(`${url}/outfits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outfitName: "Weekend" }),
  });
  assert.equal(removedEndpoint.status, 404);
  assert.equal(db.records.size, 0);
});
