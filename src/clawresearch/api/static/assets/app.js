const state = {
  projects: [],
  selectedProjectId: null,
  artifactCache: new Map(),
};

const els = {
  projectsList: document.getElementById('projects-list'),
  createProjectForm: document.getElementById('create-project-form'),
  refreshProjects: document.getElementById('refresh-projects'),
  heroTitle: document.getElementById('hero-title'),
  heroSummary: document.getElementById('hero-summary'),
  statusChip: document.getElementById('status-chip'),
  countOpenTasks: document.getElementById('count-open-tasks'),
  countActiveJobs: document.getElementById('count-active-jobs'),
  countApprovals: document.getElementById('count-approvals'),
  blockerTitle: document.getElementById('blocker-title'),
  blockerSummary: document.getElementById('blocker-summary'),
  nextActionTitle: document.getElementById('next-action-title'),
  nextActionSummary: document.getElementById('next-action-summary'),
  publicationTitle: document.getElementById('publication-title'),
  publicationSummary: document.getElementById('publication-summary'),
  approvalsList: document.getElementById('approvals-list'),
  jobsList: document.getElementById('jobs-list'),
  claimsList: document.getElementById('claims-list'),
  evidenceList: document.getElementById('evidence-list'),
  decisionsList: document.getElementById('decisions-list'),
  artifactsList: document.getElementById('artifacts-list'),
  artifactTitle: document.getElementById('artifact-title'),
  artifactPath: document.getElementById('artifact-path'),
  artifactContent: document.getElementById('artifact-content'),
  activityList: document.getElementById('activity-list'),
  commandForm: document.getElementById('command-form'),
  commandInput: document.getElementById('command-input'),
  commandResult: document.getElementById('command-result'),
  refreshProject: document.getElementById('refresh-project'),
  pauseProject: document.getElementById('pause-project'),
  resumeProject: document.getElementById('resume-project'),
  toast: document.getElementById('toast'),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = payload.error || `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  els.toast.style.background = isError ? 'rgba(154, 50, 38, 0.94)' : 'rgba(29, 34, 40, 0.92)';
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 2600);
}

function setEmpty(element, text) {
  element.innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusClass(status) {
  return String(status || 'neutral').replaceAll('-', '_');
}

function formatStatus(status) {
  return String(status || 'idle').replaceAll('_', ' ');
}

function formatDate(value) {
  if (!value) return 'n/a';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function renderMarkdown(markdown) {
  if (!markdown) {
    return '<p class="muted-text">No content.</p>';
  }

  const lines = markdown.replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  let inCode = false;
  let codeLines = [];

  const flushList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  const flushCode = () => {
    if (inCode) {
      html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
      codeLines = [];
      inCode = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inlineMarkdown(bullet[1])}</li>`;
      continue;
    }

    flushList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }

  flushList();
  flushCode();
  return html;
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;
  window.location.hash = projectId ? `#${projectId}` : '';
  renderProjects();
  if (projectId) {
    loadProject(projectId).catch((error) => showToast(error.message, true));
  } else {
    clearProjectView();
  }
}

function clearProjectView() {
  els.heroTitle.textContent = 'Select a project';
  els.heroSummary.textContent = 'The dashboard will show what the agent is doing, what is blocked, and what it needs from you.';
  els.statusChip.textContent = 'Idle';
  els.statusChip.className = 'status-chip neutral';
  els.countOpenTasks.textContent = '0';
  els.countActiveJobs.textContent = '0';
  els.countApprovals.textContent = '0';
  els.blockerTitle.textContent = 'No blocker';
  els.blockerSummary.textContent = 'The active project will show its main blocker here.';
  els.nextActionTitle.textContent = 'Stand by';
  els.nextActionSummary.textContent = 'No next action yet.';
  els.publicationTitle.textContent = 'Continue research';
  els.publicationSummary.textContent = 'Publication guidance will appear here.';
  setEmpty(els.approvalsList, 'No pending approvals.');
  setEmpty(els.jobsList, 'No jobs yet.');
  setEmpty(els.claimsList, 'No claims recorded yet.');
  setEmpty(els.evidenceList, 'No evidence recorded yet.');
  setEmpty(els.decisionsList, 'No decisions recorded yet.');
  setEmpty(els.artifactsList, 'No artifacts available.');
  setEmpty(els.activityList, 'No activity yet.');
  els.artifactTitle.textContent = 'Select an artifact';
  els.artifactPath.textContent = '';
  els.artifactContent.innerHTML = '<p class="muted-text">Artifact content will appear here.</p>';
}

