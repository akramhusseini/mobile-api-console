-- Adds the meta_json column to events for browser metadata (captureMode,
-- browserSession, tabId, pageUrl, webRequestId, etc.). Existing rows
-- keep meta_json = NULL, so the parser-derived fields are absent until
-- the event is re-upserted.

ALTER TABLE events ADD COLUMN meta_json TEXT;
