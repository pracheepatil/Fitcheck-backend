const {
  OutfitAlreadyUploadedError,
  OutfitNotFoundError,
} = require("./outfits");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const audioTypes = {
  "audio/mpeg": ["audio/mpeg"],
  "audio/wav": ["audio/wav", "audio/x-wav"],
  "audio/mp4": ["audio/mp4", "audio/x-m4a", "video/mp4"],
  "audio/x-m4a": ["audio/mp4", "audio/x-m4a", "video/mp4"],
};

class UnsupportedUploadTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedUploadTypeError";
  }
}

function createAnalyzeService({ analyze, store }) {
  async function getFileType(buffer) {
    const { fileTypeFromBuffer } = await import("file-type");
    return fileTypeFromBuffer(buffer);
  }

  return {
    async analyzeOutfit({ userId, image, audio, details }) {
      if (image.size > MAX_IMAGE_BYTES) {
        const error = new Error("Image must be at most 5 MiB");
        error.code = "IMAGE_TOO_LARGE";
        throw error;
      }

      const imageType = await getFileType(image.buffer);
      if (
        !imageType ||
        !acceptedImageTypes.has(imageType.mime) ||
        imageType.mime !== image.mimetype
      ) {
        throw new UnsupportedUploadTypeError(
          "Image must be a JPEG, PNG, or WebP with a matching content type"
        );
      }

      if (audio) {
        const audioType = await getFileType(audio.buffer);
        if (!audioType || !audioTypes[audio.mimetype]?.includes(audioType.mime)) {
          throw new UnsupportedUploadTypeError(
            "Voice note must be an MP3, WAV, or M4A with a matching content type"
          );
        }
      }

      if (details.outfitId) {
        await store.getDraft({ outfitId: details.outfitId, userId });
      }

      const analysis = await analyze({
        image: image.buffer,
        mimeType: imageType.mime,
        userId,
      });
      const saved = await store.save({
        userId,
        image: image.buffer,
        mimeType: imageType.mime,
        analysis,
        ...(details.outfitId ? { outfitId: details.outfitId } : {}),
        ...(details.outfitName ? { outfitName: details.outfitName } : {}),
        ...(details.occasion ? { occasion: details.occasion } : {}),
        ...(details.category ? { category: details.category } : {}),
        ...(audio
          ? { audio: { buffer: audio.buffer, mimeType: audio.mimetype } }
          : {}),
      });

      if (details.outfitId) return saved;
      return {
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
      };
    },
  };
}

module.exports = {
  createAnalyzeService,
  MAX_IMAGE_BYTES,
  UnsupportedUploadTypeError,
};
