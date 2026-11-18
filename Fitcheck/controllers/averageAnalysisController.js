const { requireAuthentication } = require("../middleware/auth");

function createAverageAnalysisController(dependencies) {
  async function getAverageAnalysis(req, res, next) {
    try {
      const result = await dependencies.store.getAverageAnalysis({ userId: req.user.uid });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getAverageAnalysis];
}

module.exports = { createAverageAnalysisController };
