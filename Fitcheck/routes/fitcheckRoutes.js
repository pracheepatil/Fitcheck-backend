const express = require("express");
const { createAnalyzeController } = require("../controllers/analyzeController");

function createFitcheckRouter(dependencies) {
  const router = express.Router();
  const { sendMessageController } = require("../controllers/messageController");
  const { analyzeOutfit } = createAnalyzeController(dependencies);

  router.post("/analyze", analyzeOutfit);

  router.post("/sendMessage", express.json(), sendMessageController);
  return router;
}

module.exports = { createFitcheckRouter };
