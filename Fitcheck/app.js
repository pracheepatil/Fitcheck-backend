const express = require("express");
const { createFitcheckRouter } = require("./routes/fitcheckRoutes");

function createApp(dependencies, { apiRoutes = [] } = {}) {
  const app = express();
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return res.sendStatus(204);
    }
    return next();
  });
  app.use("/api", createFitcheckRouter(dependencies));
  const { analyzeOutfit, getAnalysis } = require("./controllers/analyzeController").createAnalyzeController(dependencies);
  app.post("/analyze", analyzeOutfit);
  app.get("/getOutfitAnalysis", getAnalysis);
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
    const dependencies = createDependencies(process.env);
    const apiRoutes = [
      ["/api/auth", require("./routes/authRoutes")],
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
