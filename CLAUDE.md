# wopr-plugin-voice-chatterbox

TTS plugin for Chatterbox — a self-hosted, OpenAI-compatible TTS server.

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run format    # biome format --write src/
npm test          # vitest run
```

## Key Details

- Implements the `tts` capability provider from `@wopr-network/plugin-types`
- Chatterbox is OpenAI-compatible — uses OpenAI SDK with a custom `baseURL` pointing to the Chatterbox server
- Self-hosted: user runs Chatterbox locally or on their own server. No API key required by default.
- Config: `baseURL` (e.g. `http://localhost:8000`) and optionally `apiKey`
- **Use case**: Free/local TTS alternative to hosted providers

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-voice-chatterbox`.
