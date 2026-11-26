function requireAuthentication(auth, onFailure) {
  const invalidTokenCodes = new Set([
    "auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired",
    "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found",
  ]);
  return async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
    if (!match) {
      await onFailure?.({ reason: "missing_token", statusCode: 401 });
      return res.status(401).json({ error: "A Firebase ID token is required" });
    }
    try {
      req.user = await auth.verifyIdToken(match[1], true);
      if (!req.user.uid) throw new Error("Verified token has no user ID");
      return next();
    } catch (error) {
      if (invalidTokenCodes.has(error.code)) {
        await onFailure?.({ reason: "invalid_token", statusCode: 401 });
        return res.status(401).json({ error: "Invalid or expired Firebase ID token" });
      }
      await onFailure?.({ reason: "verification_error", statusCode: 500 });
      return next(error);
    }
  };
}

module.exports = { requireAuthentication };
