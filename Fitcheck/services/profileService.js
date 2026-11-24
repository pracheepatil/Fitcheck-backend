const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../config/firebaseAdmin");

const AESTHETICS = ["Casual", "Streetwear", "Formal", "Vintage", "Minimalist"];

class ProfileNotFoundError extends Error {}

function toProfile(uid, data) {
  return {
    uid,
    email: data.email || "",
    name: data.name || "",
    photoURL: data.photoURL || "",
    styleGoal: data.styleGoal || "",
    aesthetics: Array.isArray(data.aesthetics) ? data.aesthetics : [],
  };
}

async function getProfile(uid) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists) throw new ProfileNotFoundError();
  return toProfile(uid, snapshot.data());
}

async function updateProfile(uid, changes) {
  const reference = db.collection("users").doc(uid);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw new ProfileNotFoundError();
  await reference.update({ ...changes, updatedAt: FieldValue.serverTimestamp() });
  return getProfile(uid);
}

module.exports = { AESTHETICS, ProfileNotFoundError, getProfile, updateProfile };
