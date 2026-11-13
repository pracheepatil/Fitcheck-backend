import "dotenv/config";
import {
  getApps,
  initializeApp,
  applicationDefault
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const firebaseApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: applicationDefault(),
        projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID
      });

export const firebaseAuth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);