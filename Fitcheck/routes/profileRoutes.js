const express = require("express");
const { firebaseAuth } = require("../config/firebaseAdmin");
const { requireAuthentication } = require("../middleware/auth");
const { getProfileController, updateProfileController } = require("../controllers/profileController");

const router = express.Router();

router.get("/", requireAuthentication(firebaseAuth), getProfileController);
router.patch("/", requireAuthentication(firebaseAuth), updateProfileController);

module.exports = router;
