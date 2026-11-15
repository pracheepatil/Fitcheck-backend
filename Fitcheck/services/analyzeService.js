const {
  OutfitAlreadyUploadedError,
  OutfitNotFoundError,
} = require("./outfits");
const { lookup } = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
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

class ImageUrlError extends Error {}
class ImageTooLargeError extends Error {}
class ImageFetchError extends Error {}

function isPublicIPv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function downloadImage(imageUrl) {
  let url;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new ImageUrlError("Image must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ImageUrlError("Image must be a valid HTTPS URL");
  }

  let addresses;
  try {
    if (net.isIP(url.hostname)) {
      addresses = [{ address: url.hostname, family: net.isIP(url.hostname) }];
    } else {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    }
  } catch {
    throw new ImageFetchError("Unable to resolve the image URL");
  }
  const publicIPv4 = addresses.find(({ address, family }) =>
    family === 4 && isPublicIPv4(address)
  );
  if (!publicIPv4) {
    throw new ImageUrlError("Image URL must resolve to a public IPv4 address");
  }
  const address = publicIPv4.address;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.get(url, {
      headers: { Accept: "image/jpeg, image/png, image/webp" },
      timeout: IMAGE_FETCH_TIMEOUT_MS,
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family: 4 }]);
        } else {
          callback(null, address, 4);
        }
      },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new ImageFetchError(`Image server returned HTTP ${response.statusCode}`));
        return;
      }

      const mimeType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (!acceptedImageTypes.has(mimeType)) {
        response.resume();
        fail(new UnsupportedUploadTypeError("Image URL must return a JPEG, PNG, or WebP image"));
        return;
      }

      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        response.destroy();
        fail(new ImageTooLargeError("Image must be at most 5 MiB"));
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_IMAGE_BYTES) {
          response.destroy();
          request.destroy();
          fail(new ImageTooLargeError("Image must be at most 5 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ buffer: Buffer.concat(chunks), mimeType });
      });
      response.on("error", (error) => fail(new ImageFetchError(error.message)));
    });
    request.on("timeout", () => request.destroy(new ImageFetchError("Image request timed out")));
    request.on("error", (error) => fail(
      error instanceof ImageFetchError ? error : new ImageFetchError("Unable to fetch image URL")
    ));
  });
}

function createAnalyzeService({ analyze, store, fetchImage = downloadImage }) {
  async function getFileType(buffer) {
    const { fileTypeFromBuffer } = await import("file-type");
    return fileTypeFromBuffer(buffer);
  }

  function saveOutfitReferences({ userId, imageUrl, audioUrl, details, analysis }) {
    return store.saveReferences({
      userId,
      imageUrl,
      audioUrl,
      analysis,
      ...details,
    });
  }

  return {
    saveOutfitReferences,

    async analyzeImageUrl({ userId, imageUrl, audioUrl, details }) {
      const image = await fetchImage(imageUrl);
      const imageType = await getFileType(image.buffer);
      if (
        !imageType ||
        !acceptedImageTypes.has(imageType.mime) ||
        imageType.mime !== image.mimeType
      ) {
        throw new UnsupportedUploadTypeError(
          "Image URL must return a JPEG, PNG, or WebP image with a matching content type"
        );
      }

      const analysis = await analyze({
        image: image.buffer,
        mimeType: imageType.mime,
        userId,
      });
      return saveOutfitReferences({
        userId,
        imageUrl,
        audioUrl,
        details,
        analysis,
      });
    },

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
  ImageUrlError,
  ImageTooLargeError,
  ImageFetchError,
  UnsupportedUploadTypeError,
};
