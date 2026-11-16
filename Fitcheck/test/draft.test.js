const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const { createOutfitStore } = require("../services/outfits");
const { createAnalyzer } = require("../services/gemini");
const {
  InvalidMediaError, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, validateMediaUrl, validateMediaContent,
  resolvePublicIPv4,
} = require("../services/analyzeService");
const { BaseLlm } = require("@google/adk");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb0043", "hex");
const webp = Buffer.from("5249464616000000574542505650384c090000002f0000000007101111", "hex");
const mp3 = Buffer.from("49443304000000000000fffb9000", "hex");
const m4a = Buffer.from("00000018667479704d344120000000004d34412069736f6d", "hex");
const wav = Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex");
const imageUrl = "https://images.example.com/outfit.png";
const audioUrl = "https://audio.example.com/voice.wav";
const analysis = {
  style_category: "Casual", outfit_title: "Everyday", overall_score: 80, summary: "A look",
  color_description: "Blue", primary_colors: ["blue"], strengths: ["Color"], next_direction: "Try a jacket",
  scores: { color_harmony_score: 80, style_matching_score: 80, balance_layering_score: 80, accessories_score: 80 },
};

function fakeFirestore() {
  const records = new Map();
  let running = Promise.resolve();
  const snapshot = (ref) => ({
    id: ref.path.split("/").pop(), ref, exists: records.has(ref.path), data: () => records.get(ref.path),
  });
  const ref = (path) => ({ path, get: async () => snapshot({ path }) });
  const query = (name, field, value, max = 2) => ({
    limit: (n) => query(name, field, value, n),
    get: async () => {
      const docs = [...records.entries()].filter(([path, data]) =>
        path.startsWith(`${name}/`) && data[field] === value).slice(0, max).map(([path]) => snapshot(ref(path)));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const writer = () => {
    const writes = [];
    return {
      writes,
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
    collection: (name) => ({
      doc: (id) => ref(`${name}/${id}`),
      where: (field, operator, value) => {
        assert.equal(operator, "==");
        return query(name, field, value);
      },
    }),
    batch: () => {
      const batch = writer();
      batch.commit = async () => commit(batch.writes);
      return batch;
    },
    runTransaction: async (callback) => {
      const run = running.then(async () => {
        const transaction = writer();
        transaction.get = async (target) => target.get();
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
    name: "private-bucket", files,
    file: (name) => ({
      name,
      save: async (data, options) => {
        assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
        if (files.has(name)) throw Object.assign(new Error("Already exists"), { code: 412 });
        files.set(name, data);
      },
      delete: async () => { files.delete(name); },
    }),
  };
}

async function setup(t, analyze = async () => analysis, fetchMedia = async (_url, label) => ({
  buffer: label === "Image" ? png : wav,
  mimeType: label === "Image" ? "image/png" : "audio/wav",
})) {
  const db = fakeFirestore();
  const bucket = fakeBucket();
  const auth = {
    verifyIdToken: async (token) => {
      if (!["alice", "bob"].includes(token)) throw Object.assign(new Error("invalid"), { code: "auth/invalid-id-token" });
      return { uid: token };
    },
  };
  const server = createApp({ auth, analyze, fetchMedia, store: createOutfitStore(db, bucket) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { db, bucket, url: `http://127.0.0.1:${server.address().port}/api` };
}

function payload(overrides = {}) {
  return { image: imageUrl, outfitName: "Weekend", occasion: "Party", category: "Casual", ...overrides };
}

function post(url, body, token = "alice") {
  return fetch(`${url}/analyze`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url, outfitId, token = "alice", userId = token) {
  return fetch(`${url}/getOutfitAnalysis?userId=${encodeURIComponent(userId)}&outfitId=${encodeURIComponent(outfitId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

test("saves each submission and retrieves its linked analysis with a minimal response", async (t) => {
  let context;
  const { db, bucket, url } = await setup(t, async (input) => { context = input; return analysis; },
    async (_sourceUrl, label) => ({
      buffer: label === "Image" ? png : mp3,
      mimeType: label === "Image" ? "image/png" : "audio/mpeg",
    }));
  const first = await post(url, payload({ audio: audioUrl, occasion: " Date Night ", category: " Formal " }));
  assert.equal(first.status, 201);
  const result = await first.json();
  assert.deepEqual(Object.keys(result).sort(), ["outfitId", "status"]);
  assert.equal(result.status, "success");
  assert.match(result.outfitId, /^[0-9a-f-]{36}$/);
  assert.equal(context.occasion, "Date Night");
  assert.equal(context.category, "Formal");
  assert.deepEqual(context.image, png);
  const second = await post(url, payload({ audio: null }));
  assert.equal(second.status, 201);
  const other = await second.json();
  assert.notEqual(result.outfitId, other.outfitId);
  assert.equal(db.records.size, 8);
  assert.equal(bucket.files.size, 3);

  const details = db.records.get(`fitcheck_outfit_details/${result.outfitId}`);
  assert.equal(details.userId, "alice");
  assert.equal(details.outfitName, "Weekend");
  assert.equal(details.occasion, "Date Night");
  assert.equal(details.category, "Formal");
  assert.equal(details.status, "uploaded");
  assert.ok(details.createdAt instanceof Date);
  const response = await get(url, result.outfitId);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(Object.keys(saved).sort(), ["analysis", "media", "outfit", "scores"]);
  assert.equal(saved.outfit.outfitId, result.outfitId);
  assert.equal(saved.analysis.outfit_id, result.outfitId);
  assert.equal(saved.analysis.user_id, "alice");
  assert.equal(saved.scores.analysis_id, saved.analysis.analysis_id);
  assert.deepEqual(bucket.files.get(saved.media.PhotoStoragePath), png);
  assert.deepEqual(bucket.files.get(saved.media.AudioStoragePath), mp3);
  assert.equal((await get(url, result.outfitId, "bob")).status, 404);
  assert.equal((await get(url, result.outfitId, "bob", "alice")).status, 403);
  assert.equal((await fetch(`${url}/getOutfitAnalysis?userId=alice&outfitId=${result.outfitId}`)).status, 401);
});

test("rejects malformed, unauthorized, and legacy requests before persistence", async (t) => {
  let calls = 0;
  const { db, bucket, url } = await setup(t, async () => { calls++; return analysis; });
  const valid = payload();
  const cases = [
    payload({ image: null }),
    payload({ image: "" }),
    payload({ image: "%%%invalid" }),
    payload({ image: "data:image/png;base64,AA==" }),
    payload({ image: "file:///etc/passwd" }),
    payload({ audio: "data:audio/wav;base64,AA==" }),
    ...["outfitName", "occasion", "category"].flatMap((key) => [
      Object.fromEntries(Object.entries(valid).filter(([field]) => field !== key)),
      payload({ [key]: "   " }),
      payload({ [key]: "x".repeat(101) }),
    ]),
    payload({ outfitId: "client-id" }),
  ];
  for (const body of cases) assert.equal((await post(url, body)).status, 400);
  const multipart = new FormData();
  multipart.append("image", new Blob([png], { type: "image/png" }), "outfit.png");
  assert.equal((await fetch(`${url}/analyze`, {
    method: "POST", headers: { Authorization: "Bearer alice" }, body: multipart,
  })).status, 400);
  assert.equal((await fetch(`${url}/analyze`, {
    method: "POST", headers: { Authorization: "Bearer alice", "Content-Type": "application/json" }, body: "{",
  })).status, 400);
  assert.equal((await fetch(`${url}/analyze`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(calls, 0);
  assert.equal(db.records.size, 0);
  assert.equal(bucket.files.size, 0);
});

test("accepts required text exactly 100 characters", async (t) => {
  const { url } = await setup(t);
  const fields = { outfitName: "x".repeat(100), occasion: "y".repeat(100), category: "z".repeat(100) };
  assert.equal((await post(url, payload(fields))).status, 201);
});

test("takes image and optional audio URLs from req.body and passes occasion/category to analysis", async (t) => {
  const contexts = [];
  const received = [];
  const { db, bucket, url } = await setup(t, async (input) => { contexts.push(input); return analysis; },
    async (sourceUrl, label) => {
      received.push({ sourceUrl, label });
      return { buffer: label === "Image" ? webp : m4a, mimeType: label === "Image" ? "image/webp" : "audio/mp4" };
    });
  const response = await post(url, payload({ image: imageUrl, audio: audioUrl, occasion: "Job Interview", category: "Formal" }));
  assert.equal(response.status, 201);
  const { outfitId } = await response.json();
  assert.deepEqual(received, [{ sourceUrl: imageUrl, label: "Image" }, { sourceUrl: audioUrl, label: "Audio" }]);
  assert.equal(db.records.get(`fitcheck_outfit_details/${outfitId}`).occasion, "Job Interview");
  assert.equal(contexts[0].occasion, "Job Interview");
  assert.equal(contexts[0].category, "Formal");
  const saved = await (await get(url, outfitId)).json();
  assert.deepEqual(bucket.files.get(saved.media.PhotoStoragePath), webp);
  assert.deepEqual(bucket.files.get(saved.media.AudioStoragePath), m4a);
});

test("validates HTTPS URL shape and downloaded media signatures and size", async () => {
  for (const value of ["", "not a URL", "data:image/png;base64,AAAA", "http://example.com/image.png",
    "https://user:pass@example.com/image.png"]) {
    assert.throws(() => validateMediaUrl(value, "Image"), InvalidMediaError);
  }
  await assert.rejects(resolvePublicIPv4("127.0.0.1"), InvalidMediaError);
  await assert.rejects(resolvePublicIPv4("localhost"), InvalidMediaError);
  assert.equal(
    await resolvePublicIPv4("firebasestorage.googleapis.com", async () => ["172.217.115.4"]),
    "172.217.115.4",
    "public IPv4 results should be accepted even when the hostname also has AAAA records"
  );
  await assert.rejects(
    resolvePublicIPv4("image.example.com", async () => ["172.217.115.4", "127.0.0.1"]),
    InvalidMediaError
  );
  assert.equal(validateMediaUrl(imageUrl, "Image").hostname, "images.example.com");
  assert.equal((await validateMediaContent(jpeg, "Image", MAX_IMAGE_BYTES, new Set(["image/jpeg"]), "image/jpeg")).mimeType, "image/jpeg");
  assert.equal((await validateMediaContent(png, "Image", MAX_IMAGE_BYTES, new Set(["image/png"]), "application/octet-stream")).mimeType, "image/png");
  assert.equal((await validateMediaContent(webp, "Image", MAX_IMAGE_BYTES, new Set(["image/webp"]), "image/webp")).mimeType, "image/webp");
  assert.equal((await validateMediaContent(mp3, "Audio", MAX_AUDIO_BYTES, new Set(["audio/mpeg"]), "audio/mpeg")).mimeType, "audio/mpeg");
  assert.equal((await validateMediaContent(wav, "Audio", MAX_AUDIO_BYTES, new Set(["audio/wav"]), "audio/wav")).mimeType, "audio/wav");
  assert.equal((await validateMediaContent(m4a, "Audio", MAX_AUDIO_BYTES, new Set(["audio/mp4"]), "audio/x-m4a")).mimeType, "audio/mp4");
  await assert.rejects(validateMediaContent(Buffer.from("not media"), "Image", MAX_IMAGE_BYTES,
    new Set(["image/png"])), InvalidMediaError);
  await assert.rejects(validateMediaContent(Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]), "Image",
    MAX_IMAGE_BYTES, new Set(["image/png"])), InvalidMediaError);
  await assert.rejects(validateMediaContent(wav, "Audio", MAX_AUDIO_BYTES, new Set(["audio/mpeg"]),
    "audio/wav"), InvalidMediaError);
});

test("rejects downloaded files with unsupported signatures or oversized content before Firebase writes", async (t) => {
  for (const media of [
    { buffer: Buffer.from("not an image"), mimeType: "image/png" },
    { buffer: Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]), mimeType: "image/png" },
  ]) {
    const { db, bucket, url } = await setup(t, async () => analysis, async () => media);
    const response = await post(url, payload());
    assert.equal(response.status, 400);
    assert.equal(db.records.size, 0);
    assert.equal(bucket.files.size, 0);
  }
});

test("passes occasion and category to the Gemini model as context", async () => {
  let request;
  class FakeModel extends BaseLlm {
    async *generateContentAsync(input) {
      request = input;
      yield { content: { role: "model", parts: [{ text: JSON.stringify(analysis) }] } };
    }
  }
  const analyze = createAnalyzer("fake", "unused", new FakeModel({ model: "fake" }));
  const result = await analyze({
    image: png, mimeType: "image/png", userId: "alice", occasion: "Job Interview", category: "Formal",
  });
  assert.deepEqual(result, analysis);
  const parts = request.contents.flatMap((content) => content.parts || []);
  const text = parts.find((part) => part.text?.includes("Outfit context:")).text;
  assert.ok(text.includes('"occasion":"Job Interview"'));
  assert.ok(text.includes('"category":"Formal"'));
  assert.equal(parts.find((part) => part.inlineData).inlineData.data, png.toString("base64"));
});

test("persists pending submission before analysis, then completes it", async (t) => {
  let start;
  let finish;
  const started = new Promise((resolve) => { start = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const { db, bucket, url } = await setup(t, async () => { start(); await waiting; return analysis; });
  const request = post(url, payload());
  await started;
  const [path, details] = [...db.records.entries()].find(([key]) => key.startsWith("fitcheck_outfit_details/"));
  const id = path.split("/")[1];
  assert.equal(details.status, "pending");
  assert.equal(bucket.files.size, 1);
  const pending = await get(url, id);
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: "pending", outfitId: id });
  finish();
  const response = await request;
  assert.equal(response.status, 201);
  assert.equal((await response.json()).outfitId, id);
  assert.equal(db.records.size, 4);
});

test("exposes failed status and no partial analysis when AI fails", async (t) => {
  const { db, bucket, url } = await setup(t, async () => { throw new Error("AI unavailable"); });
  const response = await post(url, payload());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error" });
  const [path] = [...db.records.entries()].find(([key]) => key.startsWith("fitcheck_outfit_details/"));
  const id = path.split("/")[1];
  assert.equal(db.records.size, 2);
  assert.equal(bucket.files.size, 1);
  const failed = await get(url, id);
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { status: "failed", outfitId: id });
  assert.equal((await get(url, "missing")).status, 404);
});

test("reports persistence errors and retains files on uncertain commit outcomes", async (t) => {
  const { db, bucket, url } = await setup(t);
  db.batch = () => ({
    create() {},
    async commit() { throw new Error("Database unavailable"); },
  });
  const response = await post(url, payload());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error" });
  assert.equal(bucket.files.size, 1);
});

test("cleans up confirmed uploads and retains an uncertain failed object when storage fails", async (t) => {
  const { db, bucket, url } = await setup(t);
  const original = bucket.file;
  bucket.file = (name) => {
    const file = original(name);
    return { ...file, save: async (data, options) => {
      await file.save(data, options);
      if (name.includes("/audio/")) throw new Error("Storage unavailable");
    } };
  };
  assert.equal((await post(url, payload({ audio: audioUrl }))).status, 500);
  assert.equal(db.records.size, 0);
  assert.equal(bucket.files.size, 1);
  assert.ok([...bucket.files.keys()][0].includes("/audio/"));
});
