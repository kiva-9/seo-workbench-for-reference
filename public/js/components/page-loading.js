import {candidateHeading,candidateToolbar} from './candidate-layout.js';
import {aiLoading} from './ai-loading.js';

const labels = {
  dashboard: ['总览', '项目与任务的当前状态，按到期日排出最该动手的事。', ['进行中项目', '未完成任务', '7 天内到期', '已逾期']],
  projects: ['项目管理', 'GSC 与 GA4 可分别绑定不同谷歌账号，互不影响。'],
  project: ['项目文章管理', '统一维护站内文章、站外文章、文案师名单与监控设置。'],
  'article-monitor': ['文章监控', '按项目持续跟踪站内文章的 GSC 点击、GA4 浏览与页面内关键事件表现。'],
  'background-tasks': ['后台任务', '查看任务的实际进度、执行结果与需要跟进的步骤。'],
  board: ['任务看板', '「已逾期」由到期日自动派生，不可投放；拖动卡片到「待办 / 已完成」改状态。'],
  calendar: ['工作排期', '点击空白日期新建任务，点击任务改状态，拖动任务改日期。'],
  docs: ['链接库', '按项目或标签归类外部资源，收藏的链接可一键带入项目。'],
  accounts: ['谷歌账号中心', '连接账号后自动发现可访问的网站，再到候选池确认项目。'],
  settings: ['账号与设置', '管理已有登录账号、文案师显示名与数据连接配置。'],
  mcp: ['MCP', '连接 AI 客户端，查询项目表现、维护文章与任务，并跟进后台处理。'],
  'project-candidates': ['项目候选', '所有成员都能查看并认领。认领后，你会成为项目负责人。'],
};

export function loadingRows(columns = ['标题 / URL', '发布日期', '文案师', '操作']) {
  return `<div class="loading-region" role="status" aria-label="正在读取数据"><div class="loading-caption">正在读取数据…</div><div class="tbl-wrap"><table class="tbl loading-table" aria-hidden="true"><thead><tr>${columns.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 4 }, () => `<tr>${columns.map(() => '<td><span class="loading-line"></span></td>').join('')}</tr>`).join('')}</tbody></table></div></div>`;
}

export function loadingStats(names) {
  return names.map(label => `<div class="stat" aria-label="${label}正在读取"><div class="label">${label}</div><div class="value"><span class="loading-line loading-number" aria-hidden="true"></span></div></div>`).join('');
}

