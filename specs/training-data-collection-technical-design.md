# Technical Design: Training Data Collection for Whisper Fine-Tuning

## 1. Overview

Build a training data collection mode that lets the user accumulate paired audio + transcription samples through normal app usage. When enabled, audio files are retained indefinitely, AI post-processing is disabled (so transcriptions are raw Whisper output), and the history UI allows inline correction of transcriptions. Corrected samples are visually highlighted. The dataset grows over time and can be consumed by fine-tuning tooling later.

**Requirements spec**: `specs/training-data-collection.md`

## 2. Context

### Current State

**Audio pipeline**: The user records via MediaRecorder (WebM format). The WebM blob is sent to the main process, where `whisperServer._convertToWav()` (`src/helpers/whisperServer.js:520-539`) converts it to 16kHz mono WAV via FFmpeg, sends it to the whisper-server HTTP endpoint, then **deletes the WAV**. The WebM blob is separately saved to `{userData}/audio/` by `audioStorage.js` for history playback.

**Transcription storage**: `database.js` stores transcriptions in a `transcriptions` table with `text`, `raw_text`, `model`, `provider`, `audio_duration_ms`, `has_audio`, and `status` columns. When AI post-processing is off (or unavailable), `text` and `raw_text` are identical — both are raw Whisper output.

**Audio retention**: `cleanupExpiredAudio()` runs on startup and every 6 hours (`ipcHandlers.js:151-174`), deleting WebM files older than 30 days and clearing `has_audio` flags in the database.

**History UI**: `TranscriptionItem.tsx` shows the processed text as the main content. A collapsible section (toggled via a FileText icon button) shows `raw_text` with a "No AI processing applied" note when they match. The raw text is read-only.

**AI post-processing**: `audioManager.js:923-999` (`processTranscription`) sends text through a reasoning model using prompts from `promptData.json` that remove fillers, fix grammar, etc. Controlled by the `useReasoningModel` setting. When disabled, Whisper output passes through with only `.trim()`.

**Important**: Whisper itself already removes filler words and cleans up speech. This is inherent to the model, not a post-processing step. The training data correction flow is about fixing Whisper's mistakes (wrong words, missed context), not about filler removal.

### Constraints

- Audio format stays as WebM on disk. WAV conversion for fine-tuning is a future batch step — not part of this feature.
- No new database file or table. Extend the existing `transcriptions` table.
- Training data collection is a single-user local feature. No cloud sync, no multi-device concerns.
- Must not break the existing transcription flow. If training data operations fail (disk full, permissions), the transcription should still complete normally.

## 3. Architecture

### High-Level Approach

Extend the existing transcription and audio storage systems rather than building a parallel training data pipeline. Training mode is a behavioral toggle that:

1. Disables AI post-processing (so `text` = raw Whisper output)
2. Disables audio file cleanup (so WebM files persist indefinitely)
3. Makes transcription text editable in the history UI
4. Stores corrections in a new `corrected_transcription` column
5. Visually highlights corrected items

This avoids duplicating storage, introducing new database files, or changing the audio format. The existing WebM files + SQLite records **are** the training dataset, with corrections layered on top.

### Component Design

#### 1. Settings: `trainingDataEnabled` toggle

**Files**: `src/stores/settingsStore.ts`, `src/components/SettingsPage.tsx`, `src/locales/*/translation.json`

New boolean setting `trainingDataEnabled` (default: `false`). Follows the existing `dataRetentionEnabled` pattern:

- Add to `BOOLEAN_SETTINGS` set
- Add to `SettingsState` interface with getter/setter
- Initialize with `readBoolean("trainingDataEnabled", false)`
- Create setter via `createBooleanSetter("trainingDataEnabled")`

**UI**: Toggle in the Settings page, in or near the Privacy/Data Retention section. When enabled, show an informational note explaining that audio files will be retained indefinitely and AI post-processing will be disabled.

**Prerequisite**: `dataRetentionEnabled` must be `true`. The training mode toggle is disabled (greyed out) when data retention is off. If the user disables data retention while training mode is on, training mode is automatically disabled too.

**Side effects on enable**:
- Force `useReasoningModel` to `false` (disable AI post-processing)
- The setting should remain independently toggleable, but while `trainingDataEnabled` is true, reasoning is suppressed regardless of the `useReasoningModel` value

