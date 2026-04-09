# VibeQuiz

VibeQuiz is a VS Code extension that quizzes you on the code you just wrote so you can tell whether you actually understand it.

## Why it exists

Modern coding speed is high, especially with AI assistance. Shipping code is easier than internalizing it. VibeQuiz closes that gap with three short, context-aware reflection questions based on the file you are actively editing.

The MVP is intentionally narrow:

- Command-driven only
- Current-file context only
- Rule-based question generation only
- Local-only storage
- Reflection prompts instead of fake grading

## What the MVP does

- Adds `VibeQuiz: Quiz Me` to the command palette
- Reads the active editor, selection, and nearby symbol context
- Generates three short questions from lightweight heuristics
- Opens a rounded, playful webview UI with free-text answers
- Stores local quiz count, last quiz timestamp, streak, and recent weak-area tags

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
3. Answer the three prompts in the webview.
4. Submit to get reflection feedback.

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

- No LLM integration in the MVP
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
