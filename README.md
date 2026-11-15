# FitCheck backend: outfit analysis

The backend accepts outfit photos, analyzes them with Gemini through Google
ADK, and saves files in a private Firebase Storage bucket and metadata in
Firestore. Saved analyses can be retrieved separately.

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
Email/password sign-in also requires `FIREBASE_WEB_API_KEY` from the same
Firebase project and the email/password provider enabled in Firebase Auth.

## API

Send a Firebase Authentication ID token as `Authorization: Bearer <ID_TOKEN>`.
The backend verifies it and checks revocation using the Firebase Admin SDK.
There is **no** `X-Dev-User` bypass: no existing implementation was present in
this repository. Token verification failures return 401; infrastructure
failures return 500.

The merged backend also exposes `POST /api/auth/signup` (JSON `email`,
`password`, `fullName`), `POST /api/auth/signin` (JSON `email`, `password`),
and `POST /api/auth/session` (Firebase ID token). `GET /api/health` checks
that the server is responding.

### Submit an outfit

`POST /analyze` (also `/api/analyze`) requires `application/json`. The backend
gets the user ID from the verified token and generates a new UUID for each
submission. Do not send an `outfitId`. `image` and optional `audio` must be
HTTPS URLs that the backend can fetch; the URLs must return the actual media
files.

| Field | Required | Notes |
|---|---|---|
| `image` | yes | HTTPS URL returning JPEG, PNG or WebP, at most 5 MiB. |
| `audio` | no | HTTPS URL returning MP3, WAV or M4A, at most 25 MiB; omit or use `null` when unavailable. |
| `outfitName` | yes | Non-blank text, at most 100 characters. |
| `occasion` | yes | Event or situation (e.g. Party or Job Interview); non-blank, at most 100 characters. |
| `category` | yes | Outfit classification (e.g. Western or Formal); non-blank, at most 100 characters. |

The backend fetches media over HTTPS, verifies actual file signatures, and
uploads the bytes to the existing Firebase Storage bucket. URLs must resolve
only to public IPv4 addresses; redirects, private addresses and non-HTTPS URLs
are rejected. The source server must be reachable by Cloud Run without
interactive browser authentication. Unknown fields and invalid media return
`400`; unreachable URLs return `502`. Authentication is required.
The request waits for analysis to finish and returns `201` with exactly:

```json
{ "status": "success", "outfitId": "generated-uuid" }
```

For example:

```json
{
  "image": "https://your-public-host.example/outfit.jpg",
  "audio": "https://your-public-host.example/voice-note.m4a",
  "outfitName": "Black Evening Dress",
  "occasion": "Party",
  "category": "Western"
}
```

`audio` may instead be omitted or set to `null`. Occasion and category are
passed to Gemini as context. Request JSON is limited to 64 KiB.

### Retrieve the analysis

`GET /getOutfitAnalysis?userId=...&outfitId=...` (also under `/api`) returns the
owner's linked `outfit`, `media`, `analysis`, and `scores` objects. The user ID
must match the authenticated Firebase user. `outfit.analysis` maps
`next_direction` to a one-item `suggestions` array and `primary_colors` to
`colorPalette`.

While analysis is in progress, GET returns `202` with
`{"status":"pending","outfitId":"..."}`. If it failed, GET returns `200`
with `{"status":"failed","outfitId":"..."}`. A missing or unowned outfit
returns `404`; a user ID that does not match the token returns `403`.

After signing in with Firebase in the frontend, use the signed-in user's
`uid` and call `await auth.currentUser.getIdToken()` on the existing Firebase
Auth instance. Copy the ID token into a private terminal session as
`FIREBASE_ID_TOKEN`; do not share it or commit it. The backend's email/password
`POST /api/auth/signin` also returns `idToken` and `user.uid`. ID tokens expire,
so obtain a fresh one if necessary.

```sh
export BASE_URL="http://localhost:5001"
# Obtain a Firebase ID token securely; do not commit or share it.
curl -X POST "$BASE_URL/analyze" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"image":"https://your-public-host.example/outfit.jpg","outfitName":"Summer Casual","occasion":"Party","category":"Casual"}'
# Use the returned outfitId below.
curl -G "$BASE_URL/getOutfitAnalysis" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  --data-urlencode "userId=FIREBASE_UID" --data-urlencode "outfitId=OUTFIT_ID"
```

Replace the placeholder with the actual photo URL. Send JSON with media URLs
and call GET for the full result. The default port is `5001`. If
`CORS_ALLOWED_ORIGINS` is configured, only the listed browser origins are
allowed; if unset the existing wildcard behavior remains.

### Firestore collections

Each completed upload has one linked record in each collection:

