const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");
const { createAverageAnalysisController } = require("../controllers/averageAnalysisController");
const { createSaveFavouritesController } = require("../controllers/saveFavouritesController");
const { createMyFitListController } = require("../controllers/myFitListController");
const { createFavouriteListController } = require("../controllers/favouriteListController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit, getAnalysis, getPhoto, getStyleTips } = createAnalyzeController(dependencies);
  const getAverageAnalysis = createAverageAnalysisController(dependencies);
  const saveFavourites = createSaveFavouritesController(dependencies);
  const getMyFitList = createMyFitListController(dependencies);
  const getFavouriteList = createFavouriteListController(dependencies);

  router.post("/sendMessage", express.json(), sendMessageController);
  router.put("/saveFavourites", express.json(), saveFavourites);
  router.get("/getAverageAnalysis", getAverageAnalysis);
  router.get("/getMyFitList", getMyFitList);
  router.get("/getFavouriteList", getFavouriteList);
  router.post("/analyze", analyzeOutfit);
  router.get("/getOutfitAnalysis", getAnalysis);
  router.get("/outfits/:outfitId/photo", getPhoto);
  router.get("/outfits/:outfitId/style-tips", getStyleTips);

  return router;
}

module.exports = { createFitcheckRouter };
