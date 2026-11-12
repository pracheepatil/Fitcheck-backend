const { randomUUID } = require("node:crypto");

function createOutfitStore(db, bucket) {
  return {
    async save({ userId, image, mimeType, analysis }) {
      const id = randomUUID();
      const ref = db.collection("outfits").doc(id);
      const file = bucket.file(`outfits/${id}`);
      let recordCreated = false;
      let fileMayExist = false;
      try {
        await ref.create({ id, userId, status: "pending", createdAt: new Date().toISOString() });
        recordCreated = true;
        fileMayExist = true;
        await file.save(image, {
          resumable: false,
          metadata: { contentType: mimeType, cacheControl: "private, no-store" },
          preconditionOpts: { ifGenerationMatch: 0 },
        });
        const outfit = { id, userId, storagePath: file.name, mimeType, analysis, status: "complete", createdAt: new Date().toISOString() };
        await ref.set(outfit);
        return outfit;
      } catch (error) {
        if (error.code === 412 || error.code === "412") fileMayExist = false;
        const cleanup = await Promise.allSettled([
          ...(recordCreated ? [ref.delete()] : []),
          ...(fileMayExist ? [file.delete({ ignoreNotFound: true })] : []),
        ]);
        const failures = cleanup.filter((result) => result.status === "rejected");
        if (failures.length) {
          console.error(`Outfit cleanup failed for ${id}:`, failures.map((result) => result.reason));
          throw new AggregateError([error, ...failures.map((result) => result.reason)], `Failed to save outfit ${id}; cleanup incomplete`);
        }
        throw error;
      }
    },
  };
}

module.exports = { createOutfitStore };
