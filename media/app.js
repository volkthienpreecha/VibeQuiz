const vscode = acquireVsCodeApi();
const persisted = vscode.getState();
const initialState = window.__VIBEQUIZ_STATE__ || {};
const state = {
  ...initialState,
  ...persisted,
  stats: normalizeStats(persisted?.stats || initialState.stats),
  feedback: persisted?.feedback || initialState.feedback || [],
  answers: persisted?.answers || {},
  chunkWeakAreas: persisted?.chunkWeakAreas || initialState.chunkWeakAreas || [],
  activeChunkId: persisted?.activeChunkId || initialState.quizContext?.changeChunks?.[0]?.id || '',
  resultSummary: persisted?.resultSummary || initialState.resultSummary,
  isSubmitting: false,
  submitError: '',
  loadingProgress: Number(initialState.loadingProgress || 0),
  loadingTargetProgress: Number(initialState.loadingProgress || 0),
  loadingDisplayProgress: Number(initialState.loadingProgress || 0),
};

const root = document.getElementById('app');
let loadingAnimationHandle = null;

function render() {
  ensureChunkState();
  syncLoadingState();
  root.innerHTML = `
    <main class="shell">
      ${renderHero()}
      ${state.kind === 'quiz' ? renderQuiz() : state.kind === 'loading' ? renderLoadingState() : renderEmptyState()}
      ${renderFooter()}
    </main>
  `;

  bindEvents();
  ensureLoadingAnimation();
  persist();
}

function renderLoadingState() {
  const progress = clampProgress(state.loadingDisplayProgress);
  const details = Array.isArray(state.loadingDetails) ? state.loadingDetails : [];

  return `
    <section class="feedback-panel panel-card">
      <div class="section-head">
        <div>
          <p class="section-kicker">Setting Up</p>
          <h2>${escapeHtml(state.loadingStage || 'Building your quiz')}</h2>
        </div>
        <span class="mini-pill" data-loading-progress>${escapeHtml(`${Math.round(progress)}%`)}</span>
      </div>
      <div class="loading-track" aria-hidden="true">
        <span class="loading-fill" data-loading-fill style="width:${progress}%"></span>
      </div>
      <p class="supporting-copy">VibeQuiz is opening the source you picked, checking local or git context, and building the question set.</p>
      ${state.loadingDetail ? `<p class="supporting-copy loading-detail">${escapeHtml(state.loadingDetail)}</p>` : ''}
      <div class="loading-list">
        ${details.map((item, index) => renderLoadingStep(item, index, progress)).join('')}
      </div>
    </section>
  `;
}

