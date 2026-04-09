const vscode = acquireVsCodeApi();
const state = window.__VIBEQUIZ_SIDEBAR_STATE__ || {};
const root = document.getElementById('app');

function render() {
  root.innerHTML = `
    <main class="sidebar-shell">
      <section class="hero-card">
        <div class="hero-copy">
          <span class="eyebrow">Quick Launch</span>
          <h1>VibeQuiz</h1>
          <p class="hero-text">Quiz the code you just touched without leaving the editor.</p>
        </div>
        <div class="totem" aria-hidden="true">
          <div class="totem-shadow"></div>
          <div class="totem-body">
            <span class="totem-eye totem-eye-left"></span>
            <span class="totem-eye totem-eye-right"></span>
            <span class="totem-mouth"></span>
          </div>
          <span class="totem-accent accent-one"></span>
          <span class="totem-accent accent-two"></span>
          <span class="totem-accent accent-three"></span>
        </div>
      </section>

      <section class="panel-card launch-card">
        <button class="primary-button" data-command="vibeQuiz.quizMe">Quiz Me</button>
        <div class="button-grid">
          <button class="secondary-button" data-command="${escapeHtml(state.modeToggleCommand)}">${escapeHtml(state.modeToggleLabel)}</button>
          <button class="secondary-button" data-command="vibeQuiz.setApiKey">Set API Key</button>
          <button class="secondary-button" data-command="vibeQuiz.selectAiProvider">Select Provider</button>
          <button class="secondary-button" data-command="vibeQuiz.openSettings">Open Settings</button>
        </div>
      </section>

      <section class="panel-card info-card">
        <div class="section-head">
          <p class="section-kicker">Active Context</p>
          <span class="mini-pill">${escapeHtml(state.activeMeta || 'Ready')}</span>
        </div>
        <h2>${escapeHtml(state.activeFile || 'No active file')}</h2>
        <p class="focus-line">${escapeHtml(state.activeFocus || 'Open a code file to start.')}</p>
        <p class="supporting-copy">${escapeHtml(state.activeHint || 'VibeQuiz will look at your selection, nearby symbol, or recent diff.')}</p>
      </section>

      <section class="panel-card mode-card">
        <div class="section-head">
          <p class="section-kicker">Mode</p>
          <span class="mini-pill">${escapeHtml(state.providerLabel || 'Local')}</span>
        </div>
        <h2>${escapeHtml(state.modeLabel || 'Heuristic mode')}</h2>
        <p class="supporting-copy">${escapeHtml(state.modeDetail || 'Questions are generated locally.')}</p>
        <div class="stat-grid">
          <div class="stat-chip">
            <span class="stat-label">Model</span>
            <strong>${escapeHtml(state.providerModel || 'No model required')}</strong>
          </div>
          <div class="stat-chip">
            <span class="stat-label">Security</span>
            <strong>${escapeHtml(state.providerStatus || 'Local only')}</strong>
          </div>
        </div>
      </section>

      <section class="panel-card stats-card">
        <div class="section-head">
          <p class="section-kicker">Momentum</p>
          <button class="refresh-button" data-command="refresh" title="Refresh">Refresh</button>
        </div>
        <div class="stat-grid stat-grid-compact">
          <div class="stat-chip stat-chip-emphasis">
            <span class="stat-label">Quizzes</span>
            <strong>${escapeHtml(String(state.quizzesTaken || 0))}</strong>
          </div>
          <div class="stat-chip">
            <span class="stat-label">Streak</span>
            <strong>${escapeHtml(`${state.streak || 0} day${state.streak === 1 ? '' : 's'}`)}</strong>
          </div>
          <div class="stat-chip">
            <span class="stat-label">Last quiz</span>
            <strong>${escapeHtml(state.lastQuizLabel || 'No sessions yet')}</strong>
          </div>
        </div>
        ${renderWeakAreas()}
      </section>
    </main>
  `;

  bindEvents();
}

function renderWeakAreas() {
  const weakAreas = Array.isArray(state.weakAreas) ? state.weakAreas : [];
  if (weakAreas.length === 0) {
    return '<p class="supporting-copy subtle-copy">Weak areas show up here after you submit a few sessions.</p>';
  }

  return `
    <div class="pill-row">
      ${weakAreas.map((area) => `<span class="mini-pill mini-pill-soft">${escapeHtml(area)}</span>`).join('')}
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll('[data-command]').forEach((element) => {
    element.addEventListener('click', () => {
      const command = element.getAttribute('data-command');
      if (!command) {
        return;
      }

      if (command === 'refresh') {
        vscode.postMessage({ type: 'refresh' });
        return;
      }

      vscode.postMessage({
        type: 'runCommand',
        command,
      });
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

render();
