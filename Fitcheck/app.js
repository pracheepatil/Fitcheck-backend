const express = require("express");
const { createFitcheckRouter } = require("./routes/fitcheckRoutes");
const { createLogger, createRequestLoggingMiddleware, createClientLogsHandler, createFrontendLogsHandler } = require("./services/logging");

function createApp(dependencies, { apiRoutes = [], logger, frontendLogger } = {}) {
  const activeLogger = logger || dependencies.logger ||
    createLogger({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const activeFrontendLogger = frontendLogger || dependencies.frontendLogger ||
    createLogger({ projectId: process.env.GOOGLE_CLOUD_PROJECT, logName: "react-frontend-logs" });
  const app = express();
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Expose-Headers", "X-Request-Id");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id");
      return res.sendStatus(204);
    }
    return next();
  });
  app.use(createRequestLoggingMiddleware(activeLogger));
  app.use("/api", createFitcheckRouter(dependencies));
  const { analyzeOutfit, getAnalysis } = require("./controllers/analyzeController").createAnalyzeController(dependencies);
  app.post("/analyze", analyzeOutfit);
  app.get("/getOutfitAnalysis", getAnalysis);
  app.use("/api", express.json());
  app.post("/api/client-logs", createClientLogsHandler(activeLogger));
  app.post("/api/log-frontend", createFrontendLogsHandler(activeFrontendLogger));
  for (const [path, router] of apiRoutes) app.use(path, router);
  app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "FitCheck backend is running" });
  });
  app.use((err, req, res, next) => {
    console.error("Request failed:", {
      errorName: err?.name || "Error",
      statusCode: err?.statusCode || 500,
    });
    if (res.headersSent) return next(err);
    activeLogger.write({
      logType: "http_error",
      severity: "ERROR",
      method: req.method,
      path: req.path,
      route: req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.path,
      statusCode: 500,
      errorName: err?.name || "Error",
    }).catch((loggingError) => console.error("Failed to write request error log:", loggingError));
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
if (require.main === module) {
  try {
    require("dotenv/config");
    const { createDependencies } = require("./services/config");
    const dependencies = createDependencies(process.env);
    const apiRoutes = [
      ["/api/auth", require("./routes/authRoutes")],
      ["/api/profile", require("./routes/profileRoutes")],
      ["/api", require("./routes/firebaseTestRoutes")],
    ];
    const app = createApp(dependencies, { apiRoutes });
    const port = process.env.PORT || 5001;
    app.listen(port, "0.0.0.0", () => console.log(`Server running on port ${port}`));
  } catch (error) {
    console.error("Server configuration error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp };