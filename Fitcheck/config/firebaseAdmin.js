const {
  getApps,
  initializeApp,
  applicationDefault
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const firebaseApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.REACT_APP_FIREBASE_PROJECT_ID
      });

const firebaseAuth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
module.exports = { firebaseAuth, db };