const vscode = acquireVsCodeApi();
const persisted = vscode.getState();
const initialState = window.__VIBEQUIZ_STATE__ || {};
const state = {
  ...initialState,
  ...persisted,
  stats: persisted?.stats || initialState.stats || { quizzesTaken: 0, streak: 0, recentWeakAreas: [] },
  feedback: persisted?.feedback || initialState.feedback || [],
  answers: persisted?.answers || {},
  resultSummary: persisted?.resultSummary || initialState.resultSummary,
  isSubmitting: false,
  submitError: '',
};

const root = document.getElementById('app');

function render() {
  root.innerHTML = `
    <main class="shell">
      ${renderHero()}
      ${state.kind === 'quiz' ? renderQuiz() : renderEmptyState()}
      ${renderFooter()}
    </main>
  `;

  bindEvents();
  persist();
}

function renderHero() {
  const quizCount = Math.max(1, (state.stats?.quizzesTaken || 0) + (state.feedback?.length ? 0 : 1));
  const streak = state.stats?.streak || 0;
  const modeLabel = state.modeStatus?.label || 'Heuristic mode';
  const modeDetail = state.modeStatus?.detail || 'Local-only quiz generation.';

  return `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">Session Check</span>
        <h1>${escapeHtml(state.title || 'VibeQuiz')}</h1>
        <p class="hero-text">${escapeHtml(state.subtitle || 'Five quick checks on the code in front of you.')}</p>
        <div class="hero-badges">
          <span class="badge badge-primary">Quiz #${quizCount}</span>
          <span class="badge">${escapeHtml(state.contextTag || 'CURRENT FILE')}</span>
          <span class="badge">${escapeHtml(modeLabel)}</span>
          <span class="badge">${streak > 0 ? `${streak} day streak` : 'Private by default'}</span>
        </div>
        <p class="mode-note">${escapeHtml(modeDetail)}</p>
      </div>
      <div class="buddy" aria-hidden="true">
        <div class="buddy-shadow"></div>
        <div class="buddy-body">
          <div class="buddy-face">
            <span class="buddy-eye buddy-eye-left"></span>
            <span class="buddy-eye buddy-eye-right"></span>
            <span class="buddy-mouth"></span>
          </div>
          <div class="buddy-belly"></div>
        </div>
        <span class="buddy-accent accent-one"></span>
        <span class="buddy-accent accent-two"></span>
        <span class="buddy-accent accent-three"></span>
      </div>
    </section>
  `;
}

function renderQuiz() {
  const context = state.quizContext;
  const questions = state.questions || [];
  const changeContext = context?.changeContext;

  return `
    <section class="context-card panel-card">
      <div class="section-head">
        <div>
          <p class="section-kicker">Code Context</p>
          <h2>Grounded in the file you have open</h2>
        </div>
        <span class="mini-pill">${escapeHtml(context?.selectionRange || `${context?.lineCount || 0} lines`)}</span>
      </div>
      <div class="context-grid">
        <div class="context-item">
          <span class="context-label">File</span>
          <strong>${escapeHtml(context?.fileName || 'Unknown file')}</strong>
        </div>
        <div class="context-item">
          <span class="context-label">Focus</span>
          <strong>${escapeHtml(context?.focusLabel || 'Current file')}</strong>
        </div>
        <div class="context-item">
          <span class="context-label">Imports</span>
          <strong>${context?.imports?.length || 0}</strong>
        </div>
        <div class="context-item">
          <span class="context-label">Exports</span>
          <strong>${context?.exports?.length || 0}</strong>
        </div>
        ${changeContext ? renderChangeMeta(changeContext) : ''}
      </div>
      <pre class="snippet">${escapeHtml(context?.focusSnippet || '// No preview available')}</pre>
      ${changeContext ? renderPreviousSnippet(changeContext) : ''}
    </section>

    <section class="question-stack">
      <div class="section-head">
        <div>
          <p class="section-kicker">Quiz</p>
          <h2>Pick the strongest engineering read</h2>
        </div>
        <span class="mini-pill">5 quick checks</span>
      </div>
      <form id="quiz-form" class="question-form">
        ${questions.map(renderQuestionCard).join('')}
        <div class="action-row">
          <button class="primary-button" type="submit" ${state.isSubmitting ? 'disabled' : ''}>
            ${state.isSubmitting ? 'Checking...' : 'Check Answers'}
          </button>
          <button class="secondary-button" id="skip-button" type="button">Skip</button>
        </div>
        ${state.submitError ? `<p class="submit-error">${escapeHtml(state.submitError)}</p>` : ''}
      </form>
    </section>

    ${renderFeedback()}
  `;
}

