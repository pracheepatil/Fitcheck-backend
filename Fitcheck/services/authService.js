const { FieldValue } = require("firebase-admin/firestore");
const { db, firebaseAuth } = require("../config/firebaseAdmin");

class AuthServiceError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "AuthServiceError";
    this.code = code;
  }
}

async function signIn(email, password) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;

  if (!apiKey) {
    throw new AuthServiceError("CONFIGURATION_MISSING");
  }

  try {
    const firebaseResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          returnSecureToken: true
        })
      }
    );
    const result = await firebaseResponse.json();

    if (!firebaseResponse.ok) {
      throw new AuthServiceError(
        result.error?.message || "UNKNOWN_FIREBASE_ERROR"
      );
    }

    return result;
  } catch (error) {
    if (error instanceof AuthServiceError) {
      throw error;
    }

    throw new AuthServiceError("REQUEST_FAILED", { cause: error });
  }
}

async function signUp(email, password, fullName) {
  const createdUser = await firebaseAuth.createUser({
    email: email.trim().toLowerCase(),
    password,
    displayName: fullName.trim()
  });

  try {
    await db.collection("users").doc(createdUser.uid).set({
      uid: createdUser.uid,
      email: createdUser.email,
      name: createdUser.displayName,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    try {
      await firebaseAuth.deleteUser(createdUser.uid);
    } catch (cleanupError) {
      console.error(
        `Could not roll back Firebase Auth user ${createdUser.uid}:`,
        cleanupError
      );
    }

    throw error;
  }

  return createdUser;
}

async function createSession(firebaseUser) {
  const { uid, email, name, picture } = firebaseUser;
  const userReference = db.collection("users").doc(uid);
  const userSnapshot = await userReference.get();

  if (!userSnapshot.exists) {
    await userReference.set({
      uid,
      email: email || "",
      name: name || email?.split("@")[0] || "FitCheck User",
      photoURL: picture || "",
      createdAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp()
    });
  } else {
    await userReference.update({
      lastLoginAt: FieldValue.serverTimestamp(),
      email: email || "",
      name: name || ""
    });
  }

  const updatedUser = await userReference.get();
  return updatedUser.data();
}

async function runFirebaseTest() {
  await db.collection("system").doc("test").set({
    project: "fitcheck-685be",
    message: "Firebase Admin is connected",
    createdAt: new Date().toISOString()
  });
}

module.exports = { AuthServiceError, signIn, signUp, createSession, runFirebaseTest };