- `fitcheck_outfit_details`: `outfitId`, `userId`, `outfitName`, `occasion`,
  `category`, `createdAt` (Timestamp), `status` (`pending`, `uploaded`, or `failed`).
- `fitcheck_outfit_media`: `mediaId`, `outfitId`, `type` (`photo`),
  `PhotoStoragePath`, `PhotoUrl`, `AudioStoragePath`, `AudioUrl` (empty when no
  voice note), `uploadedAt`. Files are stored under `outfits/<outfitId>/photos/` and
  `outfits/<outfitId>/audio/`.
- `fitcheck_outfit_analysis`: `analysis_id`, `outfit_id`, `user_id`, `image_url`,
  `style_category`, `outfit_title`, `overall_score` (0-100), `summary`,
  `color_description`, `primary_colors`, `strengths`, `next_direction`,
  `created_at`.
- `fitcheck_outfit_analysis_scores`: `score_id`, `analysis_id`,
  `color_harmony_score`, `style_matching_score`, `balance_layering_score`,
  `accessories_score` (each 0-100), `created_at`.

Successful GET requests return the four records:

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

Unexpected failures return `500`; details are logged on the server, not
returned to the client. The server uploads files and creates the pending
outfit and media records, then runs Gemini and atomically saves the analysis,
scores, and `uploaded` status. AI failures mark the outfit `failed` when
possible. A process crash can leave `pending` records; no background recovery
is currently implemented.

Firestore and Cloud Storage have no cross-service transaction. On a failed
upload, confirmed earlier uploads are cleaned up, but an object with an
uncertain upload outcome is retained for reconciliation. Files are also
retained if the Firestore creation commit has an uncertain outcome. A failed
request does not return the outfit ID, so operators may need to reconcile
pending or failed records and orphaned files using server logs. Retrying creates
a new outfit.

Run the local backend tests with `npm test` from `Fitcheck/`.

## Cloud Run deployment

Do not run these commands until the project owner approves cloud changes.
From `Fitcheck/`, the source deployment uses Google Cloud buildpacks and the
existing `npm start`; the server binds to `0.0.0.0` and uses `PORT`. The
`.gcloudignore` excludes local environment files, credentials, and dependencies.

Enable the relevant services (requires permission to enable APIs):

```sh
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com \
  identitytoolkit.googleapis.com storage.googleapis.com \
  secretmanager.googleapis.com \
  --project fitcheck-685be
```

The existing Gemini integration uses the Gemini Developer API with an API key,
not Vertex AI. Enable the API in the project associated with the Gemini API
key, substituting its project ID (which may differ from the backend project):

```sh
gcloud services enable generativelanguage.googleapis.com \
  --project YOUR_GEMINI_KEY_PROJECT_ID
```

Ensure the chosen model is available to that key. Do not enable Vertex AI
mode. Before deploying, configure
the existing Cloud Run service with `GOOGLE_CLOUD_PROJECT`,
`FIREBASE_STORAGE_BUCKET`, `GEMINI_MODEL`, and the frontend's exact
`CORS_ALLOWED_ORIGINS`. Provide `GEMINI_API_KEY` from Secret Manager;
`FIREBASE_WEB_API_KEY` is also required for email/password sign-in. These
settings must exist on the service **before** the exact deployment command
below; the command does not create or set them. Never put secrets in source or
command-line arguments. The first deployment requires a separate configuration
step, or a pre-existing service with these settings.

For the existing service, set the exact frontend origin after replacing the
placeholder (this updates the existing service and creates a revision):

```sh
gcloud run services update fitcheck-api --project fitcheck-685be \
  --region us-central1 --update-env-vars 'CORS_ALLOWED_ORIGINS=https://YOUR-FRONTEND-ORIGIN'
```

In the Cloud Run console, configure the other variables and secret references
if missing. Secret Manager recommends pinning a specific secret version for
environment variables rather than `latest`.

The specified runtime service account needs Firestore read/write access
(`roles/datastore.user`), Storage object read/create/delete on the specific
bucket (`roles/storage.objectUser`), Firebase Auth user read for revoked-token
checks (and create/delete if signup is used), and `roles/secretmanager.secretAccessor`
on the relevant secrets. Gemini Developer API access uses its API key. Verify
effective permissions and Secret Manager bindings before deployment; this
repository does not grant IAM permissions.

```sh
cd Fitcheck
gcloud config set project fitcheck-685be
gcloud run deploy fitcheck-api \
  --source . \
  --region us-central1 \
  --service-account fitcheck-api@fitcheck-685be.iam.gserviceaccount.com \
  --allow-unauthenticated
```

Cloud Run is publicly invokable, but the outfit APIs still require Firebase
authentication. Inspect logs with:

```sh
gcloud run services logs read fitcheck-api --project fitcheck-685be \
  --region us-central1 --limit 50
```
