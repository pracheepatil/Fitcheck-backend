const { requireAuthentication } = require("../middleware/auth");
const {
  createAnalyzeService,
  ImageFetchError,
  ImageTooLargeError,
  ImageUrlError,
  UnsupportedUploadTypeError,
} = require("../services/analyzeService");

const DETAIL_FIELDS = ["outfitName", "occasion", "category"];
const ALLOWED_FIELDS = new Set(["image", "audio", ...DETAIL_FIELDS]);

function validDetails(body) {
  return body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key)) &&
    DETAIL_FIELDS.every((key) =>
      typeof body[key] === "string" &&
      body[key].trim().length > 0 &&
      body[key].trim().length <= 100
    );
}

function createAnalyzeController(dependencies) {
  const analyzeService = createAnalyzeService(dependencies);

  async function analyzeOutfit(req, res, next) {
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "Provide analyze input as JSON" });
    }

    if (
      !validDetails(req.body) ||
      typeof req.body.image !== "string" ||
      !req.body.image.trim() ||
      (req.body.audio !== undefined && typeof req.body.audio !== "string")
    ) {
      return res.status(400).json({ error: "Invalid outfit details" });
    }

    const details = Object.fromEntries(
      DETAIL_FIELDS.map((key) => [key, req.body[key]?.trim() || ""])
    );
    try {
      const saved = await analyzeService.analyzeImageUrl({
        userId: req.user.uid,
        imageUrl: req.body.image.trim(),
        audioUrl: req.body.audio?.trim() || "",
        details,
      });
      return res.status(201).json(saved);
    } catch (error) {
      if (error instanceof ImageUrlError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ImageTooLargeError) {
        return res.status(413).json({ error: error.message });
      }
      if (error instanceof UnsupportedUploadTypeError) {
        return res.status(415).json({ error: error.message });
      }
      if (error instanceof ImageFetchError) {
        return res.status(502).json({ error: error.message });
      }
      return next(error);
    }
  }

  return {
    analyzeOutfit: [
      requireAuthentication(dependencies.auth),
      analyzeOutfit,
    ],
  };
}

module.exports = { createAnalyzeController };
