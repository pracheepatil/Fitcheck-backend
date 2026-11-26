const { resolve4 } = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const { getAnalyzeLifecycleStepNumber, writeLogSafely } = require("./logging");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/webm"]);
const AUDIO_DOWNLOAD_TYPES = new Set([...AUDIO_TYPES, "video/webm", "application/octet-stream"]);
const MAX_MEDIA_REDIRECTS = 5;

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
  const aliases = { "audio/x-m4a": "audio/mp4", "audio/x-wav": "audio/wav", "video/webm": "audio/webm" };
  const mimeType = label === "Audio" && detected?.mime === "video/webm"
    ? "audio/webm"
    : detected && (aliases[detected.mime] || detected.mime);
  const declaredType = aliases[contentType] || contentType;
  if (!mimeType || !allowedTypes.has(mimeType) || (declaredType &&
      declaredType !== "application/octet-stream" && declaredType !== mimeType &&
      !(label === "Audio" && declaredType === "video/webm" && mimeType === "audio/webm"))) {
    throw new InvalidMediaError(`${label} URL content does not match an allowed file type`);
  }
  return { buffer, mimeType };
}

function isAllowedDownloadContentType(label, contentType, allowedTypes) {
  if (!contentType) return true;
  if (allowedTypes.has(contentType)) return true;
  if (contentType === "application/octet-stream") return true;
  return label === "Audio" && contentType === "video/webm";
}

