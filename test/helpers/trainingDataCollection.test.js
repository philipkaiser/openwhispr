const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDb } = require("./harness/db");
const { loadAudioManager } = require("./harness/audioManager");

test("training mode protects expired audio and transcription labels", (t) => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  const old = process.env.TRAINING_DATA_ENABLED;
  t.after(() => {
    if (old === undefined) delete process.env.TRAINING_DATA_ENABLED;
    else process.env.TRAINING_DATA_ENABLED = old;
  });
  const calls = [];
  const context = {
    _retentionSettings: { audioRetentionDays: 30, transcriptRetentionDays: 7 },
    databaseManager: {
      deleteTranscriptionsExpiredBefore() {
        calls.push("transcripts");
        return { ids: [], analyticsPurged: 0 };
      },
    },
    audioStorageManager: {
      cleanupExpiredAudio() {
        calls.push("audio");
      },
    },
  };
  process.env.TRAINING_DATA_ENABLED = "true";
  IPCHandlers.prototype._runRetentionCleanup.call(context);
  assert.deepEqual(calls, []);
  process.env.TRAINING_DATA_ENABLED = "false";
  IPCHandlers.prototype._runRetentionCleanup.call(context);
  assert.deepEqual(calls, ["transcripts", "audio"]);
});

test("migration preserves training audio metadata and corrections across restarts", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { id } = db.saveTranscription("original text", "original text");
  db.updateTranscriptionAudio(id, {
    hasAudio: 1,
    audioDurationMs: 15000,
    provider: "local",
    model: "whisper",
    language: "de",
  });
  db.updateTranscriptionCorrection(id, "corrected text", "original text");
  const before = db.getTranscriptionById(id);
  db.db.close();
  db.initDatabase();
  assert.deepEqual(db.getTranscriptionById(id), before);
  assert.equal(before.raw_text, "original text");
  assert.equal(before.corrected_transcription, "corrected text");
  assert.equal(before.has_audio, 1);
  assert.equal(before.language, "de");
  db.updateTranscriptionCorrection(id, "original text", "original text");
  assert.equal(db.getTranscriptionById(id).corrected_transcription, null);
});

test("upgrading a legacy training database retains its samples", (t) => {
  const { installElectronStub, setUserDataDir } = require("./harness/electronStub");
  installElectronStub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-training-upgrade-"));
  setUserDataDir(dir);
  const SQLite = require("better-sqlite3");
  const legacy = new SQLite(path.join(dir, "transcriptions.db"));
  legacy.exec(`CREATE TABLE transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw_text TEXT, has_audio INTEGER NOT NULL DEFAULT 0, audio_duration_ms INTEGER,
    provider TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'completed', error_message TEXT,
    corrected_transcription TEXT, language TEXT
  ); INSERT INTO transcriptions (text, raw_text, has_audio, audio_duration_ms, corrected_transcription, language)
     VALUES ('original', 'original', 1, 42000, 'corrected', 'de');`);
  const before = legacy.prepare("SELECT * FROM transcriptions").get();
  legacy.close();
  const DatabaseManager = require("../../src/helpers/database");
  const db = new DatabaseManager();
  t.after(() => {
    db.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const after = db.getTranscriptionById(before.id);
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, key);
  assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("training mode bypasses local, cloud and streaming post-processing routes", async (t) => {
  const { createManager, vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-training-",
    settingsKey: "__trainingSettings",
    settings: { trainingDataEnabled: true, useCleanupModel: true, preferredLanguage: "zh-TW" },
  });
  const manager = createManager({
    isReasoningAvailable: () => {
      throw new Error("Post-processing must not run");
    },
  });
  assert.equal(
    await manager.processTranscription("  original model output  ", "local"),
    "original model output"
  );
  const { resolveReasoningRoute } = await vite.ssrLoadModule("/helpers/audioManager.js");
  assert.deepEqual(
    resolveReasoningRoute("text", globalThis.__trainingSettings, "agent", true, true),
    { kind: "none" }
  );
  assert.equal(await manager.finalizeChineseScript("原文"), "原文");
});
