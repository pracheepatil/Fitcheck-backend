const express = require("express");
const { createAnalyzeRouter } = require("./routes/analyze");

function createApp(dependencies, { allowedOrigins = [] } = {}) {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (!origin) return next();
    res.vary("Origin");
    if (!allowedOrigins.includes(origin)) return res.status(403).json({ error: "Origin not allowed" });
    res.set("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return res.sendStatus(204);
    }
    return next();
  });
  app.use(createAnalyzeRouter(dependencies));
  app.use((err, req, res, next) => {
    console.error("Request failed:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

if (require.main === module) {
  try {
    const { createDependencies } = require("./services/config");
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
    const app = createApp(createDependencies(process.env), { allowedOrigins });
    const port = process.env.PORT || 5001;
    app.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (error) {
    console.error("Server configuration error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp };
