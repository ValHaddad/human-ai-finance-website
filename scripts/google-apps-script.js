/**
 * Google Apps Script — Dual-Save Backup for Human × AI Finance Survey
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://script.google.com and create a new project
 * 2. Replace the default Code.gs content with this entire file
 * 3. Click Deploy > New deployment
 * 4. Select type: "Web app"
 * 5. Set "Execute as": "Me"
 * 6. Set "Who has access": "Anyone"
 * 7. Click Deploy and authorize when prompted
 * 8. Copy the Web app URL — paste it into submission-page/index.html
 *    where it says GOOGLE_SCRIPT_URL
 *
 * This script receives survey data and files from the submission form
 * and saves them to the specified Google Drive folder.
 */

// ─── Configuration ──────────────────────────────────────────
const FOLDER_ID = "1lNto7rIK0AF4nc1-S7keNbdpTJfJ46JA";

// ─── Main POST handler ─────────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    const action = payload.action; // "data" or "base64"
    const filename = sanitizeFilename(payload.filename);

    if (action === "base64") {
      // Decode base64 and save as binary file
      const decoded = Utilities.base64Decode(payload.data);
      const blob = Utilities.newBlob(decoded, payload.mimeType || "application/octet-stream", filename);
      folder.createFile(blob);
    } else {
      // Save text data (CSV, JSON) as-is
      folder.createFile(filename, payload.data, payload.contentType || "application/json");
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, filename: filename }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── Allow CORS preflight ───────────────────────────────────
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "Backup endpoint active" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Helpers ────────────────────────────────────────────────
function sanitizeFilename(name) {
  // Remove path traversal and invalid characters
  return String(name || "unnamed")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .substring(0, 200);
}
