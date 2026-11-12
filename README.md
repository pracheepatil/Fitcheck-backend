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

`POST /analyze` expects `multipart/form-data` containing exactly one file field
named `image`. JPEG, PNG, and WebP files up to 5 MiB are accepted. The file's
signature and declared MIME type must match. Signature validation is not a
complete image decode or malware scan.

```sh
curl -X POST http://localhost:5000/analyze \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -F "image=@outfit.jpg;type=image/jpeg"
```

Successful requests return `201` with:

```json
{
  "outfit": {
    "id": "generated-uuid",
    "userId": "firebase-user-id",
    "storagePath": "outfits/generated-uuid",
    "mimeType": "image/jpeg",
    "status": "complete",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "analysis": {
      "summary": "A short outfit summary.",
      "strengths": ["A positive detail."],
      "suggestions": ["A constructive suggestion."],
      "colorPalette": ["blue", "white"]
    }
  }
}
```

The storage path is not a public URL. Clients cannot read private objects using
this endpoint; a future authenticated retrieval or signed-URL flow must enforce
ownership. This change does not wire the separate frontend, whose placeholder
API differs from this endpoint.

Invalid uploads return `400`, unsupported or mismatched image types return
`415`, and oversized images return `413`. Unexpected service failures return
`500`; error details are logged on the server, not returned to the client.

To avoid storing an outfit when analysis fails, the server analyzes first.
It then creates a pending Firestore record, uploads the image, and marks the
record complete. On persistence failure it attempts to delete the record and
object; failures are logged. Firestore and Cloud Storage do not provide a
cross-service transaction: crashes, ambiguous network failures, or failed
cleanup can leave orphaned objects or records. Operators should monitor logs
and reconcile pending records / orphaned objects. The API does not provide
idempotency, so retries can create duplicate outfits.

Run unit and local HTTP integration tests with `npm test` from `Fitcheck/`.
They use fake Firebase services and a fake ADK model; an actual Firebase project,
private bucket, Firebase user token, and Gemini API key are needed for a
separate end-to-end verification.