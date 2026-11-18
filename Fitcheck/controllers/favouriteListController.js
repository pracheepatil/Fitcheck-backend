const { requireAuthentication } = require("../middleware/auth");

function createFavouriteListController(dependencies) {
  async function getFavouriteList(req, res, next) {
    try {
      const outfits = await dependencies.store.getFavouriteList({ userId: req.user.uid });
      return res.status(200).json({ outfits });
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getFavouriteList];
}

module.exports = { createFavouriteListController };
