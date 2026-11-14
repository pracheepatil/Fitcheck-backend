const express = require("express");
const { sendMessageController } = require("../controllers/messageController");

const router = express.Router();

router.post("/sendMessage", sendMessageController);

module.exports = router;