function renderProjects() {
  if (!state.projects.length) {
    setEmpty(els.projectsList, 'No projects loaded yet.');
    return;
  }

  els.projectsList.innerHTML = state.projects.map((project) => `
    <article class="project-item ${project.id === state.selectedProjectId ? 'active' : ''}">
      <h3>${escapeHtml(project.name)}</h3>
      <div class="project-meta">
        <span>${escapeHtml(formatStatus(project.status))}</span>
        <span>${project.counts.open_tasks} open tasks</span>
        <span>${project.counts.pending_approvals} approvals</span>
      </div>
      <p class="muted-text">${escapeHtml(project.codebase_root || project.workspace_root)}</p>
      <button type="button" class="ghost-button" data-project-select="${escapeHtml(project.id)}">Open project</button>
    </article>
  `).join('');

  els.projectsList.querySelectorAll('[data-project-select]').forEach((button) => {
    button.addEventListener('click', () => selectProject(button.dataset.projectSelect));
  });
}

function renderOverview(overview) {
  const project = overview.project;
  els.heroTitle.textContent = project.name;
  els.heroSummary.textContent = overview.hero_summary || 'No summary yet.';
  els.statusChip.textContent = formatStatus(project.status);
  els.statusChip.className = `status-chip ${statusClass(project.status)}`;
  els.countOpenTasks.textContent = String(overview.counts.open_tasks);
  els.countActiveJobs.textContent = String(overview.counts.active_jobs);
  els.countApprovals.textContent = String(overview.counts.pending_approvals);

  if (overview.current_blocker) {
    els.blockerTitle.textContent = overview.current_blocker.title;
    els.blockerSummary.textContent = overview.current_blocker.summary;
  } else {
    els.blockerTitle.textContent = 'No blocker';
    els.blockerSummary.textContent = 'The project is currently unblocked.';
  }

  if (overview.next_recommended_action) {
    els.nextActionTitle.textContent = overview.next_recommended_action.title;
    els.nextActionSummary.textContent = overview.next_recommended_action.summary;
  }

  els.publicationTitle.textContent = overview.publication_readiness.recommended_action.replaceAll('_', ' ');
  els.publicationSummary.textContent = overview.publication_readiness.summary;

  renderApprovals(overview.open_approvals || []);
  renderJobs(overview.active_jobs || []);
  renderFindings(overview.latest_findings || {});
}

function renderApprovals(approvals) {
  if (!approvals.length) {
    setEmpty(els.approvalsList, 'No pending approvals.');
    return;
  }

  els.approvalsList.innerHTML = approvals.map((approval) => `
    <article class="card-item">
      <h3>${escapeHtml(approval.summary)}</h3>
      <p class="muted-text">${escapeHtml(approval.reason)}</p>
      <div class="card-meta">
        <span>${escapeHtml(approval.approval_type)}</span>
        <span>${approval.estimated_gpu_hours ? `${approval.estimated_gpu_hours} GPUh` : 'No cost estimate'}</span>
      </div>
      <p>${escapeHtml(approval.scientific_rationale || 'No rationale provided.')}</p>
      <div class="card-actions">
        <button type="button" class="primary-button" data-approval-action="approve" data-approval-id="${escapeHtml(approval.id)}">Approve</button>
        <button type="button" class="ghost-danger" data-approval-action="reject" data-approval-id="${escapeHtml(approval.id)}">Reject</button>
      </div>
    </article>
  `).join('');

  els.approvalsList.querySelectorAll('[data-approval-action]').forEach((button) => {
    button.addEventListener('click', () => resolveApproval(button.dataset.approvalId, button.dataset.approvalAction));
  });
}

