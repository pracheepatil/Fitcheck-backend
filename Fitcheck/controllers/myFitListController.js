const { requireAuthentication } = require("../middleware/auth");

function createMyFitListController(dependencies) {
  async function getMyFitList(req, res, next) {
    try {
      const outfits = await dependencies.store.getMyFitList({ userId: req.user.uid });
      return res.status(200).json({ outfits });
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getMyFitList];
}

module.exports = { createMyFitListController };
