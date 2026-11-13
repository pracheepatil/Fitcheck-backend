const { randomUUID } = require("node:crypto");

const COLLECTIONS = {
  details: "fitcheck_outfit_details",
  media: "fitcheck_outfit_media",
  analysis: "fitcheck_outfit_analysis",
  scores: "fitcheck_outfit_analysis_scores",
};
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const AUDIO_EXTENSIONS = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a" };

function createOutfitStore(db, bucket) {
  const urlFor = (path) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;

  return {
    async save({ userId, image, mimeType, analysis, outfitName, occasion, category, audio }) {
      const outfitId = randomUUID();
      const mediaId = randomUUID();
      const analysisId = randomUUID();
      const scoreId = randomUUID();
      const photoPath = `outfits/${outfitId}/photos/front.${IMAGE_EXTENSIONS[mimeType] || "bin"}`;
      const audioPath = audio ? `outfits/${outfitId}/audio/voice-note.${AUDIO_EXTENSIONS[audio.mimeType] || "bin"}` : "";
      const refs = {
        details: db.collection(COLLECTIONS.details).doc(outfitId),
        media: db.collection(COLLECTIONS.media).doc(mediaId),
        analysis: db.collection(COLLECTIONS.analysis).doc(analysisId),
        scores: db.collection(COLLECTIONS.scores).doc(scoreId),
      };
      const filesToDelete = new Set();
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
        const details = {
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
        // One atomic commit so a partial outfit never appears in Firestore.
        const batch = db.batch();
        batch.set(refs.details, details);
        batch.set(refs.media, media);
        batch.set(refs.analysis, analysisRecord);
        batch.set(refs.scores, scoresRecord);
        await batch.commit();
        return { outfit: details, media, analysis: analysisRecord, scores: scoresRecord };
      } catch (error) {
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

module.exports = { createOutfitStore, COLLECTIONS };