const line=(kind='')=>`<span class="loading-line ${kind}" aria-hidden="true"></span>`;
const lines=()=>`${line('loading-title')}${line()}${line('loading-short')}`;
const controls=(count=2)=>`<div class="loading-controls" aria-hidden="true">${Array.from({length:count},()=>line('loading-control')).join('')}</div>`;
function loadingBody(page) {
  if(page==='background-tasks') return `${controls(4)}<div class="card">${loadingRows(['任务 / 模块','项目 / 账号','发起人','状态','执行进度','创建时间 / 耗时','操作'])}</div>`;
  if(page==='projects')return `<div class="project-grid">${Array.from({length:4},()=>`<article class="card pcard loading-project">${lines()}<div class="meta">${lines()}</div></article>`).join('')}</div>`;
  if(page==='board')return `<div class="board">${['已逾期','待办','已完成'].map((label,i)=>`<section class="board-col ${i===0?'board-col-full':''}"><div class="col-head">${label}</div><div class="col-body">${Array.from({length:2},()=>`<article class="board-card">${lines()}</article>`).join('')}</div></section>`).join('')}</div>`;
  if(page==='calendar'){
    const weekends=localStorage.getItem('cal_show_weekends')!=='0',days=weekends?['一','二','三','四','五','六','日']:['一','二','三','四','五'];
    const date=new Date();
    return `<div class="cal-head"><h3 class="cal-title">${date.getFullYear()} 年 ${date.getMonth()+1} 月</h3>${line('loading-short')}</div><div class="cal-scroll"><div class="cal-grid ${weekends?'':'cal-grid-5'}" aria-hidden="true">${days.map(d=>`<div class="cal-dow">${d}</div>`).join('')}${Array.from({length:days.length*6},()=>`<div class="cal-cell">${line('loading-day')}${line()}</div>`).join('')}</div></div>`;
  }
  if(page==='accounts')return `<div class="account-list"><div class="grid">${Array.from({length:2},()=>`<article class="card acc-card"><div class="acc-avatar loading-avatar" aria-hidden="true"></div><div class="info">${lines()}${controls()}</div></article>`).join('')}</div></div><section class="card"><h3>账号与项目权限</h3>${lines()}</section>`;
  if(page==='settings')return `<div class="settings-workspace"><section class="card"><div class="section-heading"><h3>${window.currentUser?.role==='admin'?'登录账号':'当前登录账号'}</h3></div>${window.currentUser?.role==='admin'?loadingRows(['账号 / 邮箱','显示名','角色','操作']):lines()}</section><section class="card connection-settings"><h3>Google Cloud 客户端配置</h3><p class="hint">管理 GSC / GA4 连接所需的应用配置</p>${line('loading-control')}${line('loading-control')}${line('loading-short')}</section></div>`;
  if(page==='mcp')return `<div class="settings-workspace mcp-workspace"><div class="tabs"><span class="tab active">MCP 管理</span><span class="tab">工具使用指南</span></div><div class="mcp-management-grid"><section class="card"><h3>个人 MCP Token</h3>${lines()}${controls()}</section><section class="card mcp-guide"><h3>连接指南</h3>${lines()}${lines()}</section></div></div>`;
  if(page==='dashboard')return `<div class="card dash-section"><div class="section-head"><h3>近期动态</h3><span class="section-note">任务按到期日排序</span></div><div class="dash-split">${['近期任务','项目列表'].map(label=>`<div class="dash-col"><div class="dash-col-title">${label}</div>${Array.from({length:4},()=>`<div class="item"><div class="mid">${lines()}</div></div>`).join('')}</div>`).join('')}</div></div>`;
  if(page==='docs')return `${controls(3)}${loadingRows(['标题','链接','项目','标签','操作'])}`;
  if(page==='project')return `<nav class="tabs"><span class="tab active">站内文章</span><span class="tab">站外文章</span><span class="tab">文案师与监控</span></nav><div class="card">${controls(3)}${loadingRows()}</div>`;
  return `${controls(3)}<div class="card">${loadingRows(['项目 / 文章','状态','GSC 点击','GA4 浏览','关键事件','操作'])}</div>`;
}

// 身份和数据尚未到达时仍提供页面定位；占位值不冒充真实的零或空列表。
export function renderPageLoading(el, page, options={}) {
  if(['ai-insights','ai-settings','ai-model-settings'].includes(page)){
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    el.innerHTML=aiLoading(page!=='ai-insights'?'configuration':params.has('insight')?'detail':params.has('project')?'project':'overview',params.get('module'));window.scrollTo(0,0);return;
  }
  const [title, description, stats] = labels[page] || labels.dashboard;
  if(page==='project-candidates'){
    el.innerHTML=`${candidateHeading}${candidateToolbar(options)}<section class="page-loading" aria-busy="true"><div class="loading-caption" role="status">正在读取项目候选…</div><div data-loading-body class="candidate-list">${Array.from({length:5},()=>`<article class="card candidate-card"><div class="loading-candidate-copy">${lines()}</div>${controls()}</article>`).join('')}</div></section>`;
    return;
  }
  el.innerHTML = `<section class="page-loading" aria-busy="true"><header class="page-head"><div><h2>${title}</h2><p class="page-desc">${description}</p></div></header>
    ${stats ? `<div class="stat-grid">${loadingStats(stats)}</div>` : ''}
    <div class="loading-caption" role="status">正在读取数据…</div><div data-loading-body>${loadingBody(page)}</div></section>`;
}

export function renderPageError(el, error, retry) {
  const body = el.querySelector('[data-loading-body]') || el.querySelector('.page-loading .card') || el;
  body.innerHTML = `<div class="empty" role="alert">加载失败：${esc(error.message || error)}<p><button class="btn" data-page-retry>重试</button></p></div>`;
  el.querySelector('.page-loading')?.removeAttribute('aria-busy');
  el.querySelector('.page-loading > .loading-caption')?.remove();
  body.querySelector('[data-page-retry]').onclick = retry;
}
