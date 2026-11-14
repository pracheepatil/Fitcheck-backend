import express from "express";
import {
  createSessionController,
  firebaseTestController,
  signInController,
  signUpController
} from "../controllers/authController.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";

const router = express.Router();

router.post("/signin", signInController);
router.post("/signup", signUpController);
router.post("/session", verifyFirebaseToken, createSessionController);
router.get("/firebase-test", firebaseTestController);

export default router;