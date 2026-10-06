const express = require("express");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Welcome endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Node.js Express JSON API is running",
    status: "success",
  });
});

// Get all users
app.get("/api/users", (req, res) => {
  res.json({
    users: [
      {
        id: 1,
        name: "Prachee",
        email: "prachee@example.com",
      },
      {
        id: 2,
        name: "Alex",
        email: "alex@example.com",
      },
    ],
  });
});

// Get one user
app.get("/api/users/:id", (req, res) => {
  res.json({
    id: req.params.id,
    name: "Sample User",
    message: "User retrieved successfully",
  });
});

// Receive JSON data
app.post("/api/users", (req, res) => {
  const user = req.body;

  res.status(201).json({
    message: "User created successfully",
    user: user,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
