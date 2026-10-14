// calendar.js —— 工作排期：月视图日历
// 交互：
//   - 点击【空白格子】：新建该日期的任务
//   - 点击【已有任务】：打开编辑弹窗（改标题/状态/优先级/日期等）
//   - 拖拽任务到其他日期：直接改期（投放目标格子高亮）
//   - 任务按状态着色：待办灰 / 进行中蓝 / 待交付黄 / 已完成绿(划线) / 逾期红
//   - 顶部「显示周末」开关：关闭时只显示周一至周五（5 列），选择记忆在 localStorage
import { API } from '../api.js';
import { beginPageRender, capturePageContext } from '../page-lifecycle.js';

let curMonth = new Date();
let tasksCache = [];
let nameMap = {};

const WEEKEND_KEY = 'cal_show_weekends';
function getShowWeekends() { return localStorage.getItem(WEEKEND_KEY) !== '0'; }

const STATUS = {
  todo: ['待办', 'st-todo'],
  done: ['已完成', 'st-done'],
};

export async function renderCalendar(el) {
  const isCurrent = beginPageRender(el);
  curMonth = new Date();
  const [tasks, projs] = await Promise.all([API.tasks(), API.projects()]);
  if (!isCurrent()) return;
  tasksCache = tasks;
  nameMap = {};
  for (const p of projs) nameMap[p.id] = p.name;

  const showWeekends = getShowWeekends();
  el.innerHTML = `
    <div class="page-head">
      <div><h2>工作排期</h2>
        <p class="page-desc">点击空白日期新建任务，点击任务改状态，拖动任务改日期。</p></div>
      <div class="cal-toolbar">
        <button class="btn" onclick="window.calNav(-1)">‹ 上月</button>
        <button class="btn" onclick="window.calNav(0)">今天</button>
        <button class="btn" onclick="window.calNav(1)">下月 ›</button>
        <button class="btn btn-primary" onclick="window.openTaskForm()">+ 新建任务</button>
        <label class="cal-switch" title="关闭后只显示周一至周五，隐藏周末">
          <span>显示周末</span>
          <input type="checkbox" id="cal-weekend" ${showWeekends ? 'checked' : ''}>
          <span class="cal-switch-track"></span>
        </label>
      </div>
    </div>
    <div class="cal-legend">
      <span>图例</span>
      <span class="st-todo">待办</span>
      <span class="st-done">已完成</span>
      <span class="st-overdue">逾期</span>
    </div>
    <div id="cal-box"></div>`;
  window.calNav = (d) => {
    if (d === 0) curMonth = new Date();
    else curMonth = new Date(curMonth.getFullYear(), curMonth.getMonth() + d, 1);
    if (isCurrent()) redraw(el, isCurrent);
  };
  const weekendToggle = $('#cal-weekend');
  if (weekendToggle) {
    weekendToggle.onchange = () => {
      localStorage.setItem(WEEKEND_KEY, weekendToggle.checked ? '1' : '0');
      if (isCurrent()) redraw(el, isCurrent);
    };
  }
  redraw(el, isCurrent);
}

const fmt = ymd; // 本地日期 YYYY-MM-DD，见 ui.js

// 改期/增删后重新拉数据并重画（保持当前月份视图，不跳回别处）
async function reload(el, isCurrent) {
  const tasks = await API.tasks();
  if (!isCurrent()) return;
  tasksCache = tasks;
  redraw(el, isCurrent);
}

function redraw(el, isCurrent) {
  if (!isCurrent()) return;
  const box = $('#cal-box', el);
  if (!box) return;
  drawCal(box);
  bindCal(el, isCurrent);
}

function drawCal(box) {
  const y = curMonth.getFullYear(), m = curMonth.getMonth();
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthCount = tasksCache.filter((t) => t.due_date?.startsWith(monthPrefix)).length;
  const showWeekends = getShowWeekends();
  const today = fmt(new Date());
  const dim = new Date(y, m + 1, 0).getDate();
  const byDate = {};
  for (const t of tasksCache) if (t.due_date) (byDate[t.due_date] ||= []).push(t);

  let cells = [];
  let dowHeader;
  if (showWeekends) {
    // 7 列：从 1 号所在周的周一起铺满 42 格（含相邻月）
    const startDow = (firstDow(new Date(y, m, 1)));
    const pdim = new Date(y, m, 0).getDate();
    for (let i = 0; i < 42; i++) {
      const dayNum = i - startDow + 1;
      let d, other = false;
      if (dayNum < 1) { d = new Date(y, m - 1, pdim + dayNum); other = true; }
      else if (dayNum > dim) { d = new Date(y, m + 1, dayNum - dim); other = true; }
      else d = new Date(y, m, dayNum);
      cells.push(cellHtml(d, fmt(d), other, today, byDate));
    }
    dowHeader = ['一', '二', '三', '四', '五', '六', '日'];
  } else {
    // 只显示周一~周五（5 列）：从 1 号所在周的周一出发，只取工作日，铺满完整几周
    const gridStart = new Date(y, m, 1 - firstDow(new Date(y, m, 1)));
    const d = new Date(gridStart);
    for (let i = 0; i < 42; i++) { // 42 天足够覆盖整月并把 5 列行铺完整
      if (firstDow(d) < 5) cells.push(cellHtml(d, fmt(d), d.getMonth() !== m, today, byDate));
      d.setDate(d.getDate() + 1);
    }
    dowHeader = ['一', '二', '三', '四', '五'];
  }

  // 把工作日单元格按 5 个一行排（隐藏周末时）；7 列模式本来就是 5 的倍数不适用，这里统一 chunk
  const rows = [];
  for (let i = 0; i < cells.length; i += showWeekends ? 7 : 5) rows.push(cells.slice(i, i + (showWeekends ? 7 : 5)));

  box.innerHTML = `
    <div class="cal-head">
      <h3 class="cal-title">${y} 年 ${m + 1} 月</h3>
      <span class="muted">本月 ${monthCount} 项任务</span>
    </div>
    <p class="cal-scroll-hint">左右滑动查看整周</p>
    <div class="cal-scroll" tabindex="0" aria-label="月历，可横向滚动查看整周"><div class="cal-grid ${showWeekends ? '' : 'cal-grid-5'}">
      ${dowHeader.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${rows.flat().join('')}
    </div></div>`;
}

