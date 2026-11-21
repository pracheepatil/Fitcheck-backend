const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");

const REQUEST_ID_HEADER = "x-request-id";
const requestContext = new AsyncLocalStorage();

function getRequestId() {
  return requestContext.getStore()?.requestId;
}

function runWithRequestContext(requestId, fn) {
  return requestContext.run({ requestId }, fn);
}

function createLogger({ projectId, logName = "fitcheck", writeEntry } = {}) {
  let cloudLog;
  if (!writeEntry && projectId) {
    try {
      const { Logging } = require("@google-cloud/logging");
      cloudLog = new Logging({ projectId }).log(logName);
    } catch {
      cloudLog = null;
    }
  }

  async function write(entry) {
    const payload = {
      timestamp: new Date().toISOString(),
      requestId: entry.requestId ?? getRequestId(),
      ...entry,
    };
    const severity = entry.severity || "INFO";
    const writeStdout = () => {
      const line = JSON.stringify({ severity, ...payload });
      if (severity === "ERROR") console.error(line);
      else console.log(line);
    };
    if (writeEntry) {
      await writeEntry({ severity, payload });
      return;
    }
    if (cloudLog) {
      try {
        await cloudLog.write(cloudLog.entry({ severity, jsonPayload: payload }));
        return;
      } catch (error) {
        console.error("Cloud Logging write failed, falling back to stdout:", error.message);
      }
    }
    writeStdout();
  }

  async function logServiceCall(service, operation, fn, details = {}) {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const result = await fn();
      await write({
        logType: "service_call",
        service,
        operation,
        ...details,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        status: "ok",
      });
      return result;
    } catch (error) {
      await write({
        logType: "service_call",
        service,
        operation,
        ...details,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        status: "error",
        error: error?.message || String(error),
        severity: "ERROR",
      });
      throw error;
    }
  }

  return { write, logServiceCall, REQUEST_ID_HEADER };
}

function createRequestLoggingMiddleware(logger) {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId = typeof incoming === "string" && incoming.trim() ? incoming.trim() : crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const start = Date.now();
    res.on("finish", () => {
      logger.write({
        logType: "http_request",
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
      }).catch((error) => console.error("Failed to write request log:", error));
    });
    runWithRequestContext(requestId, () => next());
  };
}

function validateClientLog(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  for (const [field, maxLength] of [
    ["event", 100],
    ["message", 4000],
    ["requestId", 128],
    ["page", 500],
  ]) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) return `${field} is required`;
    if (value.length > maxLength) return `${field} is too long`;
  }
  return null;
}

function createClientLogsHandler(logger) {
  return async (req, res) => {
    const validationError = validateClientLog(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const { event, message, requestId, page } = req.body;
    try {
      await logger.write({
        logType: "client_log",
        source: "frontend",
        event: event.trim(),
        message: message.trim(),
        requestId: requestId.trim(),
        page: page.trim(),
      });
      return res.sendStatus(204);
    } catch (error) {
      console.error("Failed to write client log:", error);
      return res.status(500).json({ error: "Failed to write log entry" });
    }
  };
}

module.exports = {
  REQUEST_ID_HEADER,
  createLogger,
  createRequestLoggingMiddleware,
  createClientLogsHandler,
  getRequestId,
  runWithRequestContext,
  validateClientLog,
};