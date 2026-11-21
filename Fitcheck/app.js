const express = require("express");
const { createFitcheckRouter } = require("./routes/fitcheckRoutes");
const { createLogger, createRequestLoggingMiddleware, createClientLogsHandler } = require("./services/logging");

function createApp(dependencies, { apiRoutes = [], allowedOrigins = [], logger } = {}) {
  const activeLogger = logger || dependencies.logger ||
    createLogger({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    if (origin && allowedOrigins.length) {
      res.vary("Origin");
      res.set("Access-Control-Allow-Origin", origin);
    } else {
      res.set("Access-Control-Allow-Origin", "*");
    }
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
  for (const [path, router] of apiRoutes) app.use(path, router);
  app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "FitCheck backend is running" });
  });
  app.use((err, req, res, next) => {
    console.error("Request failed:", err);
    if (res.headersSent) return next(err);
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
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
    const app = createApp(dependencies, { apiRoutes, allowedOrigins });
    const port = process.env.PORT || 5001;
    app.listen(port, "0.0.0.0", () => console.log(`Server running on port ${port}`));
  } catch (error) {
    console.error("Server configuration error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp };
