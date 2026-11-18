const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");
const { createAverageAnalysisController } = require("../controllers/averageAnalysisController");
const { createSaveInspirationController } = require("../controllers/saveInspirationController");
const { createMyFitListController } = require("../controllers/myFitListController");
const { createInspirationListController } = require("../controllers/inspirationListController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit, getAnalysis, getPhoto, getMyFits, getStyleTips } = createAnalyzeController(dependencies);
  const getAverageAnalysis = createAverageAnalysisController(dependencies);
  const saveInspiration = createSaveInspirationController(dependencies);
  const getMyFitList = createMyFitListController(dependencies);
  const getInspirationList = createInspirationListController(dependencies);

  router.post("/sendMessage", express.json(), sendMessageController);
  router.put("/saveInspiration", express.json(), saveInspiration);
  router.get("/getAverageAnalysis", getAverageAnalysis);
  router.get("/getMyFitList", getMyFitList);
  router.get("/getInspirationList", getInspirationList);
  router.post("/analyze", analyzeOutfit);
  router.get("/getOutfitAnalysis", getAnalysis);
  router.get("/outfits/:outfitId/photo", getPhoto);
  router.get("/outfits", getMyFits);
  router.get("/outfits/:outfitId/style-tips", getStyleTips);

  return router;
}

module.exports = { createFitcheckRouter };
