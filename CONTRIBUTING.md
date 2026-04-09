# Contributing

## Development setup

1. Install dependencies with `npm install`.
2. Compile with `npm run compile`.
3. Open the project in VS Code.
4. Press `F5` to launch an Extension Development Host.

## Contribution priorities

- Keep the MVP current-file-first and command-first.
- Prefer robust heuristics over fragile intelligence theater.
- Avoid fake precision in feedback or grading.
- Preserve the local-only privacy model.
- Keep UI additions readable and restrained.

## Architecture notes

- `contextExtractor.ts` handles active editor and symbol extraction.
- `config.ts` and `secrets.ts` separate non-secret settings from secure key storage.
- `aiClient.ts` runs optional AI-mode calls in the extension host only.
- `quizGenerator.ts` creates three questions from heuristics.
- `feedback.ts` returns reflection output, not correctness scoring.
- `storage.ts` persists small local-only stats in extension storage.
- `panel.ts` owns the webview panel and message bridge.
- `media/` contains the client-side UI.

## Pull requests

- Keep PRs scoped.
- Explain any heuristic changes with before-and-after examples.
- Mention any UI deviations from the rounded, flat, playful visual system.
- Never pass API keys into the webview or plain settings.
- Do not add hosted services or external telemetry in MVP work.

## Good first issues

- Improve symbol fallback logic
- Refine question variety without adding LLMs
- Add lightweight tests for heuristics
- Improve empty states and unsupported-file messaging
