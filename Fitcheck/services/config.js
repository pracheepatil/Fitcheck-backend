const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { createAnalyzer, createStyleMentor } = require("./gemini");
const { createOutfitStore } = require("./outfits");
const { createLogger } = require("./logging");

function createDependencies(env) {
  for (const name of ["GOOGLE_CLOUD_PROJECT", "FIREBASE_STORAGE_BUCKET", "GEMINI_API_KEY", "GEMINI_MODEL"]) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true" || env.GOOGLE_GENAI_USE_VERTEXAI === "1") {
    throw new Error("GOOGLE_GENAI_USE_VERTEXAI must be disabled when using the Gemini API");
  }
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: env.GOOGLE_CLOUD_PROJECT,
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
  });
  const logger = createLogger({ projectId: env.GOOGLE_CLOUD_PROJECT });
  return {
    auth: getAuth(app),
    logger,
    analyze: createAnalyzer(env.GEMINI_MODEL, env.GEMINI_API_KEY, undefined, logger),
    styleMentor: createStyleMentor(env.GEMINI_MODEL, env.GEMINI_API_KEY, undefined, logger),
    store: createOutfitStore(getFirestore(app), getStorage(app).bucket()),
  };
}

module.exports = { createDependencies };
