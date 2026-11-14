import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebaseAdmin.js";

export async function saveMessage({ name, email, subject, message }) {
  const messageReference = await db.collection("fitcheck_messages").add({
    name,
    email,
    subject,
    message,
    createdAt: FieldValue.serverTimestamp()
  });

  return messageReference.id;
}
