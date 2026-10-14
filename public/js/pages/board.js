// board.js —— 任务看板：Kanban 拖拽 + 新建/编辑/删除
import { API } from '../api.js';
import { beginPageRender, capturePageContext } from '../page-lifecycle.js';

// 任务状态精简为「待办(todo)/已完成(done)」；「已逾期」是从「到期日 < 今天且未完成」派生的展示桶，非存储值。
// 看板排版：已逾期占整行在上，待办 + 已完成 两列在下。
const SECTIONS = [
  { key: 'overdue', label: '已逾期', dotClass: 'overdue', full: true, drop: '' },
  { key: 'todo', label: '待办', dotClass: 'todo', drop: 'todo' },
  { key: 'done', label: '已完成', dotClass: 'done', drop: 'done' },
];
// 任务表单里可选的状态（已逾期不在此列，由到期日自动判断）
const FORM_STATUS = SECTIONS.filter((s) => s.drop).map((s) => ({ key: s.drop, label: s.label }));

let projects = [];

export async function renderBoard(el) {
  const isCurrent = beginPageRender(el);
  const [tasks, projs] = await Promise.all([API.tasks(), API.projects()]);
  if (!isCurrent()) return;
  projects = projs;

  const filter = location.hash.split('?')[1] || '';
  const projFilter = new URLSearchParams(filter).get('project') || '';
  const shown = projFilter ? tasks.filter((t) => String(t.project_id) === projFilter) : tasks;
  const b = bucketSections(shown);

  el.innerHTML = `
    <div class="page-head">
      <div><h2>任务看板</h2>
        <p class="page-desc">「已逾期」由到期日自动派生，不可投放；拖动卡片到「待办 / 已完成」改状态。</p></div>
      <div class="filter-bar" style="margin:0">
        <select id="board-filter" style="width:auto">
          <option value="">全部项目</option>
          ${projs.map((p) => `<option value="${p.id}" ${String(p.id) === projFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="window.openTaskForm()">+ 新建任务</button>
      </div>
    </div>
    <div class="board">
      ${sectionHtml(SECTIONS[0], b.overdue)}
      ${sectionHtml(SECTIONS[1], b.todo)}
      ${sectionHtml(SECTIONS[2], b.done)}
    </div>`;

  $('#board-filter').onchange = (e) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (e.target.value) params.set('project', e.target.value); else params.delete('project');
    const route = location.hash.startsWith('#/task-management') ? '#/task-management' : '#/board';
    location.hash = params.size ? `${route}?${params}` : route;
  };
  bindDrag(el, isCurrent);
}

// 把任务按三个展示桶归类：已逾期（派生）/ 待办 / 已完成
function bucketSections(tasks) {
  const today = todayStr();
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today && t.status !== 'done');
  const overdueIds = new Set(overdue.map((t) => t.id));
  return {
    overdue,
    todo: tasks.filter((t) => t.status === 'todo' && !overdueIds.has(t.id)),
    done: tasks.filter((t) => t.status === 'done'),
  };
}

function sectionHtml(section, list) {
  const full = section.full ? ' board-col-full' : '';
  const dropAttr = section.drop ? ` data-drop-status="${section.drop}"` : '';
  return `<div class="board-col${full}" data-status="${section.key}"${dropAttr}>
    <div class="col-head">
      <span class="col-head-title"><span class="col-dot ${section.dotClass}"></span>${section.label}<span class="muted col-count">${list.length}</span></span>
    </div>
    <div class="col-body">
      ${list.length ? list.map((t) => cardHtml(t)).join('') : '<div class="empty board-empty">空</div>'}
    </div>
  </div>`;
}

function cardHtml(t) {
  const proj = projects.find((p) => p.id === t.project_id);
  const overdue = t.due_date && t.due_date < todayStr() && t.status !== 'done';
  return `<div class="board-card" draggable="true" data-id="${t.id}" role="button" tabindex="0" aria-label="编辑任务：${esc(t.title)}" title="点击编辑">
    <div class="t">${esc(t.title)}</div>
    <div class="meta-chips">
      ${proj ? `<span class="tag tag-blue">${esc(proj.name)}</span>` : ''}
      <span class="tag ${PRIO_MAP[t.priority]?.[1] || 'tag-gray'}">${PRIO_MAP[t.priority]?.[0] || ''}</span>
      ${t.due_date ? `<span class="tag ${overdue ? 'tag-red' : 'tag-gray'}">${overdue ? '逾期 ' : ''}${esc(t.due_date)}</span>` : ''}
    </div>
  </div>`;
}

function bindDrag(el, isCurrent) {
  let dragging = null;
  el.querySelectorAll('.board-card').forEach((card) => {
    card.onclick = (e) => { e.stopPropagation(); openTaskForm(card.dataset.id); };
    card.onkeydown = (event) => {
      if (event.target !== card || event.isComposing || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) card.click();
    };
    card.ondragstart = (e) => {
      dragging = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    };
    card.ondragend = () => card.classList.remove('dragging');
  });
  // 只有「待办/已完成」是投放目标（改状态）；「已逾期」是派生视图，不可投放
  el.querySelectorAll('.board-col[data-drop-status]').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drag-over'); };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (!dragging) return;
      const id = dragging;
      dragging = null;
      const current = capturePageContext(el);
      try {
        await API.updateTask(id, { status: col.dataset.dropStatus });
        toast('已移动', 'ok');
      } catch (err) {
        toast('移动失败：' + err.message, 'err');
      }
      if (isCurrent() && current()) await renderBoard(el);
    };
  });
}

// 新建/编辑任务弹窗（prefill 可预填字段，如日期）
export async function openTaskForm(id, prefill = {}) {
  const element = $('#view');
  const current = capturePageContext(element);
  const [tasks, projs] = await Promise.all([API.tasks(), API.projects()]);
  if (!current()) return;
  const task = id ? tasks.find((t) => t.id === Number(id)) : null;
  const projOptions = '<option value="">不关联项目</option>' + projs.map((p) => `<option value="${p.id}" ${task?.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const modal = openModal(`
    <div class="modal-head"><h3>${task ? '编辑任务' : '新建任务'}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="task-form">
      <div class="form-row"><label>任务标题 *</label><input name="title" required value="${esc(task?.title || '')}" placeholder="如：发布 5 篇英文客座文章"></div>
      <div class="form-row"><label>所属项目</label><select name="project_id">${projOptions}</select></div>
      <div class="form-row"><label>描述</label><textarea name="description" rows="3" placeholder="任务细节、交付标准…">${esc(task?.description || '')}</textarea></div>
      <div class="form-grid">
        <div class="form-row"><label>优先级</label>
          <select name="priority">${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${task?.priority === p ? 'selected' : ''}>${PRIO_MAP[p][0]}</option>`).join('')}</select>
        </div>
        <div class="form-row"><label>到期日</label><input type="date" name="due_date" value="${esc(task?.due_date || prefill.due_date || '')}"></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label>状态</label>
          <select name="status">${FORM_STATUS.map((c) => `<option value="${c.key}" ${(task?.status || 'todo') === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
          <div class="hint" style="margin:0">已逾期由到期日自动判断，无需手动设状态</div>
        </div>
      </div>
      <div class="form-actions">
        ${task ? '<button type="button" class="btn btn-danger" style="margin-right:auto" onclick="window.delTask()">删除</button>' : ''}
        <button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`, true);

  window.delTask = task ? () => {
    confirmDialog('删除任务', `确定删除「${esc(task.title)}」？`, async () => {
      try {
        await API.deleteTask(task.id);
        toast('已删除', 'ok');
        if (current()) window.refreshView();
      } catch (e) { toast(e.message, 'err'); }
    });
  } : () => {};

  $('#task-form').onsubmit = async (e) => {
    e.preventDefault();
    const data = readForm(e.target);
    if (!data.title.trim()) return toast('请填写标题', 'err');
    try {
      if (task) { await API.updateTask(task.id, data); toast('已保存', 'ok'); }
      else { await API.createTask(data); toast('任务已创建', 'ok'); }
      modal.close();
      if (current()) window.refreshView();
    } catch (err) { toast(err.message, 'err'); }
  };
}
window.openTaskForm = openTaskForm;
