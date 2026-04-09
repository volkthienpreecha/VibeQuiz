const vscode = acquireVsCodeApi();
const persisted = vscode.getState();
const initialState = window.__VIBEQUIZ_STATE__ || {};
const state = {
  ...initialState,
  ...persisted,
  stats: persisted?.stats || initialState.stats || { quizzesTaken: 0, streak: 0, recentWeakAreas: [] },
  answers: persisted?.answers || {},
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
  autoGrowTextareas();
  persist();
}

function renderHero() {
  const quizCount = Math.max(1, (state.stats?.quizzesTaken || 0) + (state.feedback?.length ? 0 : 1));
  const streak = state.stats?.streak || 0;

  return `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">Session Check</span>
        <h1>${escapeHtml(state.title || 'VibeQuiz')}</h1>
        <p class="hero-text">${escapeHtml(state.subtitle || 'Three sharp questions about the code in front of you.')}</p>
        <div class="hero-badges">
          <span class="badge badge-primary">Quiz #${quizCount}</span>
          <span class="badge">${escapeHtml(state.contextTag || 'CURRENT FILE')}</span>
          <span class="badge">${streak > 0 ? `${streak} day streak` : 'Local only'}</span>
        </div>
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
      </div>
      <pre class="snippet">${escapeHtml(context?.focusSnippet || '// No preview available')}</pre>
    </section>

    <section class="question-stack">
      <div class="section-head">
        <div>
          <p class="section-kicker">Quiz</p>
          <h2>Explain it back to yourself</h2>
        </div>
        <span class="mini-pill">3 prompts max</span>
      </div>
      <form id="quiz-form" class="question-form">
        ${questions.map(renderQuestionCard).join('')}
        <div class="action-row">
          <button class="primary-button" type="submit" ${state.isSubmitting ? 'disabled' : ''}>
            ${state.isSubmitting ? 'Checking...' : 'Submit Reflection'}
          </button>
          <button class="secondary-button" id="skip-button" type="button">Skip</button>
        </div>
        ${state.submitError ? `<p class="submit-error">${escapeHtml(state.submitError)}</p>` : ''}
      </form>
    </section>

    ${renderFeedback()}
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
      <textarea
        class="answer-box"
        name="${escapeHtml(question.id)}"
        rows="4"
        placeholder="Write what this code is doing, protecting, or guaranteeing."
      >${escapeHtml(answer)}</textarea>
    </article>
  `;
}

function renderFeedback() {
  if (!state.feedback || state.feedback.length === 0) {
    return `
      <section class="feedback-panel panel-card quiet-panel">
        <div class="section-head">
          <div>
            <p class="section-kicker">After Submit</p>
            <h2>Reflection shows up here</h2>
          </div>
          <span class="mini-pill">No fake score</span>
        </div>
        <p class="supporting-copy">You will get short reflection prompts instead of pretend grading. Thin answers get nudged. Solid answers get acknowledged.</p>
      </section>
    `;
  }

  return `
    <section class="feedback-panel panel-card">
      <div class="section-head">
        <div>
          <p class="section-kicker">Reflection</p>
          <h2>What your answers revealed</h2>
        </div>
        <span class="mini-pill">Saved locally</span>
      </div>
      <p class="supporting-copy">This is not a score. It is a quick read on where your explanation felt concrete versus vague.</p>
      <div class="feedback-list">
        ${state.feedback.map(renderFeedbackCard).join('')}
      </div>
      ${renderWeakAreas()}
    </section>
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
      <p class="supporting-copy">VibeQuiz only looks at the active editor, your selection, and nearby symbols. No repo crawl. No interruptions.</p>
      <div class="empty-pills">
        <span class="badge">Command palette</span>
        <span class="badge">Manual only</span>
        <span class="badge">Local storage</span>
      </div>
    </section>
  `;
}

function renderFooter() {
  return `
    <footer class="footer-note">
      <span>Current-file heuristics only.</span>
      <span>Answers stay on your machine.</span>
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

  document.querySelectorAll('.answer-box').forEach((element) => {
    element.addEventListener('input', (event) => {
      const target = event.target;
      state.answers[target.name] = target.value;
      persist();
      autoResize(target);
    });
  });
}

function handleSubmit(event) {
  event.preventDefault();
  const answers = {};

  document.querySelectorAll('.answer-box').forEach((element) => {
    answers[element.name] = element.value.trim();
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

function autoGrowTextareas() {
  document.querySelectorAll('.answer-box').forEach((element) => autoResize(element));
}

function autoResize(element) {
  element.style.height = '0px';
  element.style.height = `${Math.max(element.scrollHeight, 120)}px`;
}

function persist() {
  vscode.setState({
    stats: state.stats,
    feedback: state.feedback,
    answers: state.answers,
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
    state.isSubmitting = false;
    state.submitError = '';
    persist();
    render();
    return;
  }

  if (type === 'submitError') {
    state.isSubmitting = false;
    state.submitError = payload?.message || 'Unexpected error while processing your answers.';
    persist();
    render();
  }
});

render();
