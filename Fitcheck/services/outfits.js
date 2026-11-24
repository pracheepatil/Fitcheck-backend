const { randomUUID } = require("node:crypto");

const COLLECTIONS = {
  details: "fitcheck_outfit_details",
  media: "fitcheck_outfit_media",
  analysis: "fitcheck_outfit_analysis",
  scores: "fitcheck_outfit_analysis_scores",
};
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const AUDIO_EXTENSIONS = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/webm": "webm" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PHOTO_URL_TTL_MS = 24 * 60 * 60 * 1000;
const FIT_LIST_PAGE_SIZE = 20;
const DEFAULT_STYLE_JOURNEY_WEEKS = 6;
const MAX_STYLE_JOURNEY_WEEKS = 52;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FIRESTORE_IN_QUERY_LIMIT = 30;
const SCORE_FIELDS = {
  colorHarmony: "color_harmony_score",
  styleMatching: "style_matching_score",
  balanceLayering: "balance_layering_score",
  accessories: "accessories_score",
};

class OutfitNotFoundError extends Error {}
class OutfitMediaNotFoundError extends Error {}
class OutfitAnalysisNotFoundError extends Error {}
class OutfitDataConflictError extends Error {}

function createOutfitStore(db, bucket) {
  const urlFor = (path) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
  const photoEndpointUrl = (outfitId) =>
    `/api/outfits/${encodeURIComponent(outfitId)}/photo`;

  function photoStoragePath(media) {
    if (media.PhotoStoragePath) return media.PhotoStoragePath;
    if (!media.PhotoUrl) return "";
    try {
      const photoUrl = new URL(media.PhotoUrl);
      const objectPrefix = `/v0/b/${bucket.name}/o/`;
      if (photoUrl.hostname !== "firebasestorage.googleapis.com" ||
          !photoUrl.pathname.startsWith(objectPrefix)) {
        return "";
      }
      return decodeURIComponent(photoUrl.pathname.slice(objectPrefix.length));
    } catch {
      return "";
    }
  }

  async function oneRecord(query, missingError) {
    const snapshot = await query.limit(2).get();
    if (snapshot.empty) throw new missingError();
    if (snapshot.size !== 1) throw new OutfitDataConflictError();
    return snapshot.docs[0];
  }

  async function ownedOutfit(outfitId, userId) {
    const snapshot = await db.collection(COLLECTIONS.details).doc(outfitId).get();
    if (!snapshot.exists || snapshot.data().userId !== userId) throw new OutfitNotFoundError();
    return snapshot.data();
  }

  async function mediaFor(outfitId) {
    const record = await oneRecord(db.collection(COLLECTIONS.media).where("outfitId", "==", outfitId), OutfitMediaNotFoundError);
    if (record.data().mediaId !== record.id) throw new OutfitDataConflictError();
    return record.data();
  }

  function average(values) {
    const validValues = values.filter((value) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    );
    if (!validValues.length) return null;
    return Math.round((validValues.reduce((sum, value) => sum + value, 0) / validValues.length) * 100) / 100;
  }

  function toDate(value) {
    const date = value instanceof Date
      ? value
      : typeof value?.toDate === "function"
        ? value.toDate()
        : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfUtcWeek(date) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return start;
  }

  function dateString(date) {
    return date.toISOString().slice(0, 10);
  }

  async function signedPhotoUrl(outfitId, media) {
    const storagePath = media ? photoStoragePath(media) : "";
    if (!storagePath) return media?.PhotoUrl ?? "";
    if (!storagePath.startsWith(`outfits/${outfitId}/`)) {
      throw new OutfitDataConflictError();
    }
    const [url] = await bucket.file(storagePath).getSignedUrl({
      action: "read",
      expires: Date.now() + PHOTO_URL_TTL_MS,
    });
    return url;
  }

  async function getUserFitList(userId, favouritesOnly = false, signedPhotoUrls = false, page = null) {
    let outfitsQuery = db.collection(COLLECTIONS.details).where("userId", "==", userId);
    if (favouritesOnly) outfitsQuery = outfitsQuery.where("favourite", "==", true);
    let pagination = null;
    let outfitsSnapshot;
    if (page !== null) {
      const countQuery = outfitsQuery.count();
      const [countSnapshot, pageSnapshot] = await Promise.all([
        countQuery.get(),
        outfitsQuery.offset((page - 1) * FIT_LIST_PAGE_SIZE).limit(FIT_LIST_PAGE_SIZE).get(),
      ]);
      const totalOutfits = countSnapshot.data().count;
      const totalPages = Math.ceil(totalOutfits / FIT_LIST_PAGE_SIZE);
      outfitsSnapshot = pageSnapshot;
      pagination = {
        page,
        pageSize: FIT_LIST_PAGE_SIZE,
        totalOutfits,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      };
    } else {
      outfitsSnapshot = await outfitsQuery.get();
    }
    const outfits = outfitsSnapshot.docs
      .map((record) => ({ ...record.data(), outfitId: record.id }));
    const outfitIds = outfits.map((outfit) => outfit.outfitId);
    const mediaRecords = [];
    const analysisRecords = [];

    for (let offset = 0; offset < outfitIds.length; offset += FIRESTORE_IN_QUERY_LIMIT) {
      const batchIds = outfitIds.slice(offset, offset + FIRESTORE_IN_QUERY_LIMIT);
      const [mediaSnapshot, analysisSnapshot] = await Promise.all([
        db.collection(COLLECTIONS.media).where("outfitId", "in", batchIds).get(),
        db.collection(COLLECTIONS.analysis).where("outfit_id", "in", batchIds).get(),
      ]);
      mediaRecords.push(...mediaSnapshot.docs.map((record) => record.data()));
      analysisRecords.push(...analysisSnapshot.docs.map((record) => record.data()));
    }

    const mediaByOutfitId = new Map(
      mediaRecords.map((record) => [record.outfitId, record])
    );
    const analysisByOutfitId = new Map(
      analysisRecords
        .filter((record) => record.user_id === userId)
        .map((record) => [record.outfit_id, record])
    );

    const listedOutfits = await Promise.all(outfits.map(async (outfit) => {
      const media = mediaByOutfitId.get(outfit.outfitId);
      const analysis = analysisByOutfitId.get(outfit.outfitId);
      let photoUrl = media?.PhotoUrl ?? "";
      if (signedPhotoUrls) photoUrl = await signedPhotoUrl(outfit.outfitId, media);
      return {
        outfitId: outfit.outfitId,
        category: outfit.category ?? "",
        occasion: outfit.occasion ?? "",
        outfitName: outfit.outfitName ?? "",
        photoUrl,
        averageOutfitScore: typeof analysis?.overall_score === "number"
          ? analysis.overall_score
          : null,
      };
    }));
    return pagination ? { outfits: listedOutfits, pagination } : listedOutfits;
  }

  return {
    async getOutfit({ outfitId, userId }) {
      return ownedOutfit(outfitId, userId);
    },

    async saveFavourite({ outfitId, userId, favourite = true }) {
      const outfitRef = db.collection(COLLECTIONS.details).doc(outfitId);
      await db.runTransaction(async (transaction) => {
        const outfitSnapshot = await transaction.get(outfitRef);
        if (!outfitSnapshot.exists || outfitSnapshot.data().userId !== userId) {
          throw new OutfitNotFoundError();
        }
        if (outfitSnapshot.data().favourite !== favourite) {
          transaction.update(outfitRef, { favourite });
        }
      });
      return { outfitId, favourite };
    },

    async getAverageAnalysis({ userId }) {
      const [outfitsSnapshot, analysesSnapshot] = await Promise.all([
        db.collection(COLLECTIONS.details).where("userId", "==", userId).get(),
        db.collection(COLLECTIONS.analysis).where("user_id", "==", userId).get(),
      ]);
      const uploadedOutfitIds = new Set(
        outfitsSnapshot.docs
          .filter((record) => record.data().status === "uploaded")
          .map((record) => record.id)
      );
      const analyses = analysesSnapshot.docs
        .map((record) => record.data())
        .filter((record) => uploadedOutfitIds.has(record.outfit_id));
      const analysisIds = analyses.map((record) => record.analysis_id);
      const scoreRecords = [];
      for (let offset = 0; offset < analysisIds.length; offset += FIRESTORE_IN_QUERY_LIMIT) {
        const scoreSnapshot = await db.collection(COLLECTIONS.scores)
          .where("analysis_id", "in", analysisIds.slice(offset, offset + FIRESTORE_IN_QUERY_LIMIT))
          .get();
        scoreRecords.push(...scoreSnapshot.docs.map((record) => record.data()));
      }
      const scoresByAnalysisId = new Map(
        scoreRecords.map((record) => [record.analysis_id, record])
      );
      const userScores = analyses
        .map((record) => scoresByAnalysisId.get(record.analysis_id))
        .filter(Boolean);
      const averageStyleCriteriaScores = Object.fromEntries(
        Object.entries(SCORE_FIELDS).map(([field, storedField]) => [
          field,
          average(userScores.map((record) => record[storedField])),
        ])
      );

      return {
        uploadedOutfitsCount: uploadedOutfitIds.size,
        averageOverallScore: average(analyses.map((record) => record.overall_score)),
        savedInspirationsCount: outfitsSnapshot.docs.filter((record) =>
          record.data().favourite === true
        ).length,
        averageFitScore: average(Object.values(averageStyleCriteriaScores)),
        averageStyleCriteriaScores,
      };
    },

    async getMyFitList({ userId, page = 1 }) {
      return getUserFitList(userId, false, true, page);
    },

    async getStyleJourney({ userId, weeks = DEFAULT_STYLE_JOURNEY_WEEKS }) {
      const now = new Date();
      const currentWeekStart = startOfUtcWeek(now);
      const firstWeekStart = new Date(currentWeekStart);
      firstWeekStart.setUTCDate(firstWeekStart.getUTCDate() - (weeks - 1) * 7);
      const weekBuckets = Array.from({ length: weeks }, (_, index) => {
        const startDate = new Date(firstWeekStart);
        startDate.setUTCDate(startDate.getUTCDate() + index * 7);
        const endDate = new Date(startDate);
        endDate.setUTCDate(endDate.getUTCDate() + 6);
        return {
          week: index + 1,
          startDate: dateString(startDate),
          endDate: dateString(endDate),
          averageOutfitScore: null,
          outfits: [],
        };
      });

      const outfitSnapshot = await db.collection(COLLECTIONS.details)
        .where("userId", "==", userId)
        .get();
      const recentOutfits = outfitSnapshot.docs
        .map((record) => ({ ...record.data(), outfitId: record.id, createdAt: toDate(record.data().createdAt) }))
        .filter((outfit) =>
          outfit.createdAt &&
          outfit.createdAt >= firstWeekStart &&
          outfit.createdAt <= now
        );
      const outfitIds = recentOutfits.map((outfit) => outfit.outfitId);
      const mediaRecords = [];
      const analysisRecords = [];

      for (let offset = 0; offset < outfitIds.length; offset += FIRESTORE_IN_QUERY_LIMIT) {
        const batchIds = outfitIds.slice(offset, offset + FIRESTORE_IN_QUERY_LIMIT);
        const [mediaSnapshot, analysisSnapshot] = await Promise.all([
          db.collection(COLLECTIONS.media).where("outfitId", "in", batchIds).get(),
          db.collection(COLLECTIONS.analysis).where("outfit_id", "in", batchIds).get(),
        ]);
        mediaRecords.push(...mediaSnapshot.docs.map((record) => record.data()));
        analysisRecords.push(...analysisSnapshot.docs.map((record) => record.data()));
      }

      const mediaByOutfitId = new Map(
        mediaRecords.map((record) => [record.outfitId, record])
      );
      const analysisByOutfitId = new Map(
        analysisRecords
          .filter((record) => record.user_id === userId)
          .map((record) => [record.outfit_id, record])
      );

      for (const outfit of recentOutfits) {
        const weekIndex = Math.floor(
          (startOfUtcWeek(outfit.createdAt).getTime() - firstWeekStart.getTime()) /
          (7 * 24 * 60 * 60 * 1000)
        );
        const media = mediaByOutfitId.get(outfit.outfitId);
        const analysis = analysisByOutfitId.get(outfit.outfitId);
        weekBuckets[weekIndex].outfits.push({
          outfitId: outfit.outfitId,
          outfitName: outfit.outfitName ?? "",
          category: outfit.category ?? "",
          occasion: outfit.occasion ?? "",
          createdAt: outfit.createdAt.toISOString(),
          photoUrl: await signedPhotoUrl(outfit.outfitId, media),
          averageOutfitScore: typeof analysis?.overall_score === "number"
            ? analysis.overall_score
            : null,
        });
      }

      for (const week of weekBuckets) {
        week.outfits.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        week.averageOutfitScore = average(
          week.outfits.map((outfit) => outfit.averageOutfitScore)
        );
      }

      return { weeks: weekBuckets };
    },

    async getFavouriteList({ userId, page = 1 }) {
      return getUserFitList(userId, true, true, page);
    },

    async getAnalysis({ outfitId, userId }) {
      const outfit = await ownedOutfit(outfitId, userId);
      if (outfit.status === "pending" || outfit.status === "failed") {
        return { status: outfit.status, outfitId };
      }
      const media = await mediaFor(outfitId);
      const record = await oneRecord(db.collection(COLLECTIONS.analysis).where("outfit_id", "==", outfitId), OutfitAnalysisNotFoundError);
      const analysis = record.data();
      if (analysis.user_id !== userId || analysis.analysis_id !== record.id) throw new OutfitDataConflictError();
      const scoreRecord = await oneRecord(db.collection(COLLECTIONS.scores).where("analysis_id", "==", analysis.analysis_id), OutfitAnalysisNotFoundError);
      const scores = scoreRecord.data();
      if (scores.score_id !== scoreRecord.id) throw new OutfitDataConflictError();
      return {
        outfit: {
          outfitId: outfit.outfitId, userId: outfit.userId, status: outfit.status,
          outfitName: outfit.outfitName ?? "", occasion: outfit.occasion ?? "", category: outfit.category ?? "",
          favourite: outfit.favourite === true,
        },
        media: {
          mediaId: media.mediaId, outfitId: media.outfitId, type: media.type,
          PhotoStoragePath: media.PhotoStoragePath,
          PhotoUrl: media.PhotoStoragePath ? photoEndpointUrl(outfitId) : media.PhotoUrl,
          AudioStoragePath: media.AudioStoragePath ?? "", AudioUrl: media.AudioUrl ?? "",
        },
        analysis: {
          analysis_id: analysis.analysis_id, outfit_id: analysis.outfit_id, user_id: analysis.user_id,
          image_url: analysis.image_url,
          style_category: analysis.style_category, outfit_title: analysis.outfit_title,
          overall_score: analysis.overall_score, summary: analysis.summary,
          color_description: analysis.color_description, primary_colors: analysis.primary_colors,
          strengths: analysis.strengths, next_direction: analysis.next_direction,
        },
        scores: {
          score_id: scores.score_id, analysis_id: scores.analysis_id,
          color_harmony_score: scores.color_harmony_score, style_matching_score: scores.style_matching_score,
          balance_layering_score: scores.balance_layering_score, accessories_score: scores.accessories_score,
        },
      };
    },

    async getPhoto({ outfitId, userId }) {
      await ownedOutfit(outfitId, userId);
      const media = await mediaFor(outfitId);
      const path = media.PhotoStoragePath;
      if (typeof path !== "string" ||
          (path !== `outfits/${outfitId}` && !path.startsWith(`outfits/${outfitId}/`))) {
        throw new OutfitMediaNotFoundError();
      }
      let metadata;
      let buffer;
      try {
        [metadata] = await bucket.file(path).getMetadata();
        const size = Number(metadata.size);
        if (!metadata.generation || !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
          throw new OutfitDataConflictError();
        }
        [buffer] = await bucket.file(path, { generation: metadata.generation }).download();
      } catch (error) {
        if (error.code === 404 || error.code === "404") throw new OutfitMediaNotFoundError();
        throw error;
      }
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new OutfitDataConflictError();
      const { fileTypeFromBuffer } = await import("file-type");
      let type;
      try {
        type = await fileTypeFromBuffer(buffer);
      } catch (error) {
        if (error.name !== "EndOfStreamError") throw error;
      }
      if (!type || !IMAGE_TYPES.has(type.mime)) throw new OutfitDataConflictError();
      return { buffer, mimeType: type.mime };
    },

    async createSubmission({ userId, image, mimeType, outfitName, occasion, category, favourite = false, audio }) {
      const outfitId = randomUUID();
      const mediaId = randomUUID();
      const photoPath = `outfits/${outfitId}/photos/front.${IMAGE_EXTENSIONS[mimeType]}`;
      const audioPath = audio ? `outfits/${outfitId}/audio/voice-note.${AUDIO_EXTENSIONS[audio.mimeType]}` : "";
      const filesToDelete = new Set();
      let commitStarted = false;
      async function saveFile(path, data, contentType) {
        const target = bucket.file(path);
        try {
          await target.save(data, {
            resumable: false, metadata: { contentType, cacheControl: "private, no-store" },
            preconditionOpts: { ifGenerationMatch: 0 },
          });
          filesToDelete.add(target);
        } catch (error) {
          if (error.code !== 412 && error.code !== "412") {
            console.error(`Upload outcome unknown for ${path}; object may require reconciliation`);
          }
          throw error;
        }
      }
      try {
        await saveFile(photoPath, image, mimeType);
        if (audio) await saveFile(audioPath, audio.buffer, audio.mimeType);
        const now = new Date();
        const batch = db.batch();
        batch.create(db.collection(COLLECTIONS.details).doc(outfitId), {
          outfitId, userId, outfitName, occasion, category, favourite, createdAt: now, status: "pending",
        });
        batch.create(db.collection(COLLECTIONS.media).doc(mediaId), {
          mediaId, outfitId, type: "photo", uploadedAt: now,
          PhotoStoragePath: photoPath, PhotoUrl: urlFor(photoPath),
          AudioStoragePath: audioPath, AudioUrl: audio ? urlFor(audioPath) : "",
        });
        commitStarted = true;
        await batch.commit();
        return outfitId;
      } catch (error) {
        if (commitStarted) {
          console.error(`Submission commit outcome unknown for ${outfitId}; uploaded files require reconciliation`);
          throw error;
        }
        const cleanup = await Promise.allSettled([...filesToDelete].map((target) => target.delete({ ignoreNotFound: true })));
        const failures = cleanup.filter((result) => result.status === "rejected");
        if (failures.length) {
          throw new AggregateError([error, ...failures.map((result) => result.reason)], `Upload cleanup failed for ${outfitId}`);
        }
        throw error;
      }
    },

    async completeAnalysis({ outfitId, userId, analysis }) {
      const detailsRef = db.collection(COLLECTIONS.details).doc(outfitId);
      const mediaQuery = db.collection(COLLECTIONS.media).where("outfitId", "==", outfitId).limit(2);
      const existingQuery = db.collection(COLLECTIONS.analysis).where("outfit_id", "==", outfitId).limit(2);
      const analysisId = randomUUID();
      const scoreId = randomUUID();
      const now = new Date();
      await db.runTransaction(async (transaction) => {
        const details = await transaction.get(detailsRef);
        if (!details.exists || details.data().userId !== userId) throw new OutfitNotFoundError();
        if (details.data().status !== "pending") throw new OutfitDataConflictError();
        const media = await transaction.get(mediaQuery);
        const existing = await transaction.get(existingQuery);
        if (media.size !== 1 || !existing.empty) throw new OutfitDataConflictError();
        const { scores, ...feedback } = analysis;
        transaction.create(db.collection(COLLECTIONS.analysis).doc(analysisId), {
          analysis_id: analysisId, outfit_id: outfitId, user_id: userId,
          image_url: photoEndpointUrl(outfitId), ...feedback, created_at: now,
        });
        transaction.create(db.collection(COLLECTIONS.scores).doc(scoreId), {
          score_id: scoreId, analysis_id: analysisId, ...scores, created_at: now,
        });
        transaction.update(detailsRef, { status: "uploaded" });
      });
    },

    async failAnalysis({ outfitId, userId }) {
      const detailsRef = db.collection(COLLECTIONS.details).doc(outfitId);
      await db.runTransaction(async (transaction) => {
        const details = await transaction.get(detailsRef);
        if (!details.exists || details.data().userId !== userId) throw new OutfitNotFoundError();
        if (details.data().status === "pending") transaction.update(detailsRef, { status: "failed" });
      });
    },
  };
}

module.exports = {
  createOutfitStore, COLLECTIONS, OutfitNotFoundError,
  OutfitMediaNotFoundError, OutfitAnalysisNotFoundError, OutfitDataConflictError,
  DEFAULT_STYLE_JOURNEY_WEEKS, MAX_STYLE_JOURNEY_WEEKS,
};
