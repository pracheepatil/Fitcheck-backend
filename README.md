# FitCheck backend: outfit analysis

The `api-fit-analyze` branch provides an authenticated `POST /analyze` endpoint.
It accepts an outfit photo, analyzes it with Gemini through Google ADK, and
saves the image to a private Cloud Storage for Firebase / Google Cloud Storage
bucket and the resulting metadata to Firestore.

## Setup

1. Use Node.js **24.13 or newer** and npm 11.8 or newer.
2. In Google Cloud / Firebase, configure a project with Firebase Authentication,
   Firestore, and an existing **private** storage bucket. Block public access
   using the bucket's IAM and public-access-prevention settings. Configure
   Firestore security rules to prevent unauthorized reads and writes; the
   Firebase Admin SDK bypasses those rules.
3. Give the backend's service account permission to verify Firebase ID tokens
   (including revoked-token checks), read user status, write and delete the
   relevant Firestore documents, and create/delete objects in the bucket.
   The Admin SDK uses Application Default Credentials. For local development,
   use `gcloud auth application-default login` or set
   `GOOGLE_APPLICATION_CREDENTIALS` to a service-account credential file kept
   outside the repository. Never commit credentials.
4. Create a Gemini API key in Google AI Studio. The server sends the uploaded
   image to the Gemini API for analysis; ensure this is appropriate for the
   application's privacy policy.
5. From `Fitcheck/`, install dependencies and configure the environment:

   ```sh
   npm ci
   cp .env.example .env
   # Edit .env locally; do not commit it.
   node --env-file=.env app.js
   ```

`GOOGLE_CLOUD_PROJECT`, `FIREBASE_STORAGE_BUCKET`, `GEMINI_API_KEY`, and
`GEMINI_MODEL` are required. The bucket name is the bare name, not a `gs://`
URL. Set `GEMINI_MODEL` to an available Gemini API model that supports image
input and structured output. `GOOGLE_GENAI_USE_VERTEXAI` must not be enabled.
The backend does not create the bucket, provision Firebase, or set security
rules. The Node version requirement follows Google ADK's TypeScript quickstart.

## API

Send a Firebase Authentication ID token as `Authorization: Bearer <ID_TOKEN>`.
The backend verifies it and checks revocation using the Firebase Admin SDK.
There is **no** `X-Dev-User` bypass: no existing implementation was present in
this repository. Token verification failures return 401; infrastructure
failures return 500.

`POST /analyze` expects `multipart/form-data` with:

| Field | Required | Notes |
|---|---|---|
| `image` | yes | JPEG, PNG or WebP, at most 5 MiB. Signature and MIME type must match. |
| `outfitName` | no | Text, at most 100 characters. |
| `occasion` | no | Text, at most 100 characters (e.g. `Party`). |
| `category` | no | Text, at most 100 characters (e.g. `Casual`). |
| `audio` | no | Voice note: MP3, WAV or M4A, at most 25 MiB. |

Unknown fields are rejected with `400`. The default port is `5001` (macOS uses
5000 for AirPlay). Browser clients are allowed only from the origins listed in
`CORS_ALLOWED_ORIGINS` (comma-separated, for example `http://localhost:3000`).

```sh
curl -X POST http://localhost:5001/analyze \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -F "image=@outfit.jpg;type=image/jpeg" \
  -F "outfitName=Summer Casual" -F "occasion=Party" -F "category=Casual"
```

### Firestore collections

Each upload writes one linked record to each collection:

- `fitcheck_outfit_details`: `outfitId`, `userId`, `outfitName`, `occasion`,
  `category`, `createdAt` (Timestamp), `status` (`uploaded`).
- `fitcheck_outfit_media`: `mediaId`, `outfitId`, `type` (`photo`),
  `PhotoStoragePath`, `PhotoUrl`, `AudioStoragePath`, `AudioUrl` (empty when no
  voice note), `uploadedAt`. Files are stored at
  `outfits/<outfitId>/photos/front.<ext>` and
  `outfits/<outfitId>/audio/voice-note.<ext>`.
- `fitcheck_outfit_analysis`: `analysis_id`, `outfit_id`, `user_id`, `image_url`,
  `style_category`, `outfit_title`, `overall_score` (0-100), `summary`,
  `color_description`, `primary_colors`, `strengths`, `next_direction`,
  `created_at`.
- `fitcheck_outfit_analysis_scores`: `score_id`, `analysis_id`,
  `color_harmony_score`, `style_matching_score`, `balance_layering_score`,
  `accessories_score` (each 0-100), `created_at`.

Successful requests return `201` with the four records:

```json
{
  "outfit": { "outfitId": "uuid", "userId": "firebase-uid", "outfitName": "Summer Casual", "occasion": "Party", "category": "Casual", "createdAt": "2026-01-01T00:00:00.000Z", "status": "uploaded" },
  "media": { "mediaId": "uuid", "outfitId": "uuid", "type": "photo", "PhotoStoragePath": "outfits/<id>/photos/front.jpg", "PhotoUrl": "https://firebasestorage.googleapis.com/...", "AudioStoragePath": "", "AudioUrl": "", "uploadedAt": "2026-01-01T00:00:00.000Z" },
  "analysis": { "analysis_id": "uuid", "outfit_id": "uuid", "user_id": "firebase-uid", "image_url": "https://...", "style_category": "Casual", "outfit_title": "The everyday edit", "overall_score": 82, "summary": "...", "color_description": "...", "primary_colors": ["blue"], "strengths": ["..."], "next_direction": "...", "created_at": "2026-01-01T00:00:00.000Z" },
  "scores": { "score_id": "uuid", "analysis_id": "uuid", "color_harmony_score": 90, "style_matching_score": 80, "balance_layering_score": 75, "accessories_score": 60, "created_at": "2026-01-01T00:00:00.000Z" }
}
```

`PhotoUrl` points at the private bucket and is not publicly readable. A future
authenticated retrieval or signed-URL flow must enforce ownership. Voice notes
are stored but not analyzed.

Invalid uploads return `400`, unsupported or mismatched file types `415`, and
oversized files `413`. Unexpected failures return `500`; details are logged on
the server, not returned to the client.

The server analyzes first, so nothing is stored when analysis fails. It then
uploads the files and writes the four Firestore records in a single batch. If
the batch fails it deletes the uploaded files; failures are logged. Firestore
and Cloud Storage have no cross-service transaction, so a crash or failed
cleanup can leave orphaned files. The API has no idempotency, so retries can
create duplicate outfits.
