const {
  AuthServiceError,
  createSession,
  runFirebaseTest,
  signIn,
  signUp
} = require("../services/authService");

async function signInController(req, res) {
  const { email, password } = req.body ?? {};

  if (
    typeof email !== "string" ||
    !email.trim() ||
    typeof password !== "string" ||
    !password
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid email and password"
    });
  }

  try {
    const result = await signIn(email, password);

    return res.status(200).json({
      success: true,
      message: "Signed in successfully",
      idToken: result.idToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: {
        uid: result.localId,
        email: result.email,
        fullName: result.displayName || ""
      }
    });
  } catch (error) {
    if (error instanceof AuthServiceError) {
      if (error.code === "CONFIGURATION_MISSING") {
        console.error("Sign-in API error: FIREBASE_WEB_API_KEY is not configured");

        return res.status(500).json({
          success: false,
          message: "Sign-in is not configured"
        });
      }

      if (
        error.code === "EMAIL_NOT_FOUND" ||
        error.code === "INVALID_PASSWORD" ||
        error.code === "INVALID_LOGIN_CREDENTIALS"
      ) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      if (error.code === "USER_DISABLED") {
        return res.status(403).json({
          success: false,
          message: "This account has been disabled"
        });
      }

      if (error.code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
        return res.status(429).json({
          success: false,
          message: "Too many sign-in attempts. Try again later"
        });
      }

      if (error.code === "OPERATION_NOT_ALLOWED") {
        return res.status(403).json({
          success: false,
          message: "Email and password sign-in is not enabled"
        });
      }

      if (error.code === "REQUEST_FAILED") {
        console.error("Sign-in API request failed:", error.cause);

        return res.status(502).json({
          success: false,
          message: "Could not reach Firebase Authentication"
        });
      }

      console.error("Sign-in API Firebase error:", error.code);

      return res.status(502).json({
        success: false,
        message: "Firebase Authentication could not sign in"
      });
    }

    console.error("Sign-in API request failed:", error);

    return res.status(502).json({
      success: false,
      message: "Could not reach Firebase Authentication"
    });
  }
}

async function signUpController(req, res) {
  const { email, password, fullName } = req.body ?? {};

  if (
    typeof email !== "string" ||
    !email.trim() ||
    typeof password !== "string" ||
    password.length < 6 ||
    typeof fullName !== "string" ||
    !fullName.trim() ||
    fullName.trim().length > 256
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid email, a password of at least 6 characters, and a full name of no more than 256 characters"
    });
  }

  try {
    const createdUser = await signUp(email, password, fullName);

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: {
        uid: createdUser.uid,
        email: createdUser.email,
        fullName: createdUser.displayName
      }
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists"
      });
    }

    if (
      error.code === "auth/invalid-email" ||
      error.code === "auth/invalid-password" ||
      error.code === "auth/weak-password"
    ) {
      return res.status(400).json({
        success: false,
        message: "The email or password is invalid"
      });
    }

    console.error("Signup API error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not create account"
    });
  }
}

async function createSessionController(req, res) {
  try {
    const user = await createSession(req.firebaseUser);

    return res.status(200).json({
      success: true,
      message: "User session created successfully",
      user
    });
  } catch (error) {
    console.error("Session API error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not save user session"
    });
  }
}

async function firebaseTestController(req, res) {
  try {
    await runFirebaseTest();

    return res.json({
      success: true,
      message: "Firebase Admin and Firestore are connected"
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }

}

module.exports = { signInController, signUpController, createSessionController, firebaseTestController };
