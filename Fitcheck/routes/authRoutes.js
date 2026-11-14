const express = require("express");
const {
  createSessionController,
  firebaseTestController,
  signInController,
  signUpController
} = require("../controllers/authController");
const { verifyFirebaseToken } = require("../middleware/verifyFirebaseToken");

const router = express.Router();

router.post("/signin", signInController);
router.post("/signup", signUpController);
router.post("/session", verifyFirebaseToken, createSessionController);
router.get("/firebase-test", firebaseTestController);

module.exports = router;