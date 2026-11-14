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
class OutfitAlreadyUploadedError extends Error {}

function createOutfitStore(db, bucket) {
  const urlFor = (path) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;

  function validateDraft(detailsSnapshot, mediaSnapshot, userId) {
    const details = detailsSnapshot.data();
    if (!detailsSnapshot.exists || details.userId !== userId) throw new OutfitNotFoundError();
    if (details.status === "uploaded") throw new OutfitAlreadyUploadedError();
    if (details.status !== "pending" || !mediaSnapshot.exists) {
      throw new Error("Outfit draft is in an invalid state");
    }
    return { details, media: mediaSnapshot.data() };
  }

  return {
    async createDraft({ userId, outfitName, occasion, category }) {
      const outfitId = randomUUID();
      const now = new Date();
      const outfit = { outfitId, userId, outfitName, occasion, category, createdAt: now, status: "pending" };
      const media = {
        mediaId: outfitId, outfitId, type: "photo", PhotoStoragePath: "", PhotoUrl: "",
        AudioStoragePath: "", AudioUrl: "", uploadedAt: null,
      };
      const batch = db.batch();
      batch.create(db.collection(COLLECTIONS.details).doc(outfitId), outfit);
      batch.create(db.collection(COLLECTIONS.media).doc(outfitId), media);
      await batch.commit();
      return { outfit, media };
    },

    async getDraft({ outfitId, userId }) {
      const detailsRef = db.collection(COLLECTIONS.details).doc(outfitId);
      const mediaRef = db.collection(COLLECTIONS.media).doc(outfitId);
      const [details, media] = await Promise.all([detailsRef.get(), mediaRef.get()]);
      validateDraft(details, media, userId);
    },

    async save({ userId, image, mimeType, analysis, outfitName, occasion, category, audio, outfitId: draftId }) {
      const outfitId = draftId || randomUUID();
      const mediaId = draftId || randomUUID();
      const analysisId = randomUUID();
      const scoreId = randomUUID();
      const attemptPath = draftId ? `${analysisId}/` : "";
      const photoPath = `outfits/${outfitId}/photos/${attemptPath}front.${IMAGE_EXTENSIONS[mimeType] || "bin"}`;
      const audioPath = audio ? `outfits/${outfitId}/audio/${attemptPath}voice-note.${AUDIO_EXTENSIONS[audio.mimeType] || "bin"}` : "";
      const refs = {
        details: db.collection(COLLECTIONS.details).doc(outfitId),
        media: db.collection(COLLECTIONS.media).doc(mediaId),
        analysis: db.collection(COLLECTIONS.analysis).doc(analysisId),
        scores: db.collection(COLLECTIONS.scores).doc(scoreId),
      };
      const filesToDelete = new Set();
      let draftCommitStarted = false;
      async function saveFile(path, data, contentType) {
        const target = bucket.file(path);
        filesToDelete.add(target);
        try {
          await target.save(data, {
            resumable: false,
            metadata: { contentType, cacheControl: "private, no-store" },
            preconditionOpts: { ifGenerationMatch: 0 },
          });
        } catch (error) {
          if (error.code === 412 || error.code === "412") filesToDelete.delete(target);
          throw error;
        }
      }
      try {
        await saveFile(photoPath, image, mimeType);
        if (audio) await saveFile(audioPath, audio.buffer, audio.mimeType);
        const now = new Date();
        const { scores, ...feedback } = analysis;
        const photoUrl = urlFor(photoPath);
        let details = {
          outfitId, userId, createdAt: now, status: "uploaded",
          outfitName: outfitName || "", occasion: occasion || "", category: category || "",
        };
        const media = {
          mediaId, outfitId, type: "photo", uploadedAt: now,
          PhotoStoragePath: photoPath, PhotoUrl: photoUrl,
          AudioStoragePath: audioPath, AudioUrl: audio ? urlFor(audioPath) : "",
        };
        const analysisRecord = {
          analysis_id: analysisId, outfit_id: outfitId, user_id: userId, image_url: photoUrl,
          style_category: feedback.style_category, outfit_title: feedback.outfit_title,
          overall_score: feedback.overall_score, summary: feedback.summary,
          color_description: feedback.color_description, primary_colors: feedback.primary_colors,
          strengths: feedback.strengths, next_direction: feedback.next_direction, created_at: now,
        };
        const scoresRecord = { score_id: scoreId, analysis_id: analysisId, ...scores, created_at: now };
        if (draftId) {
          draftCommitStarted = true;
          details = await db.runTransaction(async (transaction) => {
            const detailsSnapshot = await transaction.get(refs.details);
            const mediaSnapshot = await transaction.get(refs.media);
            const draft = validateDraft(detailsSnapshot, mediaSnapshot, userId);
            transaction.update(refs.details, { status: "uploaded" });
            transaction.set(refs.media, media);
            transaction.create(refs.analysis, analysisRecord);
            transaction.create(refs.scores, scoresRecord);
            return { ...draft.details, status: "uploaded" };
          });
          if (typeof details.createdAt?.toDate === "function") details.createdAt = details.createdAt.toDate();
        } else {
          const batch = db.batch();
          batch.set(refs.details, details);
          batch.set(refs.media, media);
          batch.set(refs.analysis, analysisRecord);
          batch.set(refs.scores, scoresRecord);
          await batch.commit();
        }
        return { outfit: details, media, analysis: analysisRecord, scores: scoresRecord };
      } catch (error) {
        if (draftCommitStarted && !(error instanceof OutfitNotFoundError) &&
            !(error instanceof OutfitAlreadyUploadedError)) {
          console.error(`Draft commit outcome unknown for ${outfitId}; uploaded files require reconciliation`);
          throw error;
        }
        const cleanup = await Promise.allSettled(
          Array.from(filesToDelete, (target) => target.delete({ ignoreNotFound: true })),
        );
        const failures = cleanup.filter((result) => result.status === "rejected");
        if (failures.length) {
          console.error(`Outfit cleanup failed for ${outfitId}:`, failures.map((result) => result.reason));
          throw new AggregateError([error, ...failures.map((result) => result.reason)], `Failed to save outfit ${outfitId}; cleanup incomplete`);
        }
        throw error;
      }
    },
  };
}

module.exports = { createOutfitStore, COLLECTIONS, OutfitNotFoundError, OutfitAlreadyUploadedError };