async function downloadMedia(value, label, maxBytes, allowedTypes, redirectCount = 0) {
  const url = validateMediaUrl(value, label);
  const address = await resolvePublicIPv4(url.hostname);
  const acceptTypes = label === "Audio"
    ? [...new Set([...allowedTypes, "video/webm", "application/octet-stream"])]
    : [...allowedTypes];

  const downloaded = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.get(url, {
      headers: { Accept: acceptTypes.join(", ") },
      timeout: FETCH_TIMEOUT_MS,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= MAX_MEDIA_REDIRECTS) {
          fail(new MediaFetchError("Media URL could not be downloaded"));
          return;
        }
        try {
          const redirectTarget = new URL(response.headers.location, url).href;
          downloadMedia(redirectTarget, label, maxBytes, allowedTypes, redirectCount + 1).then(resolve).catch(fail);
        } catch (error) {
          fail(error instanceof InvalidMediaError || error instanceof MediaFetchError
            ? error : new MediaFetchError("Unable to download media URL"));
        }
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new MediaFetchError("Media URL could not be downloaded"));
        return;
      }
      const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (!isAllowedDownloadContentType(label, contentType, allowedTypes)) {
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

function createAnalyzeService({ analyze, store, fetchMedia = downloadMedia, logger }) {
  async function writeLifecycleLog(stage, fields = {}) {
    if (!logger) return;
    try {
      await writeLogSafely(logger, {
        logType: "analyze_lifecycle",
        stage,
        stepNumber: getAnalyzeLifecycleStepNumber(stage),
        ...fields,
      });
    } catch (error) {
      try {
        console.error("Failed to prepare analyze lifecycle log:", error?.message || error);
      } catch {}
    }
  }

  async function runLifecycleStep(
    startedStage,
    completedStage,
    failedStage,
    fields,
    operation,
    getCompletionDetails = () => ({}),
  ) {
    const startedAt = Date.now();
    await writeLifecycleLog(startedStage, { ...fields, status: "started" });
    try {
      const result = await operation();
      await writeLifecycleLog(completedStage, {
        ...fields,
        ...getCompletionDetails(result),
        status: "completed",
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await writeLifecycleLog(failedStage, {
        ...fields,
        status: "failed",
        severity: "ERROR",
        durationMs: Date.now() - startedAt,
        errorName: error?.name || "Error",
      });
      throw error;
    }
  }

  async function fetchMediaWithLogging(mediaUrl, label, maxBytes, allowedTypes) {
    if (!logger) return fetchMedia(mediaUrl, label, maxBytes, allowedTypes);
    let host;
    try {
      host = new URL(mediaUrl).hostname;
    } catch {
      host = "unknown";
    }
    return logger.logServiceCall("HTTPS", `media.${label.toLowerCase()}`, () =>
      fetchMedia(mediaUrl, label, maxBytes, allowedTypes), { urlHost: host });
  }

  return {
    async analyzeOutfit({ userId, image, audio, details }) {
      validateMediaUrl(image, "Image");
      if (audio != null) validateMediaUrl(audio, "Audio");

      const photoResponse = await runLifecycleStep(
        "image_download_started",
        "image_download_completed",
        "image_download_failed",
        { mediaType: "image" },
        () => fetchMediaWithLogging(image, "Image", MAX_IMAGE_BYTES, IMAGE_TYPES),
      );
      const photo = await validateMediaContent(
        photoResponse.buffer,
        "Image",
        MAX_IMAGE_BYTES,
        IMAGE_TYPES,
        photoResponse.contentType,
      );

      let voice;
      if (audio == null) {
        await writeLifecycleLog("audio_skipped", { status: "skipped", reason: "not_provided" });
      } else {
        const audioResponse = await runLifecycleStep(
          "audio_download_started",
          "audio_download_completed",
          "audio_download_failed",
          { mediaType: "audio" },
          () => fetchMediaWithLogging(audio, "Audio", MAX_AUDIO_BYTES, AUDIO_TYPES),
        );
        voice = await validateMediaContent(
          audioResponse.buffer,
          "Audio",
          MAX_AUDIO_BYTES,
          AUDIO_TYPES,
          audioResponse.contentType,
        );
      }

      if (logger) {
        await writeLogSafely(logger, {
          logType: "analyze_input",
          hasAudio: !!voice,
          audioMimeType: voice?.mimeType,
          audioBytes: voice?.buffer?.length,
          imageMimeType: photo.mimeType,
          imageBytes: photo.buffer.length,
        });
      }

      const outfitId = await runLifecycleStep(
        "submission_creation_started",
        "submission_created",
        "submission_creation_failed",
        {
          hasAudio: !!voice,
          payload: {
            userId,
            ...details,
            image: { mimeType: photo.mimeType, bytes: photo.buffer.length },
            audio: voice ? { mimeType: voice.mimeType, bytes: voice.buffer.length } : null,
          },
        },
        () => store.createSubmission({
          userId, image: photo.buffer, mimeType: photo.mimeType, ...details, audio: voice,
        }),
        (createdOutfitId) => ({ outfitId: createdOutfitId }),
      );
      try {
        const analysis = await runLifecycleStep(
          "gemini_analysis_started",
          "gemini_analysis_completed",
          "gemini_analysis_failed",
          { outfitId },
          () => analyze({
            image: photo.buffer, mimeType: photo.mimeType, userId,
            outfitName: details.outfitName, occasion: details.occasion, category: details.category, audio: voice,
          }),
        );
        await runLifecycleStep(
          "firestore_analysis_complete_started",
          "firestore_analysis_completed",
          "firestore_analysis_complete_failed",
          {
            outfitId,
            payload: { outfitId, userId, analysis },
          },
          () => store.completeAnalysis({ outfitId, userId, analysis }),
          (response) => ({ response }),
        );
      } catch (error) {
        await writeLifecycleLog("analysis_failed", {
          outfitId,
          status: "failed",
          severity: "ERROR",
          errorName: error?.name || "Error",
        });
        try {
          await runLifecycleStep(
            "analysis_failure_status_update_started",
            "analysis_failure_status_update_completed",
            "analysis_failure_status_update_failed",
            { outfitId },
            () => store.failAnalysis({ outfitId, userId }),
          );
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
  createAnalyzeService, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, AUDIO_DOWNLOAD_TYPES, InvalidMediaError,
  MediaFetchError, validateMediaUrl, validateMediaContent, resolvePublicIPv4, downloadMedia,
};
