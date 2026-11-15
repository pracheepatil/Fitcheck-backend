const multer = require("multer");
const { requireAuthentication } = require("../middleware/auth");
const {
  OutfitAlreadyUploadedError,
  OutfitNotFoundError,
} = require("../services/outfits");
const {
  UnsupportedUploadTypeError,
  createAnalyzeService,
} = require("../services/analyzeService");

const DETAIL_FIELDS = ["outfitName", "occasion", "category"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDetails(body, allowedFields = DETAIL_FIELDS) {
  return body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !Object.keys(body).some((key) => !allowedFields.includes(key)) &&
    !DETAIL_FIELDS.some((key) =>
      body[key] !== undefined &&
      (typeof body[key] !== "string" ||
        !body[key].trim() ||
        body[key].trim().length > 100)
    );
}

function mapAnalyzeError(error, res, next) {
  if (error instanceof UnsupportedUploadTypeError) {
    return res.status(415).json({ error: error.message });
  }
  if (error.code === "IMAGE_TOO_LARGE") {
    return res.status(413).json({ error: error.message });
  }
  if (error instanceof OutfitNotFoundError) {
    return res.status(404).json({ error: "Outfit not found" });
  }
  if (error instanceof OutfitAlreadyUploadedError) {
    return res.status(409).json({ error: "Outfit has already been uploaded" });
  }
  return next(error);
}

function createAnalyzeController(dependencies) {
  const analyzeService = createAnalyzeService(dependencies);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 2,
      fields: 4,
      parts: 6,
      fieldSize: 1024,
    },
  }).fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]);

  function parseUpload(req, res, next) {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({
          error: `Invalid upload: ${error.code}`,
        });
      }
      if (
        error.message.startsWith("Multipart:") ||
        error.message === "Unexpected end of form"
      ) {
        return res.status(400).json({ error: "Invalid multipart upload" });
      }
      return next(error);
    });
  }

  async function analyzeOutfit(req, res, next) {
    const image = req.files?.image?.[0];
    const audio = req.files?.audio?.[0];
    if (!req.is("multipart/form-data") || !image) {
      return res.status(400).json({
        error: "Provide one image in the multipart image field",
      });
    }

    if (
      !validDetails(req.body, [...DETAIL_FIELDS, "outfitId"]) ||
      (req.body.outfitId !== undefined &&
        (typeof req.body.outfitId !== "string" ||
          !UUID_PATTERN.test(req.body.outfitId))) ||
      (req.body.outfitId !== undefined &&
        DETAIL_FIELDS.some((key) => req.body[key] !== undefined))
    ) {
      return res.status(400).json({ error: "Invalid outfit details" });
    }

    const details = Object.fromEntries(
      DETAIL_FIELDS.map((key) => [key, req.body[key]?.trim() || ""])
    );
    if (req.body.outfitId) details.outfitId = req.body.outfitId;

    try {
      const saved = await analyzeService.analyzeOutfit({
        userId: req.user.uid,
        image,
        audio,
        details,
      });
      return res.status(201).json(saved);
    } catch (error) {
      return mapAnalyzeError(error, res, next);
    }
  }

  return {
    analyzeOutfit: [
      requireAuthentication(dependencies.auth),
      parseUpload,
      analyzeOutfit,
    ],
  };
}

module.exports = { createAnalyzeController };
