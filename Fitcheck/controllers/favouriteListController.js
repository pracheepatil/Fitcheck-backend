const { requireAuthentication } = require("../middleware/auth");
const FAVOURITE_CATEGORIES = ["Casual", "Streetwear", "Formal", "Vintage", "Minimalist"];

function createFavouriteListController(dependencies) {
  async function getFavouriteList(req, res, next) {
    const pageValue = req.query.page ?? "1";
    const categoryValue = req.query.category;
    const page = typeof pageValue === "string" && /^[1-9]\d*$/.test(pageValue)
      ? Number(pageValue)
      : NaN;
    if (!Number.isSafeInteger(page)) {
      return res.status(400).json({ error: "page must be a positive integer" });
    }
    if (categoryValue !== undefined &&
        (typeof categoryValue !== "string" || !categoryValue.trim() || categoryValue.trim().length > 100)) {
      return res.status(400).json({ error: "category must be a non-blank string of at most 100 characters" });
    }
    const category = typeof categoryValue === "string" && categoryValue.trim().toLowerCase() !== "all"
      ? categoryValue.trim()
      : undefined;
    try {
      const result = await dependencies.store.getFavouriteList({
        userId: req.user.uid,
        page,
        category
      });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getFavouriteList];
}

module.exports = { createFavouriteListController };
