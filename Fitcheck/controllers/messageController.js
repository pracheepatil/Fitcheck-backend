import { saveMessage } from "../services/messageService.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendMessageController(req, res) {
  const { name, email, subject, message } = req.body ?? {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof email !== "string" ||
    !emailPattern.test(email.trim()) ||
    typeof subject !== "string" ||
    !subject.trim() ||
    typeof message !== "string" ||
    !message.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a name, valid email, subject, and message"
    });
  }

  try {
    const messageId = await saveMessage({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: subject.trim(),
      message: message.trim()
    });

    return res.status(201).json({
      success: true,
      message: "Message sent successfully",
      messageId
    });
  } catch (error) {
    console.error("Send message API error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not send message"
    });
  }
}
