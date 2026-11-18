const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit, getAnalysis, getPhoto, getMyFits, getStyleTips } = createAnalyzeController(dependencies);

  router.post("/sendMessage", express.json(), sendMessageController);
  router.post("/analyze", analyzeOutfit);
  router.get("/getOutfitAnalysis", getAnalysis);
  router.get("/outfits/:outfitId/photo", getPhoto);
  router.get("/outfits", getMyFits);
  router.get("/outfits/:outfitId/style-tips", getStyleTips);

  return router;
}

module.exports = { createFitcheckRouter };
