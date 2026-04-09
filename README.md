# VibeQuiz

VibeQuiz is a VS Code extension that quizzes you on the code you just wrote so you can tell whether you actually understand it.

## Why it exists

Modern coding speed is high, especially with AI assistance. Shipping code is easier than internalizing it. VibeQuiz closes that gap with three short, context-aware reflection questions based on the file you are actively editing.

The MVP is intentionally narrow:

- Command-driven only
- Current-file context only
- Local-only storage
- Reflection prompts instead of fake grading
- Secure BYOK support for optional AI mode

## What the MVP does

- Adds `VibeQuiz: Quiz Me` to the command palette
- Reads the active editor, selection, and nearby symbol context
- Detects changed code from unsaved edits first, then falls back to git-vs-HEAD when possible
- Falls back to latest-commit-vs-previous-commit when the working tree is clean
- Generates three short questions from lightweight heuristics or optional AI mode
- Opens a rounded, playful webview UI with free-text answers
- Stores local quiz count, last quiz timestamp, streak, and recent weak-area tags
- Supports OpenAI, Anthropic Claude, Google Gemini, and OpenAI-compatible backends

## Secure BYOK

VibeQuiz does not require an API key in heuristic mode.

If you want AI-assisted quiz generation:

- Run `VibeQuiz: Set API Key`
- The key is stored in VS Code Secret Storage, not in settings, files, or the webview
- Switch to AI mode with `VibeQuiz: Enable AI Mode`
- Adjust non-secret settings like provider, model, or base URL in VS Code settings under `vibeQuiz.ai`

Built-in commands:

- `VibeQuiz: Set API Key`
- `VibeQuiz: Clear API Key`
- `VibeQuiz: Enable AI Mode`
- `VibeQuiz: Use Heuristic Mode`
- `VibeQuiz: Select AI Provider`
- `VibeQuiz: Set AI Model`
- `VibeQuiz: Open AI Settings`

Security constraints:

- API keys never enter the webview
- Keys are never written to workspace files or `package.json`
- AI requests run in the extension host only
- OpenAI requests use `store: false` for stateless handling

On first activation, VibeQuiz can prompt you once to set a key or stay in local mode. Stored keys persist locally in VS Code Secret Storage until you remove them.

## Provider support

Built-in providers:

- `openai`: OpenAI Responses API
- `anthropic`: Claude via the Anthropic Messages API
- `gemini`: Gemini structured JSON output
- `openaiCompatible`: OpenAI-style endpoints for Ollama and similar backends

Typical examples:

- OpenAI: provider `openai`, model `gpt-5-mini`
- Claude: provider `anthropic`, model `claude-sonnet-4-20250514`
- Gemini: provider `gemini`, model `gemini-2.5-flash`
- Local open-source via Ollama: provider `openaiCompatible`, base URL `http://localhost:11434/v1`, model `qwen3:8b`

The `openaiCompatible` path is intended to cover local and third-party endpoints that expose OpenAI-style chat APIs. That includes Ollama and similar backends, but output strictness can vary more than the first-party providers.

## Diff-aware behavior

Question quality is improved by preferring edit context over whole-file context:

- First choice: unsaved buffer changes compared with the saved file on disk
- Second choice: current file compared with `git HEAD`
- Third choice: latest committed version compared with the previous commit
- Fallback: current selection, nearest symbol, or current file

This means VibeQuiz now tends to ask about the code you just changed rather than whichever symbol happened to be nearest in the file.

## File support

VibeQuiz is intentionally conservative about source detection. If the active tab looks like record data instead of code, such as `jsonl`, `csv`, or log-like content, it will skip the quiz rather than generate generic nonsense.

## Visual direction

The included UI uses original assets and a flat, rounded illustration language with pill shadows, bold shapes, and a restrained blue-indigo palette. It aims for the same playful clarity as strong consumer learning tools without depending on hosted assets.

## Local development

```bash
npm install
npm run compile
```

Then open the folder in VS Code and press `F5` to launch an Extension Development Host.

## Usage

1. Open a code file in VS Code.
2. Run `VibeQuiz: Quiz Me` from the command palette.
3. If VibeQuiz detects a changed block, it will anchor the quiz to that edit before falling back to the whole symbol or file.
4. Answer the three prompts in the webview.
5. Submit to get reflection feedback.

To try AI mode:

1. Run `VibeQuiz: Set API Key`
2. Run `VibeQuiz: Select AI Provider`
3. Run `VibeQuiz: Enable AI Mode`
4. Optionally tune `vibeQuiz.ai.model` and `vibeQuiz.ai.baseUrl`
5. Run `VibeQuiz: Quiz Me`

For local Ollama-style setups:

1. Run `VibeQuiz: Select AI Provider`
2. Choose `OpenAI-compatible`
3. Leave the default base URL at `http://localhost:11434/v1` or point it at your own compatible backend
4. Set a local model name such as `qwen3:8b`
5. Run `VibeQuiz: Enable AI Mode`
6. Run `VibeQuiz: Quiz Me`

## Project structure

```txt
VibeQuiz/
  src/
    extension.ts
    contextExtractor.ts
    quizGenerator.ts
    feedback.ts
    storage.ts
    panel.ts
    types.ts
  media/
    styles.css
    app.js
  .github/
    ISSUE_TEMPLATE/
    bug_report.md
    feature_request.md
    PULL_REQUEST_TEMPLATE.md
  README.md
  CONTRIBUTING.md
  ROADMAP.md
  LICENSE
  package.json
  tsconfig.json
```

## Product constraints

- No cloud sync
- No telemetry backend
- No repo-wide parser pass
- No auto-triggering or interruptions

## Packaging

To create a `.vsix` package after installing dependencies:

```bash
npm run package
```

## License

MIT
