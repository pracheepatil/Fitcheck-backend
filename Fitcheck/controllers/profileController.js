const { AESTHETICS, ProfileNotFoundError, getProfile, updateProfile } = require("../services/profileService");

const EDITABLE_FIELDS = ["name", "styleGoal", "aesthetics"];

// Returns the validated changes, or null when the body is invalid.
function validateProfileUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !EDITABLE_FIELDS.includes(key))) return null;

  const changes = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 256) return null;
    changes.name = body.name.trim();
  }

  if ("styleGoal" in body) {
    if (typeof body.styleGoal !== "string" || body.styleGoal.trim().length > 500) return null;
    changes.styleGoal = body.styleGoal.trim();
  }

  if ("aesthetics" in body) {
    const aesthetics = body.aesthetics;
    if (
      !Array.isArray(aesthetics) ||
      aesthetics.length > AESTHETICS.length ||
      new Set(aesthetics).size !== aesthetics.length ||
      aesthetics.some((value) => !AESTHETICS.includes(value))
    ) {
      return null;
    }
    changes.aesthetics = aesthetics;
  }

  return changes;
}

async function getProfileController(req, res, next) {
  try {
    const profile = await getProfile(req.user.uid);
    return res.json({ success: true, profile });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }
    return next(error);
  }
}

async function updateProfileController(req, res, next) {
  const changes = validateProfileUpdate(req.body);
  if (!changes) {
    return res.status(400).json({
      success: false,
      message: `Provide at least one of ${EDITABLE_FIELDS.join(", ")} with valid values. aesthetics must be unique values from: ${AESTHETICS.join(", ")}`
    });
  }

  try {
    const profile = await updateProfile(req.user.uid, changes);
    return res.json({ success: true, message: "Profile updated successfully", profile });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }
    return next(error);
  }
}

module.exports = { validateProfileUpdate, getProfileController, updateProfileController };
