const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const {
  createLogger,
  createClientLogsHandler,
  validateClientLog,
  validateFrontendLog,
  runWithRequestContext,
  getAnalyzeLifecycleStepNumber,
} = require("../services/logging");

test("validateClientLog accepts required fields", () => {
  assert.equal(validateClientLog(null), "Request body must be a JSON object");
  assert.equal(validateClientLog({ event: "", message: "x", requestId: "id", page: "/" }), "event is required");
  assert.equal(
    validateClientLog({ event: "click", message: "ok", requestId: "req-1", page: "/home" }),
    null,
  );
});

test("validateFrontendLog validates Cloud Logging payloads", () => {
  assert.equal(validateFrontendLog({ event: "page_loaded", level: "warning", url: "/home" }), null);
  assert.equal(validateFrontendLog({ event: "page_loaded", level: "unknown" }), "level must be a valid Cloud Logging severity");
});

test("analyze lifecycle stages have stable sequential step numbers", () => {
  assert.equal(getAnalyzeLifecycleStepNumber("request_received"), 1);
  assert.equal(getAnalyzeLifecycleStepNumber("request_payload_received"), 2);
  assert.equal(getAnalyzeLifecycleStepNumber("gemini_analysis_started"), 6);
  assert.equal(getAnalyzeLifecycleStepNumber("firestore_analysis_completed"), 7);
  assert.equal(getAnalyzeLifecycleStepNumber("request_completed"), 9);
  assert.throws(
    () => getAnalyzeLifecycleStepNumber("unknown_stage"),
    /Unknown analyze lifecycle stage/,
  );
});

test("Cloud Logging receives severity as metadata and the payload as JSON data", async () => {
  const entries = [];
  const cloudLog = {
    entry(metadata, data) {
      return { metadata, data };
    },
    async write(entry) {
      entries.push(entry);
    },
  };
  const logger = createLogger({ cloudLog });

  await logger.write({
    logType: "frontend_log",
    severity: "WARNING",
    event: "api_failure",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].metadata.severity, "WARNING");
  assert.equal(entries[0].data.logType, "frontend_log");
  assert.equal(entries[0].data.event, "api_failure");
  assert.equal("resource" in entries[0].data, false);
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
  assert.equal(httpLog?.severity, "INFO");

  const notFound = await fetch(`${base}/missing?token=do-not-log`);
  assert.equal(notFound.status, 404);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const notFoundLog = entries.find((entry) => entry.logType === "http_request" && entry.statusCode === 404);
  assert.equal(notFoundLog?.path, "/missing");
  assert.equal(notFoundLog?.severity, "WARNING");

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

test("POST /api/log-frontend writes a React frontend log and returns 200", async (t) => {
  const entries = [];
  const logger = createLogger({
    writeEntry: async ({ payload }) => entries.push(payload),
  });
  const server = createApp(
    { auth: {}, analyze: async () => ({}), store: {}, logger },
    { apiRoutes: [], frontendLogger: logger },
  ).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/log-frontend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      level: "WARNING",
      event: "api_failure",
      details: { status: 502 },
      url: "/outfits",
      timestamp: "2026-11-25T12:00:00.000Z",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "logged" });
  const frontendLog = entries.find((entry) => entry.logType === "frontend_log");
  assert.equal(frontendLog?.severity, "WARNING");
  assert.equal(frontendLog?.source, "ReactJS-Frontend");
  assert.deepEqual(frontendLog?.details, { status: 502 });
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

test("logServiceCall does not let failed log writes affect the service result", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const logger = createLogger({
      writeEntry: async () => {
        throw new Error("logging unavailable");
      },
    });

    assert.equal(
      await logger.logServiceCall("Gemini", "generateContent", async () => "ok"),
      "ok",
    );
    await assert.rejects(
      () => logger.logServiceCall("Gemini", "generateContent", async () => {
        throw new Error("Gemini failed");
      }),
      /Gemini failed/,
    );
  } finally {
    console.error = originalError;
  }
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
