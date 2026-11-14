const express = require("express");
const { createAnalyzeRouter } = require("./routes/analyze");

function createApp(dependencies, { allowedOrigins = [], apiRoutes = [] } = {}) {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (!origin) return next();
    res.vary("Origin");
    if (!allowedOrigins.includes(origin)) return res.status(403).json({ error: "Origin not allowed" });
    res.set("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return res.sendStatus(204);
    }
    return next();
  });
  app.use(createAnalyzeRouter(dependencies));
  app.use("/api", express.json());
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
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
    const dependencies = createDependencies(process.env);
    const apiRoutes = [
      ["/api/auth", require("./routes/authRoutes")],
      ["/api", require("./routes/firebaseTestRoutes")],
      ["/api", require("./routes/fitcheckRoutes")],
    ];
    const app = createApp(dependencies, { allowedOrigins, apiRoutes });
    const port = process.env.PORT || 5001;
    app.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (error) {
    console.error("Server configuration error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp };
