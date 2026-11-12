const express = require("express");
const multer = require("multer");
const { requireAuthentication } = require("../middleware/auth");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function createAnalyzeRouter({ auth, analyze, store }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 } }).single("image");
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
    if (!req.is("multipart/form-data") || !req.file) {
      return res.status(400).json({ error: "Provide one image in the multipart image field" });
    }
    try {
      const { fileTypeFromBuffer } = await import("file-type");
      const type = await fileTypeFromBuffer(req.file.buffer);
      if (!type || !acceptedTypes.has(type.mime) || type.mime !== req.file.mimetype) {
        return res.status(415).json({ error: "Image must be a JPEG, PNG, or WebP with a matching content type" });
      }
      const analysis = await analyze({ image: req.file.buffer, mimeType: type.mime, userId: req.user.uid });
      const outfit = await store.save({ userId: req.user.uid, image: req.file.buffer, mimeType: type.mime, analysis });
      return res.status(201).json({ outfit });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = { createAnalyzeRouter, MAX_IMAGE_BYTES };
