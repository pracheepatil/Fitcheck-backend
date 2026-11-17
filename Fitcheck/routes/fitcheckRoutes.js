const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit, getAnalysis, getPhoto } = createAnalyzeController(dependencies);

  router.post("/sendMessage", express.json(), sendMessageController);
  router.post("/analyze", analyzeOutfit);
  router.get("/getOutfitAnalysis", getAnalysis);
  router.get("/outfits/:outfitId/photo", getPhoto);

  return router;
}

module.exports = { createFitcheckRouter };
