const { resolve4 } = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a"]);

class InvalidMediaError extends Error {}
class MediaFetchError extends Error {}

function validateMediaUrl(value, label) {
  if (typeof value !== "string" || !value || value.length > 16_384) {
    throw new InvalidMediaError(`${label} must be a valid HTTPS URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidMediaError(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || url.hostname.length > 253) {
    throw new InvalidMediaError(`${label} must be a valid HTTPS URL`);
  }
  return url;
}

function isPublicIPv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function resolvePublicIPv4(hostname, resolveIPv4 = resolve4) {
  if (net.isIP(hostname)) {
    if (net.isIP(hostname) !== 4 || !isPublicIPv4(hostname)) throw new InvalidMediaError("Media URL must use a public HTTPS host");
    return hostname;
  }
  let addresses;
  try {
    addresses = await resolveIPv4(hostname);
  } catch {
    throw new MediaFetchError("Unable to resolve media URL");
  }
  if (!addresses.length || addresses.some((address) => !isPublicIPv4(address))) {
    throw new InvalidMediaError("Media URL must resolve only to public IPv4 addresses");
  }
  return addresses[0];
}

async function validateMediaContent(buffer, label, maxBytes, allowedTypes, contentType) {
  if (!buffer.length) throw new InvalidMediaError(`${label} URL returned an empty file`);
  if (buffer.length > maxBytes) throw new InvalidMediaError(`${label} exceeds the size limit`);
  const { fileTypeFromBuffer } = await import("file-type");
  let detected;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch (error) {
    if (error.name !== "EndOfStreamError") throw error;
  }
  const aliases = { "audio/x-m4a": "audio/mp4", "audio/x-wav": "audio/wav" };
  const mimeType = detected && (aliases[detected.mime] || detected.mime);
  const declaredType = aliases[contentType] || contentType;
  if (!mimeType || !allowedTypes.has(mimeType) || (declaredType &&
      declaredType !== "application/octet-stream" && declaredType !== mimeType)) {
    throw new InvalidMediaError(`${label} URL content does not match an allowed file type`);
  }
  return { buffer, mimeType };
}

async function downloadMedia(value, label, maxBytes, allowedTypes) {
  const url = validateMediaUrl(value, label);
  const address = await resolvePublicIPv4(url.hostname);

  const downloaded = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.get(url, {
      headers: { Accept: [...allowedTypes].join(", ") },
      timeout: FETCH_TIMEOUT_MS,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new MediaFetchError("Media URL could not be downloaded"));
        return;
      }
      const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (contentType && !allowedTypes.has(contentType) &&
          !(contentType === "application/octet-stream")) {
        response.resume();
        fail(new InvalidMediaError(`${label} URL returned an unsupported content type`));
        return;
      }
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy();
        fail(new InvalidMediaError(`${label} exceeds the size limit`));
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          response.destroy();
          request.destroy();
          fail(new InvalidMediaError(`${label} exceeds the size limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (!settled) {
          settled = true;
          resolve({ buffer: Buffer.concat(chunks), contentType });
        }
      });
      response.on("error", () => fail(new MediaFetchError("Unable to read media response")));
    });
    request.on("timeout", () => request.destroy(new MediaFetchError("Media request timed out")));
    request.on("error", (error) => fail(
      error instanceof MediaFetchError ? error : new MediaFetchError("Unable to download media URL")
    ));
  });

  return downloaded;
}

function createAnalyzeService({ analyze, store, fetchMedia = downloadMedia }) {
  return {
    async analyzeOutfit({ userId, image, audio, details }) {
      validateMediaUrl(image, "Image");
      if (audio != null) validateMediaUrl(audio, "Audio");
      const photoResponse = await fetchMedia(image, "Image", MAX_IMAGE_BYTES, IMAGE_TYPES);
      const photo = await validateMediaContent(photoResponse.buffer, "Image", MAX_IMAGE_BYTES, IMAGE_TYPES, photoResponse.contentType);
      const audioResponse = audio == null ? undefined : await fetchMedia(audio, "Audio", MAX_AUDIO_BYTES, AUDIO_TYPES);
      const voice = audioResponse && await validateMediaContent(
        audioResponse.buffer, "Audio", MAX_AUDIO_BYTES, AUDIO_TYPES, audioResponse.contentType,
      );
      const outfitId = await store.createSubmission({
        userId, image: photo.buffer, mimeType: photo.mimeType, ...details, audio: voice,
      });
      try {
        const analysis = await analyze({
          image: photo.buffer, mimeType: photo.mimeType, userId,
          occasion: details.occasion, category: details.category,
        });
        await store.completeAnalysis({ outfitId, userId, analysis });
      } catch (error) {
        try {
          await store.failAnalysis({ outfitId, userId });
        } catch (statusError) {
          throw new AggregateError([error, statusError], `Analysis failed and status could not be updated for ${outfitId}`);
        }
        throw error;
      }
      return outfitId;
    },
  };
}

module.exports = {
  createAnalyzeService, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, InvalidMediaError, MediaFetchError,
  validateMediaUrl, validateMediaContent, resolvePublicIPv4,
};