function renderJobs(jobs) {
  if (!jobs.length) {
    setEmpty(els.jobsList, 'No jobs yet.');
    return;
  }

  els.jobsList.innerHTML = jobs.map((job) => `
    <article class="card-item">
      <h3>${escapeHtml(job.summary)}</h3>
      <div class="card-meta">
        <span>${escapeHtml(formatStatus(job.status))}</span>
        <span>${job.uses_gpu ? 'GPU' : 'CPU'}</span>
        <span>${escapeHtml(job.estimated_gpu_hours ? `${job.estimated_gpu_hours} GPUh` : 'Unspecified runtime')}</span>
      </div>
      <p class="muted-text">${escapeHtml(job.command)}</p>
      <p class="muted-text">${escapeHtml(job.cwd)}</p>
    </article>
  `).join('');
}

function renderFindings(findings) {
  renderSimpleCards(els.claimsList, findings.claims || [], (claim) => ({
    title: claim.text,
    meta: [claim.claim_type, claim.status],
    body: claim.scope || 'No scope annotation.',
  }));
  renderSimpleCards(els.evidenceList, findings.evidence || [], (evidence) => ({
    title: evidence.title,
    meta: [evidence.source_type, evidence.strength],
    body: evidence.summary || evidence.conclusion_impact || 'No evidence summary available.',
  }));
  renderSimpleCards(els.decisionsList, findings.decisions || [], (decision) => ({
    title: decision.summary,
    meta: [decision.decision_type, decision.status, decision.blocking ? 'blocking' : 'non-blocking'],
    body: decision.rationale,
  }));
}

function renderSimpleCards(container, items, mapper) {
  if (!items.length) {
    setEmpty(container, 'Nothing recorded yet.');
    return;
  }

  container.innerHTML = items.map((item) => {
    const card = mapper(item);
    return `
      <article class="card-item">
        <h3>${escapeHtml(card.title)}</h3>
        <div class="card-meta">${card.meta.map((part) => `<span>${escapeHtml(part)}</span>`).join('')}</div>
        <p>${escapeHtml(card.body)}</p>
      </article>
    `;
  }).join('');
}

function renderArtifacts(artifacts) {
  if (!artifacts.length) {
    setEmpty(els.artifactsList, 'No artifacts available.');
    return;
  }

  els.artifactsList.innerHTML = artifacts.map((artifact, index) => `
    <article class="artifact-item ${index === 0 ? 'active' : ''}">
      <h3>${escapeHtml(artifact.name)}</h3>
      <p class="muted-text">${escapeHtml(artifact.artifact_type)}</p>
      <button type="button" class="ghost-button" data-artifact-id="${escapeHtml(artifact.id)}">Open artifact</button>
    </article>
  `).join('');

  els.artifactsList.querySelectorAll('[data-artifact-id]').forEach((button) => {
    button.addEventListener('click', () => openArtifact(button.dataset.artifactId));
  });

  openArtifact(artifacts[0].id, { suppressToast: true }).catch((error) => showToast(error.message, true));
}

async function openArtifact(artifactId, { suppressToast = false } = {}) {
  if (!state.selectedProjectId) return;
  const artifact = state.artifactCache.get(artifactId) || await api(`/api/artifacts/${artifactId}`);
  state.artifactCache.set(artifactId, artifact);

  els.artifactTitle.textContent = artifact.name;
  els.artifactPath.textContent = artifact.path || '';
  els.artifactContent.innerHTML = renderMarkdown(artifact.content || '');
  els.artifactsList.querySelectorAll('.artifact-item').forEach((item) => item.classList.remove('active'));
  const activeButton = els.artifactsList.querySelector(`[data-artifact-id="${CSS.escape(artifactId)}"]`);
  activeButton?.closest('.artifact-item')?.classList.add('active');
  if (!suppressToast) {
    showToast(`Opened ${artifact.name}`);
  }
}

function renderActivity(activity) {
  const items = activity.items || [];
  if (!items.length) {
    setEmpty(els.activityList, 'No activity yet.');
    return;
  }

  els.activityList.innerHTML = items.map((item) => `
    <article class="activity-item">
      <div class="activity-meta">
        <span>${escapeHtml(item.entity_type)}</span>
        <span>${escapeHtml(item.event_type)}</span>
        <span class="activity-time">${escapeHtml(formatDate(item.timestamp))}</span>
      </div>
      <h3>${escapeHtml(item.summary)}</h3>
    </article>
  `).join('');
}