**Side effects on disable**:
- Audio cleanup resumes on the next 6-hour cycle
- History items become read-only again
- Existing corrections in the database are preserved (not deleted)
- `useReasoningModel` returns to whatever value the user had set

#### 2. AI Post-Processing Suppression

**File**: `src/helpers/audioManager.js`

In `processTranscription()` (line 923), add an early return when training mode is enabled:

```javascript
async processTranscription(text, source) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText) { /* ... existing ... */ }

  // Training mode: skip all post-processing to preserve raw Whisper output
  if (getSettings().trainingDataEnabled) {
    return normalizedText;
  }

  // ... existing reasoning logic ...
}
```

This ensures `text` and `raw_text` are always identical in training mode, giving us the unmodified Whisper output.

#### 3. Audio Retention Override

**File**: `src/helpers/ipcHandlers.js`

In `_setupAudioCleanup()` (line 151), check `trainingDataEnabled` before running cleanup:

```javascript
_setupAudioCleanup() {
  const DEFAULT_RETENTION_DAYS = 30;
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  const runCleanupIfAllowed = () => {
    // Skip audio cleanup entirely when training data collection is active
    const trainingEnabled = /* read trainingDataEnabled from localStorage or settings */;
    if (trainingEnabled) {
      debugLogger.info("Audio cleanup skipped — training data collection is active", {}, "audio-storage");
      return;
    }
    this.audioStorageManager.cleanupExpiredAudio(DEFAULT_RETENTION_DAYS, this.databaseManager);
  };

  try { runCleanupIfAllowed(); } catch (error) { /* ... */ }
  this._audioCleanupInterval = setInterval(() => {
    try { runCleanupIfAllowed(); } catch (error) { /* ... */ }
  }, SIX_HOURS_MS);
}
```

**Note**: The `trainingDataEnabled` setting lives in the renderer's localStorage. The main process needs to read it. Options:
- Read from the `.env` file (persist via `saveAllKeysToEnvFile()` like `LOCAL_TRANSCRIPTION_PROVIDER`)
- Add an IPC call for the renderer to push the setting to main on change
- Read localStorage directly from the main process (not possible with context isolation)

**Recommendation**: Persist to `.env` via `saveAllKeysToEnvFile()`. The main process already reads `.env` on startup. The setter in the settings store should call `saveAllKeysToEnvFile()` when toggling this setting, following the existing pattern for `LOCAL_TRANSCRIPTION_PROVIDER`.

#### 4. Database Schema Changes

**File**: `src/helpers/database.js`

Two new columns on the `transcriptions` table:

```javascript
// In the constructor, after existing ALTER TABLE migrations:
try {
  this.db.exec("ALTER TABLE transcriptions ADD COLUMN corrected_transcription TEXT");
} catch (err) {
  if (!err.message.includes("duplicate column")) throw err;
}
try {
  this.db.exec("ALTER TABLE transcriptions ADD COLUMN language TEXT");
} catch (err) {
  if (!err.message.includes("duplicate column")) throw err;
}
```

**No `is_corrected` column.** Correction status is derived: `corrected_transcription IS NOT NULL` means corrected. If the user edits back to match the original, `corrected_transcription` is set to `NULL`.

**New methods**:

```javascript
updateTranscriptionCorrection(id, correctedText, originalText) {
  // If corrected text matches original, clear the correction
  const value = correctedText === originalText ? null : correctedText;
  const stmt = this.db.prepare(
    "UPDATE transcriptions SET corrected_transcription = ? WHERE id = ?"
  );
  return stmt.run(value, id);
}
```

**Modified `getTranscriptions`**: No query change needed — `SELECT *` already picks up new columns. The renderer just needs to use the new fields.

#### 5. Language Persistence

**File**: `src/helpers/audioManager.js`, `src/helpers/ipcHandlers.js`, `src/helpers/database.js`

The language code is currently passed to whisper-server but never stored. Thread it through:

1. `processWithLocalWhisper()` (audioManager.js:583) already reads `language` from settings
2. Include `language` in `lastAudioMetadata` (alongside `durationMs`, `provider`, `model`)
3. In the `save-transcription-audio` IPC handler (ipcHandlers.js:394), pass `language` to a new `updateTranscriptionLanguage()` DB method, or extend `updateTranscriptionAudio()` to accept it

#### 6. History UI: Editable Transcriptions with Correction Highlighting

**File**: `src/components/ui/TranscriptionItem.tsx`

