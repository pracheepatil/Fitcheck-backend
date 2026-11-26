const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");

const REQUEST_ID_HEADER = "x-request-id";
const requestContext = new AsyncLocalStorage();
const CLOUD_LOG_SEVERITIES = new Set([
  "DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY",
]);
const ANALYZE_LIFECYCLE_STEPS = Object.freeze({
  request_received: 1,
  request_payload_received: 2,
  image_download_started: 3,
  image_download_completed: 3,
  image_download_failed: 3,
  audio_download_started: 4,
  audio_download_completed: 4,
  audio_download_failed: 4,
  audio_skipped: 4,
  submission_creation_started: 5,
  submission_created: 5,
  submission_creation_failed: 5,
  gemini_analysis_started: 6,
  gemini_analysis_completed: 6,
  gemini_analysis_failed: 6,
  firestore_analysis_complete_started: 7,
  firestore_analysis_completed: 7,
  firestore_analysis_complete_failed: 7,
  analysis_failure_status_update_started: 8,
  analysis_failure_status_update_completed: 8,
  analysis_failure_status_update_failed: 8,
  analysis_failed: 6,
  request_completed: 9,
  request_failed: 9,
});

function getAnalyzeLifecycleStepNumber(stage) {
  const stepNumber = ANALYZE_LIFECYCLE_STEPS[stage];
  if (stepNumber === undefined) {
    throw new Error(`Unknown analyze lifecycle stage: ${stage}`);
  }
  return stepNumber;
}

function getRequestId() {
  return requestContext.getStore()?.requestId;
}

function runWithRequestContext(requestId, fn) {
  return requestContext.run({ requestId }, fn);
}

async function writeLogSafely(logger, entry) {
  try {
    await logger?.write(entry);
  } catch (error) {
    try {
      console.error("Log write failed:", error?.message || error);
    } catch {}
  }
}

function createLogger({ projectId, logName = "fitcheck", writeEntry, cloudLog: suppliedCloudLog } = {}) {
  let cloudLog = suppliedCloudLog;
  if (!writeEntry && !cloudLog && projectId) {
    const { Logging } = require("@google-cloud/logging");
    cloudLog = new Logging({ projectId }).log(logName);
  }

  async function write(entry) {
    const { resource, ...entryPayload } = entry;
    const payload = {
      timestamp: new Date().toISOString(),
      requestId: entry.requestId ?? getRequestId(),
      ...entryPayload,
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
        await cloudLog.write(cloudLog.entry({
          severity,
          ...(resource ? { resource } : {}),
        }, payload));
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
      await writeLogSafely({ write }, {
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
      await writeLogSafely({ write }, {
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
      const routePath = req.route?.path
        ? `${req.baseUrl || ""}${req.route.path}`
        : req.path;
      const severity = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARNING" : "INFO";
      logger.write({
        logType: "http_request",
        requestId,
        severity,
        method: req.method,
        path: (req.originalUrl || req.url).split("?")[0],
        route: routePath,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        responseBytes: Number(res.getHeader("content-length")) || 0,
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

function validateFrontendLog(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  if (typeof body.event !== "string" || !body.event.trim()) return "event is required";
  if (body.event.length > 100) return "event is too long";
  if (body.level !== undefined &&
      (typeof body.level !== "string" || !CLOUD_LOG_SEVERITIES.has(body.level.trim().toUpperCase()))) {
    return "level must be a valid Cloud Logging severity";
  }
  if (body.url !== undefined && (typeof body.url !== "string" || body.url.length > 2_048)) {
    return "url must be a string of at most 2048 characters";
  }
  if (body.timestamp !== undefined &&
      (typeof body.timestamp !== "string" || Number.isNaN(Date.parse(body.timestamp)))) {
    return "timestamp must be a valid date string";
  }
  if (body.details !== undefined && JSON.stringify(body.details).length > 10_000) {
    return "details is too long";
  }
  return null;
}

function createFrontendLogsHandler(logger) {
  return async (req, res) => {
    const validationError = validateFrontendLog(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const { event, details, url, timestamp } = req.body;
    const severity = (req.body.level || "INFO").trim().toUpperCase();
    try {
      await logger.write({
        logType: "frontend_log",
        source: "ReactJS-Frontend",
        severity,
        event: event.trim(),
        details,
        url: url?.trim(),
        clientTimestamp: timestamp,
      });
      return res.status(200).json({ status: "logged" });
    } catch (error) {
      console.error("Failed to write frontend log:", error);
      return res.status(500).json({ error: "Logging failed" });
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
  createFrontendLogsHandler,
  validateFrontendLog,
  getAnalyzeLifecycleStepNumber,
  writeLogSafely,
};