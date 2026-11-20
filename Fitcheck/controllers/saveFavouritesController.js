const { requireAuthentication } = require("../middleware/auth");
const { OutfitNotFoundError } = require("../services/outfits");

function validOutfitId(id) {
  return typeof id === "string" && !!id.trim() && id === id.trim() &&
    Buffer.byteLength(id, "utf8") <= 1500 && !id.includes("/") &&
    !/^__.*__$/.test(id) && id !== "." && id !== "..";
}

function createSaveFavouritesController(dependencies) {
  async function saveFavourites(req, res, next) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["outfitId", "favourite"].includes(key)) ||
        !Object.hasOwn(body, "outfitId") || !validOutfitId(body.outfitId) ||
        (Object.hasOwn(body, "favourite") && typeof body.favourite !== "boolean")) {
      return res.status(400).json({ error: "Provide a valid outfitId" });
    }

    try {
      const result = await dependencies.store.saveFavourite({
        outfitId: body.outfitId,
        userId: req.user.uid,
        favourite: body.favourite ?? true,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      if (error instanceof OutfitNotFoundError) {
        return res.status(404).json({ error: "Outfit not found" });
      }
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), saveFavourites];
}

module.exports = { createSaveFavouritesController };
