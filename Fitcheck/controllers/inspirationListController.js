const { requireAuthentication } = require("../middleware/auth");

function createInspirationListController(dependencies) {
  async function getInspirationList(req, res, next) {
    try {
      const outfits = await dependencies.store.getInspirationList({ userId: req.user.uid });
      return res.status(200).json({ outfits });
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getInspirationList];
}

module.exports = { createInspirationListController };
