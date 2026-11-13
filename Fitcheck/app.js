import cors from "cors";
import express from "express";
import authRoutes from "./routes/authRoutes.js";
import firebaseTestRoutes from "./routes/firebaseTestRoutes.js";
import fitcheckRoutes from "./routes/fitcheckRoutes.js";

const app = express();
const port = process.env.PORT || 3000;

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  })
);

app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api", firebaseTestRoutes);
app.use("/api", fitcheckRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "FitCheck backend is running"
  });
});

app.listen(port, () => {
  console.log(`FitCheck backend running on port ${port}`);
});