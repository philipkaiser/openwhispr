# Feature: Training Data Collection for Whisper Fine-Tuning

## Problem Statement

The user wants to fine-tune their local Whisper model to improve transcription accuracy for their specific speech patterns and vocabulary. To do this, they need paired training data: audio files matched with correct transcriptions. Currently, OpenWhispr deletes audio files immediately after transcription and only surfaces post-processed text (filler words removed), making it impossible to collect training data through normal usage.

The goal is to build a growing dataset over time through regular app usage — dictate as normal, and when the model gets something wrong, correct it right there in the UI. No separate tooling or workflow required.

## Success Criteria

- Every transcription (when training data collection mode is enabled) produces a self-contained training sample on disk
- The user can correct wrong transcriptions directly in the existing history UI
- Corrected samples are visually distinguishable from uncorrected ones
- Training data persists independently of the app's transcription history (no auto-deletion)
- The dataset is structured for easy consumption by fine-tuning tooling

## Scope

### In Scope

- Training data collection mode toggle and output path configuration in settings
- Saving audio + transcription data to disk per sample
- Inline editing of raw transcriptions in the history UI
- Visual flagging of corrected items
- Auto-creation of the output directory if it doesn't exist

### Out of Scope

- Fine-tuning pipeline or tooling (separate concern)
- Retroactive data collection for past transcriptions (no audio available)
- Export/import functionality (data lands directly in the configured folder)
- Any changes to the transcription or post-processing pipeline itself
- Cloud Whisper API support (local model only, though the data format should not preclude it)

## Data Specification

### Per-Sample Folder Structure

Each transcription produces its own subfolder in the configured training data path:

```
<training-data-path>/
  <sample-id>/
    audio.wav
    metadata.json
```

### Audio File

- Format: 16kHz mono 16-bit WAV (the exact input to the Whisper model, as converted by FFmpeg)
- Approximately 115 MB per hour of audio

### metadata.json

| Field                          | Type           | Description                                                                                          |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                           | string         | Unique sample identifier                                                                             |
| `timestamp`                    | ISO 8601       | When the transcription was created                                                                   |
| `raw_transcription`            | string         | Direct Whisper output                                                                                |
| `post_processed_transcription` | string \| null | Filler-word-removed version (null if no AI processing was applied)                                   |
| `corrected_transcription`      | string \| null | User-edited version (null if not edited, or if edit matches raw)                                     |
| `is_corrected`                 | boolean        | Whether the user has modified the raw transcription (true only when corrected text differs from raw) |
| `was_post_processed`           | boolean        | Whether AI post-processing was applied to this transcription                                         |
| `whisper_model`                | string         | Model used (e.g., "turbo", "base", or a custom model name)                                           |
| `language`                     | string         | Language code (e.g., "en", "de", or "auto")                                                          |

## User Stories / Flows

### Enabling Training Mode

1. User opens Settings
2. User toggles "Training Data Collection" on
3. User specifies (or confirms) a folder path for training data output
4. If the path doesn't exist, the app creates it
5. If the path is not writable, the app shows an error

### Normal Dictation with Training Mode On

1. User dictates as normal (hotkey to start/stop)
2. Transcription completes and appears in history as usual
3. In the background: the audio WAV and metadata JSON are written to a new subfolder in the training data path
4. The transcription history item behaves normally (paste to clipboard, post-processing, etc.)

### Correcting a Transcription

1. User opens the transcription history
2. User expands a history item (clicks the raw transcript button that already exists)
3. The raw transcript text is editable (when training mode is on)
4. User edits the text to fix transcription errors
5. On blur (click away), the edit auto-saves
6. A brief save confirmation indicator appears
7. If the edited text differs from the raw transcription:
   - The `corrected_transcription` and `is_corrected` fields in the JSON sidecar are updated
   - The history item is visually highlighted in a distinct color to indicate it was corrected
8. If the user edits back to match the original raw transcription, the corrected flag is removed and the highlight disappears

### Training Data Persistence

- Training data in the configured folder is never deleted by the app
- The app's auto-deletion of transcription history (after ~7 days) does not affect training data on disk
- Deleting a transcription from the app's history does not delete the corresponding training sample

## Edge Cases & Error Handling

- **Path becomes unwritable mid-session** (e.g., external drive disconnected): Log the error, skip saving the training sample, do not interrupt the transcription flow. The user should not lose their transcription because training data failed to save.
- **Disk full**: Same behavior — fail gracefully, log, don't block the transcription.
- **Training mode toggled off**: Stop saving new samples immediately. Existing samples on disk are untouched. Editing in the history UI reverts to read-only for raw transcripts.
- **No AI processing applied**: `post_processed_transcription` is null, `was_post_processed` is false. All other fields still captured normally.

## Decisions

- **Sample folder naming**: Timestamp-based (e.g., `2026-03-29T155100`). Human-readable, sortable, and collision risk is negligible for single-user local usage.
- **Training mode indicator**: None needed beyond the settings toggle. The user intends to run training mode continuously.
