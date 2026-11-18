const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const { createOutfitStore } = require("../services/outfits");
const { createAnalyzer } = require("../services/gemini");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const {
  InvalidMediaError, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, validateMediaUrl, validateMediaContent,
  resolvePublicIPv4, downloadMedia,
} = require("../services/analyzeService");

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb0043", "hex");
const webp = Buffer.from("5249464616000000574542505650384c090000002f0000000007101111", "hex");
const mp3 = Buffer.from("49443304000000000000fffb9000", "hex");
const m4a = Buffer.from("00000018667479704d344120000000004d34412069736f6d", "hex");
const wav = Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex");
const webm = Buffer.from("1a45dfa38b4282847765626d42878101", "hex");
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
      getMetadata: async () => {
        if (!files.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
        return [{ size: files.get(name).length, generation: "1" }];
      },
      download: async () => {
        if (!files.has(name)) throw Object.assign(new Error("not found"), { code: 404 });
        return [files.get(name)];
      },
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
  assert.equal(context.outfitName, "Weekend");
  assert.deepEqual(context.image, png);
  assert.deepEqual(context.audio, { buffer: mp3, mimeType: "audio/mpeg" });
  const second = await post(url, payload({ audio: null }));
  assert.equal(second.status, 201);
  assert.equal(context.audio, undefined);
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
  const analysisPath = [...db.records.keys()].find((key) =>
    key.startsWith("fitcheck_outfit_analysis/") &&
    db.records.get(key).outfit_id === result.outfitId
  );
  const storedImageUrl = "https://firebasestorage.googleapis.com/stored-image-url";
  db.records.set(analysisPath, { ...db.records.get(analysisPath), image_url: storedImageUrl });
  const response = await get(url, result.outfitId);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(Object.keys(saved).sort(), ["analysis", "media", "outfit", "scores"]);
  assert.equal(saved.outfit.outfitId, result.outfitId);
  assert.equal(Object.hasOwn(saved.outfit, "analysis"), false);
  assert.equal(saved.analysis.outfit_id, result.outfitId);
  assert.equal(saved.analysis.user_id, "alice");
  assert.equal(saved.scores.analysis_id, saved.analysis.analysis_id);
  assert.equal(saved.analysis.image_url, storedImageUrl);
  assert.deepEqual(bucket.files.get(saved.media.PhotoStoragePath), png);
  assert.deepEqual(bucket.files.get(saved.media.AudioStoragePath), mp3);
  assert.equal(saved.media.PhotoUrl, `/api/outfits/${result.outfitId}/photo`);
  assert.equal(db.records.get(analysisPath).image_url, saved.analysis.image_url);
  const photoUrl = `${url.replace(/\/api$/, "")}${saved.media.PhotoUrl}`;
  assert.equal((await fetch(photoUrl)).status, 401);
  assert.equal((await fetch(photoUrl, { headers: { Authorization: "Bearer bob" } })).status, 404);
  const photo = await fetch(photoUrl, { headers: { Authorization: "Bearer alice" } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal(photo.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
  bucket.files.delete(saved.media.PhotoStoragePath);
  assert.equal((await fetch(photoUrl, { headers: { Authorization: "Bearer alice" } })).status, 404);
  const mediaKey = `fitcheck_outfit_media/${saved.media.mediaId}`;
  db.records.set(mediaKey, { ...db.records.get(mediaKey), PhotoStoragePath: "outfits/someone-else/photo.png" });
  assert.equal((await fetch(photoUrl, { headers: { Authorization: "Bearer alice" } })).status, 404);
  assert.equal((await get(url, result.outfitId, "bob")).status, 404);
  assert.equal((await get(url, result.outfitId, "bob", "alice")).status, 403);
  assert.equal((await fetch(`${url}/getOutfitAnalysis?userId=alice&outfitId=${result.outfitId}`)).status, 401);
});

test("downloads and stores a WebM voice note sent with audio/webm", async (t) => {
  const audioTypes = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/webm"]);
  let accept;
  t.mock.method(https, "get", (_url, options, callback) => {
    accept = options.headers.Accept;
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) request.emit("error", error); };
    process.nextTick(() => {
      const response = Readable.from([webm]);
      response.statusCode = 200;
      response.headers = { "content-type": "audio/webm; codecs=opus" };
      callback(response);
    });
    return request;
  });
  const media = await downloadMedia("https://8.8.8.8/voice.webm", "Audio", MAX_AUDIO_BYTES, audioTypes);
  assert.ok(accept.includes("audio/webm"));
  const { db, bucket, url } = await setup(t, async () => analysis, async (_sourceUrl, label) =>
    label === "Image" ? { buffer: png, contentType: "image/png" } : media);
  const response = await post(url, payload({ audio: "https://8.8.8.8/voice.webm" }));
  assert.equal(response.status, 201);
  const { outfitId } = await response.json();
  const saved = await (await get(url, outfitId)).json();
  assert.ok(saved.media.AudioStoragePath.endsWith(".webm"));
  assert.deepEqual(bucket.files.get(saved.media.AudioStoragePath), webm);
  assert.equal(db.records.size, 4);
  await assert.rejects(validateMediaContent(png, "Audio", MAX_AUDIO_BYTES, audioTypes, "audio/webm"), InvalidMediaError);
  await assert.rejects(validateMediaContent(webm, "Audio", MAX_AUDIO_BYTES, audioTypes, "audio/mpeg"), InvalidMediaError);
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

test("keeps analysis results associated with each submission's occasion and category", async (t) => {
  const { url } = await setup(t, async ({ occasion, category }) => ({
    ...analysis, summary: `${occasion} / ${category}`,
  }));
  const first = await (await post(url, payload({ occasion: "Party", category: "Casual" }))).json();
  const second = await (await post(url, payload({ occasion: "Office", category: "Formal" }))).json();
  assert.notEqual(first.outfitId, second.outfitId);
  const firstResult = await (await get(url, first.outfitId)).json();
  const secondResult = await (await get(url, second.outfitId)).json();
  assert.equal(firstResult.outfit.occasion, "Party");
  assert.equal(firstResult.analysis.summary, "Party / Casual");
  assert.equal(secondResult.outfit.occasion, "Office");
  assert.equal(secondResult.analysis.summary, "Office / Formal");
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
  const requests = [];
  const fakeGemini = {
    models: {
      generateContent: async (input) => {
        requests.push(input);
        return { text: JSON.stringify(analysis) };
      },
    },
    files: {},
  };
  const analyze = createAnalyzer("fake", "unused", fakeGemini);
  const result = await analyze({
    image: png, mimeType: "image/png", userId: "alice", outfitName: "Blue blazer",
    occasion: "Job Interview", category: "Formal", audio: { buffer: webm, mimeType: "audio/webm" },
  });
  assert.deepEqual(result, analysis);
  assert.equal(requests[0].model, "fake");
  assert.equal(requests[0].config.responseMimeType, "application/json");
  assert.match(requests[0].config.systemInstruction, /occasion.*PRIMARY/);
  assert.match(requests[0].config.systemInstruction, /category.*SECONDARY/);
  assert.match(requests[0].config.systemInstruction, /do not\s+assume a specific venue/i);
  assert.match(requests[0].config.systemInstruction, /If no outfit\s+is visible/);
  await analyze({
    image: png, mimeType: "image/png", userId: "alice", outfitName: "Weekend look",
    occasion: "Party", category: "Casual",
  });
  const parts = requests[0].contents.flatMap((content) => content.parts || []);
  const text = parts.find((part) => part.text?.includes("Outfit context:")).text;
  assert.ok(text.includes('"outfitName":"Blue blazer"'));
  assert.ok(text.includes('"occasion":"Job Interview"'));
  assert.ok(text.includes('"category":"Formal"'));
  assert.equal(parts.find((part) => part.inlineData).inlineData.data, png.toString("base64"));
  const audioPart = parts.find((part) => part.inlineData?.mimeType === "audio/webm");
  assert.equal(audioPart.inlineData.data, webm.toString("base64"));
  const secondText = requests[1].contents.flatMap((content) => content.parts || [])
    .find((part) => part.text?.includes("Outfit context:")).text;
  assert.ok(secondText.includes('"outfitName":"Weekend look"'));
  assert.ok(secondText.includes('"occasion":"Party"'));
  assert.ok(secondText.includes('"category":"Casual"'));
  const secondParts = requests[1].contents.flatMap((content) => content.parts || []);
  assert.equal(secondParts.filter((part) => part.inlineData).length, 1);
  await analyze({
    image: png, mimeType: "image/png", userId: "alice",
    audio: { buffer: m4a, mimeType: "audio/mp4" },
  });
  const thirdParts = requests[2].contents.flatMap((content) => content.parts || []);
  assert.deepEqual(thirdParts.find((part) => part.inlineData?.mimeType === "audio/m4a").inlineData, {
    mimeType: "audio/m4a", data: m4a.toString("base64"),
  });
});

test("uploads large audio to Gemini and removes the temporary file", async () => {
  const requests = [];
  const deleted = [];
  let uploaded;
  const fakeGemini = {
    files: {
      upload: async (input) => {
        uploaded = input;
        return { name: "files/test", uri: "https://example.test/file", state: "ACTIVE" };
      },
      delete: async ({ name }) => deleted.push(name),
    },
    models: {
      generateContent: async (input) => {
        requests.push(input);
        return { text: JSON.stringify(analysis) };
      },
    },
  };
  const analyze = createAnalyzer("fake", "unused", fakeGemini);
  const audio = { buffer: Buffer.alloc(14 * 1024 * 1024), mimeType: "audio/mp4" };
  await analyze({ image: png, mimeType: "image/png", userId: "alice", audio });
  assert.equal(uploaded.file.size, audio.buffer.length);
  assert.equal(uploaded.config.mimeType, "audio/m4a");
  const parts = requests[0].contents.flatMap((content) => content.parts || []);
  assert.deepEqual(parts.find((part) => part.fileData).fileData, {
    mimeType: "audio/m4a", fileUri: "https://example.test/file",
  });
  assert.deepEqual(deleted, ["files/test"]);
});

test("cleans up large audio and propagates upload processing or model failures", async () => {
  const audio = { buffer: Buffer.alloc(14 * 1024 * 1024), mimeType: "audio/mpeg" };
  for (const state of ["FAILED", "ACTIVE"]) {
    const deleted = [];
    const fakeGemini = {
      files: {
        upload: async () => ({ name: "files/test", uri: "https://example.test/file", state }),
        delete: async ({ name }) => deleted.push(name),
      },
      models: {
        generateContent: async () => {
          throw new Error("model unavailable");
        },
      },
    };
    const analyze = createAnalyzer("fake", "unused", fakeGemini);
    await assert.rejects(
      analyze({ image: png, mimeType: "image/png", userId: "alice", audio }),
      state === "FAILED" ? /did not become ready/ : /Gemini analysis failed/,
    );
    assert.deepEqual(deleted, ["files/test"]);
  }
});

test("ADK validates and normalizes direct Gemini JSON before returning analysis", async () => {
  const fakeGemini = {
    files: {},
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          ...analysis,
          style_category: "  Casual ",
          primary_colors: [" blue "],
        }),
      }),
    },
  };
  const result = await createAnalyzer("fake", "unused", fakeGemini)({
    image: png,
    mimeType: "image/png",
    userId: "alice",
  });
  assert.equal(result.style_category, "Casual");
  assert.deepEqual(result.primary_colors, ["blue"]);

  const invalidGemini = {
    files: {},
    models: { generateContent: async () => ({ text: JSON.stringify({ ...analysis, overall_score: 101 }) }) },
  };
  await assert.rejects(
    createAnalyzer("fake", "unused", invalidGemini)({
      image: png,
      mimeType: "image/png",
      userId: "alice",
    }),
    /ADK feedback validation failed/
  );
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
