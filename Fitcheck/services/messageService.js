const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../config/firebaseAdmin");

async function saveMessage({ name, email, subject, message }) {
  const messageReference = await db.collection("fitcheck_messages").add({
    name,
    email,
    subject,
    message,
    createdAt: FieldValue.serverTimestamp()
  });

  return messageReference.id;
}

module.exports = { saveMessage };