function renderChangeMeta(changeContext) {
  return `
    <div class="context-item context-item-accent">
      <span class="context-label">Changed</span>
      <strong>${escapeHtml(changeContext.label)}</strong>
    </div>
    <div class="context-item">
      <span class="context-label">Range</span>
      <strong>${escapeHtml(changeContext.range)}</strong>
    </div>
    <div class="context-item">
      <span class="context-label">Change type</span>
      <strong>${escapeHtml(changeContext.type)}</strong>
    </div>
    <div class="context-item">
      <span class="context-label">Changed lines</span>
      <strong>${escapeHtml(String(changeContext.lineCount || 0))}</strong>
    </div>
  `;
}

function renderPreviousSnippet(changeContext) {
  if (!changeContext.previousSnippet) {
    return '';
  }

  const previousLabel =
    changeContext.source === 'dirty-buffer'
      ? 'Saved file'
      : changeContext.source === 'last-commit'
        ? 'Previous commit'
        : 'git HEAD';

  return `
    <div class="previous-block">
      <div class="section-head previous-head">
        <div>
          <p class="section-kicker">Previous Context</p>
          <h2>What this looked like before</h2>
        </div>
        <span class="mini-pill">${escapeHtml(previousLabel)}</span>
      </div>
      <pre class="snippet snippet-secondary">${escapeHtml(changeContext.previousSnippet)}</pre>
    </div>
  `;
}

function renderQuestionCard(question, index) {
  const answer = state.answers?.[question.id] || '';

  return `
    <article class="question-card panel-card">
      <div class="question-topline">
        <span class="question-index">${index + 1}</span>
        <span class="mini-pill">${escapeHtml(formatType(question.type))}</span>
      </div>
      <h3>${escapeHtml(question.prompt)}</h3>
      <div class="choice-list" role="radiogroup" aria-label="${escapeHtml(question.prompt)}">
        ${question.options.map((option) => renderChoice(question, option, answer)).join('')}
      </div>
    </article>
  `;
}

function renderChoice(question, option, answer) {
  const selected = answer === option.id;

  return `
    <label class="choice-option ${selected ? 'choice-option-selected' : ''}">
      <input
        class="choice-input"
        type="radio"
        name="${escapeHtml(question.id)}"
        value="${escapeHtml(option.id)}"
        ${selected ? 'checked' : ''}
      />
      <span class="choice-letter">${escapeHtml(option.id.toUpperCase())}</span>
      <span class="choice-text">${escapeHtml(option.text)}</span>
    </label>
  `;
}

function renderFeedback() {
  if (!state.feedback || state.feedback.length === 0) {
    return `
      <section class="feedback-panel panel-card quiet-panel">
        <div class="section-head">
          <div>
            <p class="section-kicker">After Submit</p>
            <h2>Score and explanations show up here</h2>
          </div>
          <span class="mini-pill">5 questions</span>
        </div>
        <p class="supporting-copy">VibeQuiz will show which answers were strongest, what the better read was, and why that matters.</p>
      </section>
    `;
  }

  return `
    <section class="feedback-panel panel-card">
      <div class="section-head">
        <div>
          <p class="section-kicker">Results</p>
          <h2>What the quiz exposed</h2>
        </div>
        <span class="mini-pill">Saved locally</span>
      </div>
      ${renderResultSummary()}
      <p class="supporting-copy">This is meant to reduce friction, not depth. The explanation under each result is the teaching part.</p>
      <div class="feedback-list">
        ${state.feedback.map(renderFeedbackCard).join('')}
      </div>
      ${renderWeakAreas()}
    </section>
  `;
}

