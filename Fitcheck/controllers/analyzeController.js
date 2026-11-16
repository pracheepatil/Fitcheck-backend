const express = require("express");
const { requireAuthentication } = require("../middleware/auth");
const {
  OutfitNotFoundError,
  OutfitMediaNotFoundError,
  OutfitAnalysisNotFoundError,
  OutfitDataConflictError,
} = require("../services/outfits");
const { InvalidMediaError, MediaFetchError, createAnalyzeService } = require("../services/analyzeService");

const DETAIL_FIELDS = ["outfitName", "occasion", "category"];
const REQUEST_FIELDS = new Set(["image", "audio", ...DETAIL_FIELDS]);

function createAnalyzeResponse(outfitId) {
  return { status: "success", outfitId };
}

function validOutfitId(id) {
  return typeof id === "string" && !!id.trim() && id === id.trim() &&
    Buffer.byteLength(id, "utf8") <= 1500 && !id.includes("/") &&
    !/^__.*__$/.test(id) && id !== "." && id !== "..";
}

function mapAnalyzeError(error, res, next) {
  if (error instanceof InvalidMediaError) {
    return res.status(400).json({ error: error.message });
  }
  if (error instanceof MediaFetchError) return res.status(502).json({ error: error.message });
  if (error instanceof OutfitNotFoundError) return res.status(404).json({ error: "Outfit not found" });
  if (error instanceof OutfitMediaNotFoundError) return res.status(404).json({ error: "Outfit image not found" });
  if (error instanceof OutfitAnalysisNotFoundError) return res.status(404).json({ error: "Outfit analysis not found" });
  if (error instanceof OutfitDataConflictError) return res.status(409).json({ error: "Outfit data is inconsistent" });
  return next(error);
}

function createAnalyzeController(dependencies) {
  const analyzeService = createAnalyzeService(dependencies);
  const jsonParser = express.json({ limit: "64kb" });

  function parseJson(req, res, next) {
    if (!req.is("application/json")) return res.status(400).json({ error: "JSON request body is required" });
    jsonParser(req, res, (error) => {
      if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
        return res.status(400).json({ error: "Invalid or oversized JSON request" });
      }
      return error ? next(error) : next();
    });
  }

  async function analyzeOutfit(req, res, next) {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !REQUEST_FIELDS.has(key)) ||
        typeof req.body.image !== "string" || !req.body.image.trim() || req.body.image.length > 16_384 ||
        (req.body.audio != null && (typeof req.body.audio !== "string" ||
          !req.body.audio.trim() || req.body.audio.length > 16_384)) ||
        DETAIL_FIELDS.some((key) => typeof req.body[key] !== "string" ||
          !req.body[key].trim() || req.body[key].length > 100)) {
      return res.status(400).json({ error: "Provide an image and valid outfitName, occasion and category" });
    }

    try {
      const outfitId = await analyzeService.analyzeOutfit({
        userId: req.user.uid,
        image: req.body.image,
        audio: req.body.audio,
        details: Object.fromEntries(DETAIL_FIELDS.map((key) => [key, req.body[key].trim()])),
      });
      return res.status(201).json(createAnalyzeResponse(outfitId));
    } catch (error) {
      return mapAnalyzeError(error, res, next);
    }
  }

  function validateIdentity(req, res, next) {
    const input = req.query;
    if (!input || typeof input.userId !== "string" || !input.userId.trim() ||
        input.userId !== input.userId.trim() ||
        !validOutfitId(input.outfitId) ||
        Object.keys(input).some((key) => !["userId", "outfitId"].includes(key))) {
      return res.status(400).json({ error: "Provide a valid userId and outfitId" });
    }
    if (input.userId !== req.user.uid) return res.status(403).json({ error: "User ID does not match the authenticated user" });
    return next();
  }

  async function getAnalysis(req, res, next) {
    try {
      const result = await dependencies.store.getAnalysis({ outfitId: req.query.outfitId, userId: req.user.uid });
      return res.status(result.status === "pending" ? 202 : 200).json(result);
    } catch (error) {
      return mapAnalyzeError(error, res, next);
    }
  }

  async function getPhoto(req, res, next) {
    if (!validOutfitId(req.params.outfitId)) return res.status(400).json({ error: "Provide a valid outfitId" });
    try {
      const photo = await dependencies.store.getPhoto({ outfitId: req.params.outfitId, userId: req.user.uid });
      return res.set({ "Content-Type": photo.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" })
        .send(photo.buffer);
    } catch (error) {
      return mapAnalyzeError(error, res, next);
    }
  }

  return {
    analyzeOutfit: [requireAuthentication(dependencies.auth), parseJson, analyzeOutfit],
    getAnalysis: [requireAuthentication(dependencies.auth), validateIdentity, getAnalysis],
    getPhoto: [requireAuthentication(dependencies.auth), getPhoto],
  };
}

module.exports = { createAnalyzeController };
