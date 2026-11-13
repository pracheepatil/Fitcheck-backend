const express = require("express");
const multer = require("multer");
const { requireAuthentication } = require("../middleware/auth");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const DETAIL_FIELDS = ["outfitName", "occasion", "category"];
const audioTypes = {
  "audio/mpeg": ["audio/mpeg"],
  "audio/wav": ["audio/wav", "audio/x-wav"],
  "audio/mp4": ["audio/mp4", "audio/x-m4a", "video/mp4"],
  "audio/x-m4a": ["audio/mp4", "audio/x-m4a", "video/mp4"],
};

function createAnalyzeRouter({ auth, analyze, store }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 2, fields: 3, parts: 5, fieldSize: 1024 } })
    .fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]);
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
    if (Object.keys(req.body).some((key) => !DETAIL_FIELDS.includes(key)) ||
        DETAIL_FIELDS.some((key) => req.body[key] !== undefined &&
          (typeof req.body[key] !== "string" || !req.body[key].trim() || req.body[key].trim().length > 100))) {
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
      const analysis = await analyze({ image: image.buffer, mimeType: type.mime, userId: req.user.uid });
      const saved = await store.save({
        userId: req.user.uid, image: image.buffer, mimeType: type.mime, analysis,
        ...(req.body.outfitName ? { outfitName: req.body.outfitName.trim() } : {}),
        ...(req.body.occasion ? { occasion: req.body.occasion.trim() } : {}),
        ...(req.body.category ? { category: req.body.category.trim() } : {}),
        ...(audio ? { audio: { buffer: audio.buffer, mimeType: audio.mimetype } } : {}),
      });
      return res.status(201).json(saved);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = { createAnalyzeRouter, MAX_IMAGE_BYTES };