function renderResultSummary() {
  const summary = state.resultSummary;
  if (!summary) {
    return '';
  }

  return `
    <div class="result-summary">
      <div class="result-chip result-chip-primary">
        <span class="context-label">Score</span>
        <strong>${escapeHtml(`${summary.correct}/${summary.total}`)}</strong>
      </div>
      <div class="result-chip">
        <span class="context-label">Skipped</span>
        <strong>${escapeHtml(String(summary.skipped || 0))}</strong>
      </div>
      <div class="result-chip">
        <span class="context-label">Mode</span>
        <strong>${escapeHtml(state.modeStatus?.mode === 'ai' ? 'AI questions' : 'Local questions')}</strong>
      </div>
    </div>
  `;
}

function renderFeedbackCard(item) {
  return `
    <article class="feedback-card tone-${escapeHtml(item.tone)}">
      <h3>${escapeHtml(item.headline)}</h3>
      <p>${escapeHtml(item.body)}</p>
    </article>
  `;
}

function renderWeakAreas() {
  const weakAreas = state.stats?.recentWeakAreas || [];
  if (weakAreas.length === 0) {
    return '';
  }

  return `
    <div class="weak-area-row">
      <span class="context-label">Recent weak areas</span>
      <div class="weak-area-pills">
        ${weakAreas.map((area) => `<span class="badge">${escapeHtml(area)}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderEmptyState() {
  return `
    <section class="empty-panel panel-card">
      <p class="section-kicker">Ready When You Are</p>
      <h2>${escapeHtml(state.emptyMessage || 'Open a code file to start a VibeQuiz session.')}</h2>
      <p class="supporting-copy">VibeQuiz looks at the active editor, your selection, nearby symbols, and recent diffs. No repo crawl. No interruptions.</p>
      <div class="empty-pills">
        <span class="badge">Command palette</span>
        <span class="badge">5 MCQs</span>
        <span class="badge">Local storage</span>
      </div>
    </section>
  `;
}

function renderFooter() {
  const modeFooter =
    state.modeStatus?.mode === 'ai'
      ? 'BYOK stays in VS Code Secret Storage. The webview never receives your API key.'
      : 'Current-file heuristics only. No API key required.';

  return `
    <footer class="footer-note">
      <span>${escapeHtml(modeFooter)}</span>
      <span>Choices stay on your machine.</span>
    </footer>
  `;
}

function bindEvents() {
  const form = document.getElementById('quiz-form');
  if (form) {
    form.addEventListener('submit', handleSubmit);
  }

  const skipButton = document.getElementById('skip-button');
  if (skipButton) {
    skipButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'skipQuiz' });
    });
  }

  document.querySelectorAll('.choice-input').forEach((element) => {
    element.addEventListener('change', (event) => {
      const target = event.target;
      state.answers[target.name] = target.value;
      persist();
      render();
    });
  });
}

function handleSubmit(event) {
  event.preventDefault();
  const answers = {};

  document.querySelectorAll('.choice-input:checked').forEach((element) => {
    answers[element.name] = element.value;
  });

  state.answers = answers;
  state.isSubmitting = true;
  state.submitError = '';
  persist();
  render();

  vscode.postMessage({
    type: 'submitQuiz',
    payload: { answers },
  });
}

function persist() {
  vscode.setState({
    stats: state.stats,
    feedback: state.feedback,
    answers: state.answers,
    resultSummary: state.resultSummary,
  });
}

function formatType(value) {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'quizFeedback') {
    state.feedback = payload.feedback || [];
    state.stats = payload.stats || state.stats;
    state.resultSummary = payload.summary || state.resultSummary;
    state.isSubmitting = false;
    state.submitError = '';
    persist();
    render();
    return;
  }

  if (type === 'submitError') {
    state.isSubmitting = false;
    state.submitError = payload?.message || 'Unexpected error while checking your answers.';
    persist();
    render();
  }
});

render();