async function loadProjects() {
  const payload = await api('/api/projects');
  state.projects = payload.projects || [];
  renderProjects();

  const hashedProjectId = window.location.hash ? window.location.hash.slice(1) : null;
  if (hashedProjectId && state.projects.some((project) => project.id === hashedProjectId)) {
    state.selectedProjectId = hashedProjectId;
  } else if (!state.selectedProjectId && state.projects.length) {
    state.selectedProjectId = state.projects[0].id;
  }

  if (state.selectedProjectId) {
    await loadProject(state.selectedProjectId, { suppressToast: true });
  } else {
    clearProjectView();
  }
}

async function loadProject(projectId, { suppressToast = false } = {}) {
  state.selectedProjectId = projectId;
  renderProjects();
  state.artifactCache.clear();

  const [overview, activity, artifacts] = await Promise.all([
    api(`/api/projects/${projectId}/overview`),
    api(`/api/projects/${projectId}/activity?limit=25`),
    api(`/api/projects/${projectId}/artifacts`),
  ]);

  renderOverview(overview);
  renderArtifacts(artifacts.artifacts || []);
  renderActivity(activity);

  if (!suppressToast) {
    showToast(`Loaded ${overview.project.name}`);
  }
}

async function resolveApproval(approvalId, action) {
  if (!state.selectedProjectId) return;
  await api(`/api/approvals/${approvalId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ note: `${action}d from web shell` }),
  });
  showToast(`Approval ${action}d.`);
  await loadProject(state.selectedProjectId, { suppressToast: true });
}

async function submitCommand(event) {
  event.preventDefault();
  if (!state.selectedProjectId) {
    showToast('Select a project first.', true);
    return;
  }
  const text = els.commandInput.value.trim();
  if (!text) {
    showToast('Enter an instruction first.', true);
    return;
  }
  const payload = await api(`/api/projects/${state.selectedProjectId}/commands`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  els.commandInput.value = '';
  els.commandResult.textContent = payload.action.replaceAll('_', ' ');
  showToast('Instruction queued.');
  await loadProject(state.selectedProjectId, { suppressToast: true });
}

async function createProject(event) {
  event.preventDefault();
  const form = new FormData(els.createProjectForm);
  const payload = {
    name: (form.get('name') || '').toString().trim(),
    codebase_root: (form.get('codebase_root') || '').toString().trim() || null,
    path: (form.get('path') || '').toString().trim() || null,
    initial_prompt: (form.get('initial_prompt') || '').toString().trim() || null,
  };
  if (!payload.name) {
    showToast('Project name is required.', true);
    return;
  }
  const created = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  els.createProjectForm.reset();
  showToast(`Created ${created.name}`);
  await loadProjects();
  selectProject(created.id);
}

async function setProjectPause(paused) {
  if (!state.selectedProjectId) {
    showToast('Select a project first.', true);
    return;
  }
  const action = paused ? 'pause' : 'resume';
  await api(`/api/projects/${state.selectedProjectId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  showToast(`Project ${paused ? 'paused' : 'resumed'}.`);
  await loadProject(state.selectedProjectId, { suppressToast: true });
}

function bindEvents() {
  els.createProjectForm.addEventListener('submit', (event) => {
    createProject(event).catch((error) => showToast(error.message, true));
  });
  els.refreshProjects.addEventListener('click', () => {
    loadProjects().catch((error) => showToast(error.message, true));
  });
  els.refreshProject.addEventListener('click', () => {
    if (!state.selectedProjectId) return;
    loadProject(state.selectedProjectId).catch((error) => showToast(error.message, true));
  });
  els.pauseProject.addEventListener('click', () => {
    setProjectPause(true).catch((error) => showToast(error.message, true));
  });
  els.resumeProject.addEventListener('click', () => {
    setProjectPause(false).catch((error) => showToast(error.message, true));
  });
  els.commandForm.addEventListener('submit', (event) => {
    submitCommand(event).catch((error) => showToast(error.message, true));
  });
  window.addEventListener('hashchange', () => {
    const projectId = window.location.hash ? window.location.hash.slice(1) : null;
    if (projectId && projectId !== state.selectedProjectId) {
      selectProject(projectId);
    }
  });
}

bindEvents();
loadProjects().catch((error) => {
  clearProjectView();
  showToast(error.message, true);
});
