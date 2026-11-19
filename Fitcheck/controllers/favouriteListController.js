const { requireAuthentication } = require("../middleware/auth");

function createFavouriteListController(dependencies) {
  async function getFavouriteList(req, res, next) {
    const pageValue = req.query.page ?? "1";
    const page = typeof pageValue === "string" && /^[1-9]\d*$/.test(pageValue)
      ? Number(pageValue)
      : NaN;
    if (!Number.isSafeInteger(page)) {
      return res.status(400).json({ error: "page must be a positive integer" });
    }
    try {
      const result = await dependencies.store.getFavouriteList({
        userId: req.user.uid,
        page,
      });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getFavouriteList];
}

module.exports = { createFavouriteListController };
