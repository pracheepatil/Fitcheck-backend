const express = require("express");
const multer = require("multer");
const { requireAuthentication } = require("../middleware/auth");
const { OutfitNotFoundError, OutfitAlreadyUploadedError } = require("../services/outfits");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const DETAIL_FIELDS = ["outfitName", "occasion", "category"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const audioTypes = {
  "audio/mpeg": ["audio/mpeg"],
  "audio/wav": ["audio/wav", "audio/x-wav"],
  "audio/mp4": ["audio/mp4", "audio/x-m4a", "video/mp4"],
  "audio/x-m4a": ["audio/mp4", "audio/x-m4a", "video/mp4"],
};

function createAnalyzeRouter({ auth, analyze, store }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 2, fields: 4, parts: 6, fieldSize: 1024 } })
    .fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]);

  function validDetails(body, allowedFields = DETAIL_FIELDS) {
    return body && typeof body === "object" && !Array.isArray(body) &&
      !Object.keys(body).some((key) => !allowedFields.includes(key)) &&
      !DETAIL_FIELDS.some((key) => body[key] !== undefined &&
        (typeof body[key] !== "string" || !body[key].trim() || body[key].trim().length > 100));
  }

  function sendStoreError(error, res, next) {
    if (error instanceof OutfitNotFoundError) return res.status(404).json({ error: "Outfit not found" });
    if (error instanceof OutfitAlreadyUploadedError) return res.status(409).json({ error: "Outfit has already been uploaded" });
    return next(error);
  }

  router.post("/outfits", requireAuthentication(auth), (req, res, next) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "Provide outfit details as JSON" });
    return express.json({ limit: "4kb" })(req, res, (error) => {
      if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
      if (error?.type === "entity.too.large") return res.status(413).json({ error: "Outfit details are too large" });
      if (error) return next(error);
      return next();
    });
  }, async (req, res, next) => {
    if (!validDetails(req.body)) return res.status(400).json({ error: "Invalid outfit details" });
    try {
      const details = Object.fromEntries(DETAIL_FIELDS.map((key) => [key, req.body[key]?.trim() || ""]));
      return res.status(201).json(await store.createDraft({ userId: req.user.uid, ...details }));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/analyze", requireAuthentication(auth), (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError) {
        return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: `Invalid upload: ${error.code}` });
      }
      if (error.message.startsWith("Multipart:") || error.message === "Unexpected end of form") {
        return res.status(400).json({ error: "Invalid multipart upload" });
      }
      return next(error);
    });
  }, async (req, res, next) => {
    const image = req.files?.image?.[0];
    const audio = req.files?.audio?.[0];
    if (!req.is("multipart/form-data") || !image) {
      return res.status(400).json({ error: "Provide one image in the multipart image field" });
    }
    if (image.size > MAX_IMAGE_BYTES) return res.status(413).json({ error: "Image must be at most 5 MiB" });
    if (!validDetails(req.body, [...DETAIL_FIELDS, "outfitId"]) ||
        (req.body.outfitId !== undefined &&
          (typeof req.body.outfitId !== "string" || !UUID_PATTERN.test(req.body.outfitId))) ||
        (req.body.outfitId !== undefined && DETAIL_FIELDS.some((key) => req.body[key] !== undefined))) {
      return res.status(400).json({ error: "Invalid outfit details" });
    }
    try {
      const { fileTypeFromBuffer } = await import("file-type");
      const type = await fileTypeFromBuffer(image.buffer);
      if (!type || !acceptedTypes.has(type.mime) || type.mime !== image.mimetype) {
        return res.status(415).json({ error: "Image must be a JPEG, PNG, or WebP with a matching content type" });
      }
      if (audio) {
        const audioType = await fileTypeFromBuffer(audio.buffer);
        if (!audioType || !audioTypes[audio.mimetype]?.includes(audioType.mime)) {
          return res.status(415).json({ error: "Voice note must be an MP3, WAV, or M4A with a matching content type" });
        }
      }
      if (req.body.outfitId) await store.getDraft({ outfitId: req.body.outfitId, userId: req.user.uid });
      const analysis = await analyze({ image: image.buffer, mimeType: type.mime, userId: req.user.uid });
      const saved = await store.save({
        userId: req.user.uid, image: image.buffer, mimeType: type.mime, analysis,
        ...(req.body.outfitId ? { outfitId: req.body.outfitId } : {}),
        ...(req.body.outfitName ? { outfitName: req.body.outfitName.trim() } : {}),
        ...(req.body.occasion ? { occasion: req.body.occasion.trim() } : {}),
        ...(req.body.category ? { category: req.body.category.trim() } : {}),
        ...(audio ? { audio: { buffer: audio.buffer, mimeType: audio.mimetype } } : {}),
      });
      if (req.body.outfitId) return res.status(201).json(saved);
      return res.status(201).json({
        ...saved,
        outfit: {
          ...saved.outfit,
          analysis: {
            summary: analysis.summary,
            strengths: analysis.strengths,
            suggestions: [analysis.next_direction],
            colorPalette: analysis.primary_colors,
          },
        },
      });
    } catch (error) {
      return sendStoreError(error, res, next);
    }
  });
  return router;
}

module.exports = { createAnalyzeRouter, MAX_IMAGE_BYTES };
