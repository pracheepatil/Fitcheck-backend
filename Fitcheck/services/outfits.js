const { randomUUID } = require("node:crypto");

const COLLECTIONS = {
  details: "fitcheck_outfit_details",
  media: "fitcheck_outfit_media",
  analysis: "fitcheck_outfit_analysis",
  scores: "fitcheck_outfit_analysis_scores",
};
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const AUDIO_EXTENSIONS = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a" };

class OutfitNotFoundError extends Error {}
class OutfitMediaNotFoundError extends Error {}
class OutfitAnalysisNotFoundError extends Error {}
class OutfitDataConflictError extends Error {}

function createOutfitStore(db, bucket) {
  const urlFor = (path) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;

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

  return {
    async getAnalysis({ outfitId, userId }) {
      const outfit = await ownedOutfit(outfitId, userId);
      if (outfit.status === "pending" || outfit.status === "failed") {
        return { status: outfit.status, outfitId };
      }
      const mediaRecord = await oneRecord(db.collection(COLLECTIONS.media).where("outfitId", "==", outfitId), OutfitMediaNotFoundError);
      if (mediaRecord.data().mediaId !== mediaRecord.id) throw new OutfitDataConflictError();
      const media = mediaRecord.data();
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
          analysis: {
            summary: analysis.summary, strengths: analysis.strengths,
            suggestions: [analysis.next_direction], colorPalette: analysis.primary_colors,
          },
        },
        media: {
          mediaId: media.mediaId, outfitId: media.outfitId, type: media.type,
          PhotoStoragePath: media.PhotoStoragePath, PhotoUrl: media.PhotoUrl,
          AudioStoragePath: media.AudioStoragePath ?? "", AudioUrl: media.AudioUrl ?? "",
        },
        analysis: {
          analysis_id: analysis.analysis_id, outfit_id: analysis.outfit_id, user_id: analysis.user_id,
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

    async createSubmission({ userId, image, mimeType, outfitName, occasion, category, audio }) {
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
          outfitId, userId, outfitName, occasion, category, createdAt: now, status: "pending",
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
          image_url: media.docs[0].data().PhotoUrl, ...feedback, created_at: now,
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
};