function renderLoadingStep(item, index, progress) {
  const threshold = index === 0 ? 15 : index === 1 ? 42 : index === 2 ? 76 : 96;
  const statusClass = progress >= threshold ? 'loading-step-done' : progress >= threshold - 18 ? 'loading-step-current' : '';
  return `
    <div class="loading-step ${statusClass}" data-loading-step="${index}">
      <span class="loading-dot"></span>
      <span>${escapeHtml(item)}</span>
    </div>
  `;
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
  const isChunkedSession = Boolean(context?.isChunkedSession && context?.changeChunks?.length);
  const sessionInfo = context?.sessionInfo;

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
        ${sessionInfo ? `
          <div class="context-item context-item-accent">
            <span class="context-label">Session</span>
            <strong>${escapeHtml(sessionInfo.workspaceName)}</strong>
          </div>
          <div class="context-item">
            <span class="context-label">Changed files</span>
            <strong>${escapeHtml(String(sessionInfo.changedFileCount || 0))}</strong>
          </div>
          <div class="context-item">
            <span class="context-label">Touched files</span>
            <strong>${escapeHtml(String(sessionInfo.touchedFileCount || 0))}</strong>
          </div>
          <div class="context-item">
            <span class="context-label">Baseline</span>
            <strong>${escapeHtml(sessionInfo.baseRefLabel || 'local snapshot')}</strong>
          </div>
        ` : ''}
        ${changeContext ? renderChangeMeta(changeContext) : ''}
      </div>
      <pre class="snippet">${escapeHtml(context?.focusSnippet || '// No preview available')}</pre>
      ${changeContext ? renderPreviousSnippet(changeContext) : ''}
    </section>

    <section class="question-stack">
      <div class="section-head">
        <div>
          <p class="section-kicker">Quiz</p>
          <h2>${isChunkedSession ? 'Walk the highest-impact chunks' : 'Pick the strongest engineering read'}</h2>
        </div>
        <span class="mini-pill">${isChunkedSession ? `${context.changeChunks.length} ranked chunks` : '5 quick checks'}</span>
      </div>
      ${isChunkedSession ? renderChunkNavigator(context) : ''}
      <form id="quiz-form" class="question-form">
        ${renderQuestionGroups(questions, context)}
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

function renderChunkNavigator(context) {
  const chunks = context?.changeChunks || [];

  return `
    <section class="chunk-panel panel-card">
      <div class="section-head chunk-head">
        <div>
          <p class="section-kicker">Chunk Navigator</p>
          <h2>Review the changed areas by importance</h2>
        </div>
        <span class="mini-pill">Auto-ranked</span>
      </div>
      <div class="chunk-pill-row">
        ${chunks.map((chunk, index) => `
          <button
            class="chunk-pill ${state.activeChunkId === chunk.id ? 'chunk-pill-active' : ''}"
            type="button"
            data-chunk-id="${escapeHtml(chunk.id)}"
          >
            <span class="chunk-pill-index">${index + 1}</span>
            <span class="chunk-pill-copy">
              <strong>${escapeHtml(chunk.label)}</strong>
              <span>${escapeHtml(`${chunk.range} · ${chunk.lineCount} lines · score ${chunk.score}`)}</span>
            </span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderQuestionGroups(questions, context) {
  const chunks = context?.changeChunks || [];
  let index = 0;

  if (!context?.isChunkedSession || chunks.length === 0) {
    return questions.map((question) => renderQuestionCard(question, index++)).join('');
  }

  const grouped = chunks.map((chunk) => {
    const chunkQuestions = questions.filter((question) => question.chunkId === chunk.id);
    if (chunkQuestions.length === 0) {
      return '';
    }

    return `
      <section class="chunk-group ${state.activeChunkId === chunk.id ? 'chunk-group-active' : ''}" data-chunk-group="${escapeHtml(chunk.id)}">
        <div class="chunk-group-head">
          <div>
            <p class="section-kicker">Chunk</p>
            <h3>${escapeHtml(chunk.label)}</h3>
          </div>
          <div class="chunk-meta">
            <span class="badge">${escapeHtml(chunk.range)}</span>
            <span class="badge">${escapeHtml(`${chunk.lineCount} lines`)}</span>
            <span class="badge">${escapeHtml(`score ${chunk.score}`)}</span>
          </div>
        </div>
        ${chunk.reasons?.length ? `
          <div class="weak-area-pills">
            ${chunk.reasons.map((reason) => `<span class="badge">${escapeHtml(reason)}</span>`).join('')}
          </div>
        ` : ''}
        <pre class="snippet chunk-snippet">${escapeHtml(chunk.currentSnippet)}</pre>
        <div class="chunk-question-list">
          ${chunkQuestions.map((question) => renderQuestionCard(question, index++)).join('')}
        </div>
      </section>
    `;
  }).join('');

  const ungroupedQuestions = questions.filter((question) => !question.chunkId);
  const ungrouped = ungroupedQuestions.length > 0
    ? ungroupedQuestions.map((question) => renderQuestionCard(question, index++)).join('')
    : '';

  return `${grouped}${ungrouped}`;
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
        <div class="question-pill-row">
          <span class="mini-pill">${escapeHtml(formatType(question.type))}</span>
          ${question.chunkLabel ? `<span class="mini-pill">${escapeHtml(question.chunkLabel)}</span>` : ''}
        </div>
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
    return renderChunkWeakAreas();
  }

  return `
    <div class="weak-area-row">
      <span class="context-label">Recent weak areas</span>
      <div class="weak-area-pills">
        ${weakAreas.map((area) => `<span class="badge">${escapeHtml(area)}</span>`).join('')}
      </div>
    </div>
    ${renderChunkWeakAreas()}
  `;
}

function renderChunkWeakAreas() {
  const chunkWeakAreas = state.chunkWeakAreas?.length
    ? state.chunkWeakAreas
    : state.stats?.recentChunkWeakAreas || [];

  if (!chunkWeakAreas.length) {
    return '';
  }

  return `
    <div class="chunk-weak-area-stack">
      <span class="context-label">Chunk weak areas</span>
      ${chunkWeakAreas.map((item) => `
        <div class="chunk-weak-card">
          <strong>${escapeHtml(item.label)}</strong>
          <div class="weak-area-pills">
            ${item.weakAreas.map((area) => `<span class="badge">${escapeHtml(area)}</span>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <section class="empty-panel panel-card">
      <p class="section-kicker">Ready When You Are</p>
      <h2>${escapeHtml(state.emptyMessage || 'Open a code file to start a VibeQuiz session.')}</h2>
      <p class="supporting-copy">VibeQuiz starts with the active editor when that is useful, then falls back to recent workspace changes or the latest commit diff.</p>
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
      : 'Local heuristics use your active editor plus recent workspace or commit changes. No API key required.';

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

  document.querySelectorAll('[data-chunk-id]').forEach((element) => {
    element.addEventListener('click', () => {
      state.activeChunkId = element.getAttribute('data-chunk-id') || '';
      persist();
      render();
      const group = document.querySelector(`[data-chunk-group="${CSS.escape(state.activeChunkId)}"]`);
      if (group) {
        group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
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

function syncLoadingState() {
  state.loadingTargetProgress = clampProgress(state.loadingProgress);
  if (state.kind !== 'loading') {
    stopLoadingAnimation();
    state.loadingDisplayProgress = state.loadingTargetProgress;
    return;
  }

  if (!Number.isFinite(state.loadingDisplayProgress)) {
    state.loadingDisplayProgress = state.loadingTargetProgress;
  }
}

function ensureLoadingAnimation() {
  if (state.kind !== 'loading') {
    stopLoadingAnimation();
    return;
  }

  if (loadingAnimationHandle) {
    updateLoadingDom();
    return;
  }

  loadingAnimationHandle = window.setInterval(() => {
    const target = clampProgress(state.loadingTargetProgress);
    const current = clampProgress(state.loadingDisplayProgress);

    if (target <= current) {
      state.loadingDisplayProgress = target;
      updateLoadingDom();
      return;
    }

    const delta = Math.max(0.8, Math.min(3.8, (target - current) * 0.2));
    state.loadingDisplayProgress = Math.min(target, current + delta);
    updateLoadingDom();
  }, 40);
}

function stopLoadingAnimation() {
  if (!loadingAnimationHandle) {
    return;
  }

  window.clearInterval(loadingAnimationHandle);
  loadingAnimationHandle = null;
}

function updateLoadingDom() {
  if (state.kind !== 'loading') {
    return;
  }

  const progress = clampProgress(state.loadingDisplayProgress);
  const progressNode = document.querySelector('[data-loading-progress]');
  if (progressNode) {
    progressNode.textContent = `${Math.round(progress)}%`;
  }

  const fillNode = document.querySelector('[data-loading-fill]');
  if (fillNode) {
    fillNode.style.width = `${progress}%`;
  }

  document.querySelectorAll('[data-loading-step]').forEach((element) => {
    const index = Number(element.getAttribute('data-loading-step') || 0);
    const threshold = index === 0 ? 15 : index === 1 ? 42 : index === 2 ? 76 : 96;
    element.classList.remove('loading-step-done', 'loading-step-current');
    if (progress >= threshold) {
      element.classList.add('loading-step-done');
    } else if (progress >= threshold - 18) {
      element.classList.add('loading-step-current');
    }
  });
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function persist() {
  vscode.setState({
    stats: normalizeStats(state.stats),
    feedback: state.feedback,
    answers: state.answers,
    chunkWeakAreas: state.chunkWeakAreas,
    activeChunkId: state.activeChunkId,
    resultSummary: state.resultSummary,
  });
}

function normalizeStats(stats) {
  return {
    quizzesTaken: stats?.quizzesTaken || 0,
    lastQuizAt: stats?.lastQuizAt,
    streak: stats?.streak || 0,
    recentWeakAreas: stats?.recentWeakAreas || [],
    recentChunkWeakAreas: stats?.recentChunkWeakAreas || [],
  };
}

function ensureChunkState() {
  const chunks = state.quizContext?.changeChunks || [];
  if (chunks.length === 0) {
    state.activeChunkId = '';
    return;
  }

  const activeExists = chunks.some((chunk) => chunk.id === state.activeChunkId);
  if (!activeExists) {
    state.activeChunkId = chunks[0].id;
  }
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

  if (type === 'panelState') {
    applyPanelState(payload || {});
    render();
    return;
  }

  if (type === 'quizFeedback') {
    state.feedback = payload.feedback || [];
    state.stats = normalizeStats(payload.stats || state.stats);
    state.chunkWeakAreas = payload.chunkWeakAreas || [];
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
vscode.postMessage({ type: 'ready' });

function applyPanelState(nextState) {
  const currentSignature = questionSignature(state.questions);
  const nextSignature = questionSignature(nextState.questions);
  const enteringLoading = nextState.kind === 'loading' && state.kind !== 'loading';
  const newQuiz = nextState.kind === 'quiz' && nextSignature !== currentSignature;

  state.kind = nextState.kind || state.kind;
  state.title = nextState.title || state.title;
  state.subtitle = nextState.subtitle || state.subtitle;
  state.contextTag = nextState.contextTag;
  state.modeStatus = nextState.modeStatus || state.modeStatus;
  state.emptyMessage = nextState.emptyMessage;
  state.loadingStage = nextState.loadingStage;
  state.loadingDetail = nextState.loadingDetail;
  state.loadingDetails = nextState.loadingDetails || [];
  state.loadingProgress = clampProgress(nextState.loadingProgress ?? state.loadingProgress);
  state.quizContext = nextState.quizContext;
  state.questions = nextState.questions || [];
  state.stats = normalizeStats(nextState.stats || state.stats);
  state.feedback = nextState.feedback || (newQuiz || enteringLoading ? [] : state.feedback);
  state.resultSummary = nextState.resultSummary || (newQuiz || enteringLoading ? undefined : state.resultSummary);
  state.chunkWeakAreas = nextState.chunkWeakAreas || (newQuiz || enteringLoading ? [] : state.chunkWeakAreas);
  state.submitError = '';
  state.isSubmitting = false;

  if (enteringLoading) {
    state.loadingDisplayProgress = 0;
  }

  if (newQuiz || enteringLoading || nextState.kind !== 'quiz') {
    state.answers = {};
  }
}

function questionSignature(questions) {
  return (questions || []).map((question) => question.id).join('|');
}
