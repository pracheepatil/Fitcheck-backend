import { firebaseAuth } from "../config/firebaseAdmin.js";

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (
      !authorizationHeader ||
      !authorizationHeader.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is missing"
      });
    }

    const token = authorizationHeader.substring(7);

    // verifyIdToken is provided by Firebase Admin SDK
    const decodedToken = await firebaseAuth.verifyIdToken(token);

    req.firebaseUser = decodedToken;

    next();
  } catch (error) {
    console.error("Token verification error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired Firebase token"
    });
  }
}