The component receives a new `trainingDataEnabled` prop (read from settings in the parent `HistoryView.tsx`).

**When training mode is OFF**: No behavior change. Everything works as today.

**When training mode is ON**:

**Default state (no correction yet)**:
- Main text is rendered as a `contentEditable` element (or a textarea that looks like the current text display)
- No collapsible section (nothing to show — text hasn't been edited)
- On blur after editing: compare edited text to `item.raw_text`
  - If different: save to `corrected_transcription` via IPC, show highlight + collapsible section
  - If same: no-op

**After correction**:
- Item gets a visual highlight — a colored left border (e.g., `border-l-2 border-primary`) or a subtle background tint
- Main text shows the corrected version (editable)
- Collapsible section appears below, labeled "Original model output", showing `item.raw_text` (read-only)
- Brief save confirmation indicator (e.g., a momentary checkmark or "Saved" text that fades out)

**Revert behavior**:
- If the user edits the text back to match `item.raw_text`, `corrected_transcription` is set to `NULL`
- The highlight and collapsible section disappear
- The item returns to its default state

**Implementation approach**: Use a controlled textarea or `contentEditable` div. On blur, compare against `item.raw_text`. Debounce is unnecessary since save only triggers on blur.

#### 7. New IPC Channel: `update-transcription-correction`

**Files**: `preload.js`, `src/helpers/ipcHandlers.js`

```javascript
// preload.js
updateTranscriptionCorrection: (id, correctedText, originalText) =>
  ipcRenderer.invoke("update-transcription-correction", id, correctedText, originalText),

// ipcHandlers.js
ipcMain.handle("update-transcription-correction", async (event, id, correctedText, originalText) => {
  const result = this.databaseManager.updateTranscriptionCorrection(id, correctedText, originalText);
  if (result.changes > 0) {
    this.broadcastToWindows("transcription-updated", { id, correctedText, originalText });
  }
  return { success: result.changes > 0 };
});
```

The `broadcastToWindows` call ensures both the main overlay and the control panel stay in sync if both are open.

### Data Model

**Modified `transcriptions` table**:

| Column | Type | New? | Description |
|---|---|---|---|
| `id` | INTEGER PK | No | Auto-increment ID |
| `text` | TEXT | No | Final text (= raw Whisper output when training mode is on) |
| `raw_text` | TEXT | No | Raw transcription (identical to `text` when no post-processing) |
| `corrected_transcription` | TEXT | **Yes** | User-edited correction. NULL = not corrected. |
| `language` | TEXT | **Yes** | Language code passed to Whisper (e.g., "en", "auto") |
| `timestamp` | DATETIME | No | When created |
| `has_audio` | INTEGER | No | Whether WebM audio file exists on disk |
| `audio_duration_ms` | INTEGER | No | Audio duration |
| `provider` | TEXT | No | Transcription provider |
| `model` | TEXT | No | Whisper model used |
| `status` | TEXT | No | "completed" or "failed" |
| `error_message` | TEXT | No | Error details if failed |

**Correction status is derived**: `corrected_transcription IS NOT NULL`.

### API Contracts

**New IPC channels**:

| Channel | Direction | Parameters | Returns |
|---|---|---|---|
| `update-transcription-correction` | renderer → main | `(id: number, correctedText: string, originalText: string)` | `{ success: boolean }` |

**Modified IPC channels**:

| Channel | Change |
|---|---|
| `save-transcription-audio` | Accept `language` in metadata object |

**New broadcast events**:

| Event | Payload | Description |
|---|---|---|
| `transcription-updated` | `{ id, correctedText, originalText }` | Fired when a correction is saved, keeps windows in sync |

## 4. Alternatives Considered

### Separate training_samples table or database
Considered a dedicated `training_samples` table (or even a separate SQLite file in a user-configured training folder) with its own lifecycle independent of transcription history. Rejected because:
- The existing `transcriptions` table already stores everything needed (text, model, audio reference)
- A separate table means duplicating data or cross-referencing with foreign keys that break when history items are deleted
- The simpler approach is to just prevent deletion when training mode is on
- A separate database adds connection management, a second migration system, and portability concerns that aren't justified for a single-user local feature

### Storing WAV instead of (or alongside) WebM
Considered converting and storing the 16kHz WAV at recording time for training-ready audio. Rejected because:
- WAV files are ~10x larger than WebM for the same audio
- The conversion to WAV is a trivial FFmpeg batch operation that can happen later
- Keeping WebM avoids changing the existing audio storage pipeline
- The user confirmed that a transformation step before training is acceptable

### metadata.json sidecar files per sample
The original spec proposed a folder-per-sample structure with JSON sidecars. Rejected because:
- Querying correction status across all samples requires scanning directories and parsing JSON files
- Updating a correction means read-parse-modify-write on every edit
- The existing SQLite database already provides fast queries and atomic updates
- The folder structure can be generated as an export step if needed for specific tooling

### Dedicated `is_corrected` boolean column
Considered adding an explicit `is_corrected` column to the database. Rejected because it's pure denormalization — `corrected_transcription IS NOT NULL` provides the same information without a second column to keep in sync.

## 5. Migration & Rollout Strategy

### Database Migration
Two `ALTER TABLE ADD COLUMN` statements, following the existing try/catch pattern in `database.js` constructor. These are backward-compatible — existing rows get `NULL` defaults, and no data migration is needed.

### Settings Migration
New `trainingDataEnabled` setting defaults to `false`. No migration needed — the setting simply doesn't exist until the user enables it.

### Feature Flag
None needed. The feature is gated behind the `trainingDataEnabled` setting toggle. When off, the app behaves exactly as before.

### Rollback
Disabling training mode restores all previous behavior. Corrections already saved in the database remain but are inert (the UI doesn't show edit affordances, and the `corrected_transcription` column is simply ignored). Audio cleanup resumes. No destructive rollback needed.

## 6. Test Plan

### Unit Tests

**Database layer** (`database.js`):
- `updateTranscriptionCorrection` saves corrected text when it differs from original
- `updateTranscriptionCorrection` sets `corrected_transcription` to NULL when corrected text matches original
- New columns have NULL defaults and don't break existing queries
- `getTranscriptions` returns `corrected_transcription` and `language` fields

**Settings store** (`settingsStore.ts`):
- `trainingDataEnabled` defaults to false
- Enabling training mode reads back correctly from localStorage
- Setting persists to `.env` for main process access

**Post-processing suppression** (`audioManager.js`):
- `processTranscription` returns trimmed text without modification when `trainingDataEnabled` is true
- `processTranscription` still applies reasoning when `trainingDataEnabled` is false

### Integration Tests

**Audio retention override**:
- With `trainingDataEnabled=true`: audio cleanup runs but deletes nothing
- With `trainingDataEnabled=false`: audio cleanup deletes files older than 30 days as before
- Toggling training mode off mid-session: next cleanup cycle resumes deletion

**Correction IPC round-trip**:
- Renderer sends correction → main process updates DB → broadcast sent → renderer receives update
- Concurrent edits from multiple windows resolve correctly (last write wins)

**Language persistence**:
- Language code flows from settings → audioManager → IPC → database
- Stored language matches what was passed to whisper-server

### End-to-End Tests

**Core training flow**:
1. Enable training mode in settings
2. Record a dictation
3. Verify: transcription appears in history with no AI processing applied
4. Verify: audio file is saved (WebM) and not cleaned up after retention period
5. Click into transcription text, make an edit, click away
6. Verify: item is highlighted, collapsible section shows "Original model output"
7. Verify: correction is persisted (reload app, correction still there)

**Revert flow**:
1. Edit a corrected transcription back to match the original
2. Verify: highlight disappears, collapsible section disappears, `corrected_transcription` is NULL

**Mode toggle**:
1. Disable training mode
2. Verify: history items are no longer editable
3. Verify: existing corrections and highlights still display (read-only)
4. Verify: AI post-processing resumes for new transcriptions

## 7. Open Questions

1. **~~Data retention interaction~~**: Resolved — training mode requires `dataRetentionEnabled=true` as a hard prerequisite. The toggle is disabled when data retention is off, and disabling data retention automatically disables training mode.

2. **Existing audio files**: When training mode is first enabled, should we retroactively protect existing audio files from the next cleanup cycle? (Current design: yes — cleanup is simply skipped entirely while training mode is on, which protects all existing files.)

3. **Storage visibility**: Should the settings UI show disk usage for training data (number of samples, total audio size)? Not required for MVP, but useful for users accumulating large datasets.

4. **Bulk export**: Should we plan an IPC channel or menu action for exporting the training dataset (e.g., generate a JSONL manifest + copy audio files to a chosen folder)? Not in scope for this feature, but worth considering the hook points now.
