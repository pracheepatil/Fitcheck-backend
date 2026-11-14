const express = require("express");
const { db } = require("../config/firebaseAdmin");

const router = express.Router();

router.get("/firebase-test", async (req, res) => {
  try {
    await db.collection("system").doc("test").set({
      project: "fitcheck-685be",
      message: "Firebase Admin is connected",
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "Firebase Admin and Firestore are connected"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;