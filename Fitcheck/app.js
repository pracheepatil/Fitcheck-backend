const express = require("express");
const { createAnalyzeRouter } = require("./routes/analyze");

function createApp(dependencies) {
  const app = express();
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
    const app = createApp(createDependencies(process.env));
    const port = process.env.PORT || 5000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (error) {
    console.error("Server configuration error:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp };
