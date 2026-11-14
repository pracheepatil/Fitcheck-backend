import express from "express";
import { sendMessageController } from "../controllers/messageController.js";

const router = express.Router();

router.post("/sendMessage", sendMessageController);

export default router;
