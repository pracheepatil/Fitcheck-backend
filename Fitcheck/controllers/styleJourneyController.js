const { requireAuthentication } = require("../middleware/auth");
const { DEFAULT_STYLE_JOURNEY_WEEKS, MAX_STYLE_JOURNEY_WEEKS } = require("../services/outfits");

function createStyleJourneyController(dependencies) {
  async function getStyleJourney(req, res, next) {
    const weeksValue = req.query.weeks ?? String(DEFAULT_STYLE_JOURNEY_WEEKS);
    const weeks = typeof weeksValue === "string" && /^[1-9]\d*$/.test(weeksValue)
      ? Number(weeksValue)
      : NaN;
    if (!Number.isSafeInteger(weeks) || weeks > MAX_STYLE_JOURNEY_WEEKS) {
      return res.status(400).json({
        error: `weeks must be a positive integer no greater than ${MAX_STYLE_JOURNEY_WEEKS}`,
      });
    }

    try {
      const result = await dependencies.store.getStyleJourney({
        userId: req.user.uid,
        weeks,
      });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  return [requireAuthentication(dependencies.auth), getStyleJourney];
}

module.exports = { createStyleJourneyController };
