const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed']);

// 页面只渲染当前项目的快照；异步任务从不持有共享按钮或其他项目的 DOM。
export function createProjectSync({ api, change, complete, visible = () => !document.hidden, timer = setTimeout, cancelTimer = clearTimeout }) {
  const projects = new Map();
  let stopped = false;
  const state = pid => {
    pid = String(pid);
    if (!projects.has(pid)) projects.set(pid, { phase: 'idle', job: null, message: '', revision: 0, timer: null });
    return projects.get(pid);
  };
  const changed = pid => { if (!stopped) change(String(pid), state(pid)); };
  function pause(s) { if (s.timer !== null) cancelTimer(s.timer); s.timer = null; }
  function schedule(pid, delay = 2000) {
    const s = state(pid); pause(s);
    if (!stopped) s.timer = timer(() => poll(pid), delay);
  }
  async function poll(pid) {
    const s = state(pid), revision = s.revision, jobId = s.job?.jobId;
    if (stopped || !jobId || !ACTIVE.has(s.job.status)) return;
    if (!visible()) return schedule(pid);
    try {
      const { job } = await api.syncJob(jobId);
      if (stopped || revision !== s.revision) return;
      if (!job || String(job.projectId) !== String(pid) || job.jobId !== jobId || ![...ACTIVE, ...TERMINAL].includes(job.status)) throw new Error('任务状态无法确认');
      s.job = job; s.failures = 0; s.phase = ACTIVE.has(job.status) ? 'active' : 'idle'; s.message = '';
      changed(pid);
      if (ACTIVE.has(job.status)) schedule(pid);
      else await complete(String(pid), job);
    } catch (error) {
      if (stopped || revision !== s.revision) return;
      s.failures = (s.failures || 0) + 1;
      const terminalError = [401, 403, 404, 410].includes(error.status) || s.failures >= 4;
      s.phase = terminalError ? 'read-error' : 'active';
      s.message = [401, 403].includes(error.status) ? '登录或项目权限已变化，请重新登录或刷新。'
        : error.status === 404 ? '任务已失效，请重新读取当前项目的任务。'
          : terminalError ? '进度暂时不可读取，可重新读取；后台任务可能仍在运行。' : '进度读取暂时失败，正在重试…';
      changed(pid);
      if (!terminalError) schedule(pid, Math.min(16000, 2000 * 2 ** s.failures));
    }
  }
  async function restore(pid) {
    if (!pid || stopped) return;
    const s = state(pid);
    if (s.phase === 'submitting' || s.phase === 'restoring') { changed(pid); return; }
    pause(s); const revision = ++s.revision;
    s.phase = 'restoring'; changed(pid);
    try {
      const { jobs } = await api.syncJobs(pid);
      if (stopped || revision !== s.revision) return;
      s.job = jobs.find(j => ACTIVE.has(j.status)) || jobs[0] || null;
      s.phase = s.job && ACTIVE.has(s.job.status) ? 'active' : 'idle'; s.failures = 0; s.message = '';
      changed(pid);
      if (s.phase === 'active') schedule(pid, 0);
    } catch {
      if (stopped || revision !== s.revision) return;
      s.phase = 'read-error'; s.message = '任务状态读取失败，请重新读取进度。'; changed(pid);
    }
  }
  async function submit(pid) {
    const s = state(pid);
    if (stopped || ['submitting', 'restoring', 'active'].includes(s.phase)) return;
    if (s.phase === 'read-error') return restore(pid);
    pause(s); const revision = ++s.revision;
    s.phase = 'submitting'; s.message = ''; changed(pid);
    try {
      const out = await api.startSyncJob(pid, {});
      if (stopped || revision !== s.revision) return;
      if (!out.jobId || !ACTIVE.has(out.status)) throw new Error('未收到有效任务回执');
      s.job = { jobId: out.jobId, projectId: Number(pid), status: out.status, reused: out.reused };
      s.phase = 'active'; s.failures = 0; changed(pid); schedule(pid, 0);
    } catch {
      if (stopped || revision !== s.revision) return;
      s.phase = 'read-error'; s.message = '提交结果尚未确认，请重新读取进度后再操作。'; changed(pid);
    }
  }
  return { state, restore, submit, stop() { stopped = true; for (const s of projects.values()) { pause(s); s.revision++; } } };
}

export function projectSyncButton(s) {
  const text = s.phase === 'submitting' ? '正在提交…' : s.phase === 'restoring' ? '正在读取任务…'
    : s.phase === 'read-error' ? '重新读取进度' : s.phase === 'active' ? s.job?.status === 'running' ? '同步中…' : '已排队…' : '同步当前项目';
  return { text, disabled: ['submitting', 'restoring', 'active'].includes(s.phase) };
}