// 0=周一 … 6=周日
function firstDow(d) { return (d.getDay() + 6) % 7; }

function cellHtml(d, ds, other, today, byDate) {
  const evts = byDate[ds] || [];
  const cls = `cal-cell ${other ? 'other' : ''} ${ds === today ? 'today' : ''}`;
  const chips = evts.map((t) => evChip(t, ds, today));
  const n = chips.length;
  // 超过 3 项先折叠，剩下的包在可展开的容器里；点「+N 项」展开/收起
  const extraWrap = n > 3 ? `<div class="cal-ev-more" data-more>${chips.slice(3).join('')}</div>` : '';
  const more = n > 3 ? `<div class="cal-more" data-more-hint data-collapsed="+${n - 3} 项" role="button" tabindex="0" aria-expanded="false" aria-label="${ds}，展开其余 ${n - 3} 项任务" title="${esc(evts.slice(3).map((t) => t.title).join('\n'))}">+${n - 3} 项</div>` : '';
  return `<div class="${cls}" data-date="${ds}" role="group" aria-label="${ds} 的任务"><div class="d" role="button" tabindex="0" aria-label="${ds}，新建任务">${d.getDate()}</div><div class="evts">${chips.slice(0, 3).join('')}${extraWrap}${more}</div></div>`;
}

function evChip(t, ds, today) {
  const overdue = ds < today && t.status !== 'done';
  const st = STATUS[t.status] || STATUS.todo;
  const proj = nameMap[t.project_id];
  // 日历格宽度有限：chip 只显示标题，项目名放提示，避免两者同时截断。
  return `<div class="cal-ev ${st[1]}${overdue ? ' st-overdue' : ''}" draggable="true" data-id="${t.id}" role="button" tabindex="0" aria-label="编辑任务：${esc(t.title)}，${ds}"
    title="${esc(t.title)}${proj ? `（${esc(proj)}）` : ''} · 点击编辑 · 拖到其他日期可改期">
    ${overdue ? '<span class="cal-ev-dot">!</span>' : ''}
    <span class="cal-ev-title">${esc(t.title)}</span></div>`;
}

function bindCal(el, isCurrent) {
  // 已有任务：点击 → 编辑；拖拽 → 改期
  $$('.cal-ev', el).forEach((ev) => {
    ev.onclick = (e) => { e.stopPropagation(); window.openTaskForm(ev.dataset.id); };
    ev.onkeydown = activateCalendarControl;
    ev.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', ev.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      ev.classList.add('dragging');
    };
    ev.ondragend = () => ev.classList.remove('dragging');
  });

  // 格子：点击空白 → 新建；作为拖拽投放目标 → 改期
  $$('.cal-cell', el).forEach((cell) => {
    cell.onclick = () => window.openTaskForm(null, { due_date: cell.dataset.date });
    const date = cell.querySelector('.d');
    date.onclick = (e) => { e.stopPropagation(); cell.onclick(); };
    date.onkeydown = activateCalendarControl;
    cell.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; cell.classList.add('drag-over'); };
    cell.ondragleave = () => cell.classList.remove('drag-over');
    cell.ondrop = async (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const date = cell.dataset.date;
      const task = tasksCache.find((t) => String(t.id) === id);
      if (!task || task.due_date === date) return;
      const current = capturePageContext(el);
      try {
        await API.updateTask(id, { due_date: date });
        toast(`已改期到 ${date}`, 'ok');
        if (isCurrent() && current()) await reload(el, current);
      } catch (err) {
        toast('改期失败：' + err.message, 'err');
      }
    };
  });

  // 「+N 项」→ 展开该格子被折叠的任务；再点「收起」→ 折叠回去
  $$('[data-more-hint]', el).forEach((hint) => {
    hint.onclick = (e) => {
      e.stopPropagation(); // 不冒泡到格子的新建任务
      const wrap = hint.closest('.cal-cell').querySelector('[data-more]');
      if (!wrap) return;
      if (wrap.style.display === 'contents') {
        wrap.style.display = 'none';
        hint.textContent = hint.dataset.collapsed;
        hint.setAttribute('aria-expanded', 'false');
        hint.setAttribute('aria-label', `${hint.closest('.cal-cell').dataset.date}，展开更多任务`);
      } else {
        wrap.style.display = 'contents';
        hint.textContent = '收起';
        hint.setAttribute('aria-expanded', 'true');
        hint.setAttribute('aria-label', `${hint.closest('.cal-cell').dataset.date}，收起更多任务`);
      }
    };
    hint.onkeydown = activateCalendarControl;
  });
}

function activateCalendarControl(event) {
  if (event.target !== event.currentTarget || event.isComposing || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) event.currentTarget.click();
}
