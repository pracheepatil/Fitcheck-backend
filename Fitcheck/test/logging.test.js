const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const {
  createLogger,
  createClientLogsHandler,
  validateClientLog,
  runWithRequestContext,
} = require("../services/logging");

test("validateClientLog accepts required fields", () => {
  assert.equal(validateClientLog(null), "Request body must be a JSON object");
  assert.equal(validateClientLog({ event: "", message: "x", requestId: "id", page: "/" }), "event is required");
  assert.equal(
    validateClientLog({ event: "click", message: "ok", requestId: "req-1", page: "/home" }),
    null,
  );
});

test("request logging assigns and echoes X-Request-Id", async (t) => {
  const entries = [];
  const logger = createLogger({
    writeEntry: async ({ payload }) => entries.push(payload),
  });
  const server = createApp({ auth: {}, analyze: async () => ({}), store: {}, logger }, { apiRoutes: [] })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const withoutHeader = await fetch(`${base}/api/health`);
  const generatedId = withoutHeader.headers.get("x-request-id");
  assert.match(generatedId, /^[0-9a-f-]{36}$/i);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const httpLog = entries.find((entry) => entry.logType === "http_request" && entry.path === "/api/health");
  assert.equal(httpLog?.requestId, generatedId);
  assert.equal(httpLog?.method, "GET");
  assert.equal(httpLog?.statusCode, 200);

  const suppliedId = "client-supplied-request-id";
  const withHeader = await fetch(`${base}/api/health`, { headers: { "X-Request-Id": suppliedId } });
  assert.equal(withHeader.headers.get("x-request-id"), suppliedId);
});

test("POST /api/client-logs writes frontend entries and returns 204", async (t) => {
  const entries = [];
  const logger = createLogger({
    writeEntry: async ({ payload }) => entries.push(payload),
  });
  const server = createApp({ auth: {}, analyze: async () => ({}), store: {}, logger }, { apiRoutes: [] })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const bad = await fetch(`${base}/api/client-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "click", message: "ok", requestId: "", page: "/home" }),
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${base}/api/client-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": "trace-abc" },
    body: JSON.stringify({
      event: "button_click",
      message: "User tapped analyze",
      requestId: "trace-abc",
      page: "/analyze",
    }),
  });
  assert.equal(good.status, 204);
  const clientLog = entries.find((entry) => entry.logType === "client_log");
  assert.equal(clientLog?.event, "button_click");
  assert.equal(clientLog?.requestId, "trace-abc");
});

test("logServiceCall records Gemini duration and errors", async () => {
  const entries = [];
  const logger = createLogger({
    writeEntry: async ({ payload }) => entries.push(payload),
  });
  await runWithRequestContext("req-gemini", async () => {
    const value = await logger.logServiceCall("Gemini", "generateContent", async () => "ok");
    assert.equal(value, "ok");
  });
  assert.equal(entries[0].service, "Gemini");
  assert.equal(entries[0].status, "ok");
  assert.equal(entries[0].requestId, "req-gemini");
  assert.ok(entries[0].durationMs >= 0);

  await assert.rejects(
    () => runWithRequestContext("req-gemini", () => logger.logServiceCall("Gemini", "generateContent", async () => {
      throw new Error("boom");
    })),
    /boom/,
  );
  assert.equal(entries[1].status, "error");
  assert.equal(entries[1].error, "boom");
});

test("createClientLogsHandler rejects invalid payload before writing", async () => {
  const entries = [];
  const logger = createLogger({
    writeEntry: async ({ payload }) => entries.push(payload),
  });
  const handler = createClientLogsHandler(logger);
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
  await handler({ body: { event: "x", message: "y", requestId: "id", page: "" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(entries.length, 0);
});