const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit, getAnalysis } = createAnalyzeController(dependencies);

  router.post("/analyze", analyzeOutfit);
  router.get("/getOutfitAnalysis", getAnalysis);

  router.post("/sendMessage", express.json(), sendMessageController);
  return router;
}

module.exports = { createFitcheckRouter };
