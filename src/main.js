import {
  putStreams, getAllStreams, streamCount, rememberFile, listFiles,
  getTracks, getArtists, clearAll, getMeta, setMeta
} from './store.js';
import { parseFile, parseFilename } from './parser.js';
import * as I from './insights.js';
import * as C from './charts.js';
import * as E from './enrich.js';
import * as X from './excludes.js';

// === theme ===
const THEME_KEY = 'shx-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
document.getElementById('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// === DOM refs ===
const $ = id => document.getElementById(id);
const dropzone = $('dropzone');
const explainer = $('explainer');
const fileInput = $('fileInput');
const dzStatus = $('dzStatus');
const dashboard = $('dashboard');
const sectionsEl = $('sections');
const kpisEl = $('kpis');
const summaryLine = $('summaryLine');
const enrichDialog = $('enrichDialog');
const enrichStatus = $('enrichStatus');

// === helpers ===
function fmtNum(n) {
  if (n == null) return '-';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return n.toLocaleString();
}
function fmtDate(s) {
  if (!s) return '-';
  return s.slice(0,10);
}

// === FILE INTAKE ===
const yieldToBrowser = () => new Promise(r => setTimeout(r, 0));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function ingestFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let total = 0, added = 0, kept = 0, dropped = 0;
  const errors = [];
  const setStatus = (txt, isErr=false) => {
    dzStatus.innerHTML = isErr
      ? `<span style="color:var(--danger)">${txt}</span>`
      : txt;
  };
  setStatus(`parsing ${files.length} file${files.length>1?'s':''}…`);
  await yieldToBrowser();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStatus(`parsing ${i+1}/${files.length} · ${escapeHtml(f.name)}…`);
    await yieldToBrowser();
    try {
      const meta = parseFilename(f.name);
      if (meta && meta.kind === 'video') { dropped++; continue; }
      const streams = await parseFile(f);
      total += streams.length;
      setStatus(`storing ${i+1}/${files.length} · ${escapeHtml(f.name)} (${streams.length.toLocaleString()} entries)…`);
      await yieldToBrowser();
      const a = await putStreams(streams);
      added += a;
      kept += streams.length - a;
      await rememberFile(f.name);
    } catch (e) {
      console.error('ingest failed for', f.name, e);
      errors.push(`${f.name}: ${e && e.message ? e.message : e}`);
    }
  }

  const parts = [
    `parsed ${total.toLocaleString()} entries`,
    `${added.toLocaleString()} new`,
    `${kept.toLocaleString()} duplicates skipped`,
  ];
  if (dropped) parts.push(`${dropped} non-audio files`);
  let summary = parts.join(' · ');
  if (errors.length) summary += ` · ${errors.length} error${errors.length>1?'s':''}: ${errors[0]}`;
  setStatus(summary, errors.length > 0);

  try {
    await render();
  } catch (e) {
    console.error('render failed', e);
    setStatus(`render error: ${e && e.message ? e.message : e}`, true);
  }
}

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  ingestFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', async e => {
  await ingestFiles(e.target.files);
  e.target.value = '';
});

$('addMoreBtn').addEventListener('click', () => fileInput.click());
$('resetBtn').addEventListener('click', async () => {
  if (!confirm('Clear all imported data and Spotify connection?')) return;
  await clearAll();
  location.reload();
});

// === EXCLUDE DIALOG ===
$('excludeBtn').addEventListener('click', () => openExcludeDialog());
$('excludeCloseBtn').addEventListener('click', () => $('excludeDialog').close());
$('excludeSearch').addEventListener('input', () => renderExcludeList());
$('excludeClearBtn').addEventListener('click', async () => {
  await X.clearExcluded();
  await renderExcludeList();
  await render();
});
$('excludeDialog').addEventListener('close', () => render());

// Per-track aggregated index for the dialog (built once per open).
let _excludeIndex = null;

async function openExcludeDialog() {
  const streams = _allStreamsCache || (await getAllStreams());
  // Aggregate all-time totals across all (un-filtered) streams.
  // This ensures excluded tracks still appear in the dialog so they can be re-enabled.
  const map = new Map();
  for (const s of streams) {
    const k = X.trackKey(s);
    let agg = map.get(k);
    if (!agg) { agg = { key: k, label: s.track, artist: s.artist, ms: 0, plays: 0 }; map.set(k, agg); }
    agg.ms += s.ms;
    if (I.isRealPlay(s)) agg.plays += 1;
  }
  _excludeIndex = [...map.values()].sort((a,b) => b.ms - a.ms);
  $('excludeSearch').value = '';
  await renderExcludeList();
  $('excludeDialog').showModal();
  // focus the search box after opening
  setTimeout(() => $('excludeSearch').focus(), 0);
}

async function renderExcludeList() {
  if (!_excludeIndex) return;
  const set = await X.loadExcluded();
  $('excludeCount').textContent = set.size ? `· ${set.size} hidden` : '';
  const q = ($('excludeSearch').value || '').trim().toLowerCase();
  const list = $('excludeList');
  list.innerHTML = '';

  // Filter
  let rows = _excludeIndex;
  if (q) {
    rows = rows.filter(r =>
      (r.label && r.label.toLowerCase().includes(q)) ||
      (r.artist && r.artist.toLowerCase().includes(q))
    );
  }
  // Pin excluded tracks to the top so they're easy to find/restore
  rows = [...rows].sort((a, b) => {
    const ax = set.has(a.key) ? 0 : 1;
    const bx = set.has(b.key) ? 0 : 1;
    if (ax !== bx) return ax - bx;
    return b.ms - a.ms;
  });

  // Cap render to keep DOM light; the search box narrows further.
  const CAP = 500;
  const shown = rows.slice(0, CAP);
  $('excludeShown').textContent = rows.length > CAP
    ? `showing top ${CAP} of ${rows.length.toLocaleString()} — refine search`
    : `${rows.length.toLocaleString()} track${rows.length===1?'':'s'}`;

  if (!shown.length) {
    list.appendChild(el('div',{class:'exclude-empty'},['no tracks match']));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of shown) {
    const isExcluded = set.has(r.key);
    const row = el('div', { class: 'exclude-row' + (isExcluded ? ' excluded' : '') }, [
      el('div', { class: 'toggle' }),
      el('div', { class: 'name' }, [
        el('b', {}, [r.label || '?']),
        el('span', { class: 'a' }, ['— ' + (r.artist || 'unknown')]),
      ]),
      el('div', { class: 'stat' }, [`${r.plays.toLocaleString()} plays`]),
      el('div', { class: 'stat' }, [C.fmtMs(r.ms)]),
    ]);
    row.addEventListener('click', async () => {
      const next = !isExcluded;
      await X.setExcluded(r.key, next);
      await renderExcludeList();
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

// === ENRICHMENT DIALOG ===
$('enrichBtn').addEventListener('click', async () => openEnrichDialog());
async function openEnrichDialog() {
  $('redirectUri').textContent = E.redirectUri();
  const savedClient = await getMeta('spotify_client_id');
  if (savedClient) $('clientIdInput').value = savedClient;
  const connected = await E.isConnected();
  enrichStatus.innerHTML = connected ? '<b>connected.</b> click "connect spotify" again to refresh, or run enrichment now.' : '';
  if (connected) addRunEnrichmentButton();
  enrichDialog.showModal();
}
function addRunEnrichmentButton() {
  if ($('runEnrichBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'runEnrichBtn';
  btn.type = 'button';
  btn.className = 'btn primary';
  btn.textContent = 'run enrichment';
  btn.addEventListener('click', runEnrichment);
  $('enrichForm').querySelector('.row').appendChild(btn);
}
$('startAuthBtn').addEventListener('click', async () => {
  const id = $('clientIdInput').value.trim();
  if (!id) { enrichStatus.textContent = 'enter your client id first'; return; }
  enrichStatus.textContent = 'redirecting to spotify…';
  await E.startAuth(id);
});
$('csvBtn').addEventListener('click', () => $('csvInput').click());
$('csvInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let imported = 0;
  enrichStatus.innerHTML = `<div class="progress"><div style="width:0%"></div></div>importing CSV…`;
  for (let i=0;i<files.length;i++) {
    const f = files[i];
    const text = await f.text();
    try {
      const r = await E.importCsv(text);
      imported += r.tracks;
    } catch (err) {
      enrichStatus.textContent = err.message;
    }
    enrichStatus.querySelector('.progress > div').style.width = ((i+1)/files.length*100)+'%';
  }
  enrichStatus.textContent = `imported ${imported.toLocaleString()} tracks from CSV.`;
  enrichDialog.close();
  await render();
});

async function runEnrichment() {
  const streams = await getAllStreams();
  const ids = [...new Set(streams.map(s => s.tid).filter(Boolean))];
  enrichStatus.innerHTML =
    `<div class="progress"><div></div></div><div class="prg-label">fetching metadata for ${ids.length.toLocaleString()} unique tracks…</div>`;
  const bar = enrichStatus.querySelector('.progress > div');
  const lbl = enrichStatus.querySelector('.prg-label');
  try {
    await E.enrichTracks(ids, (done, total, label) => {
      bar.style.width = total ? ((done/total)*100).toFixed(1)+'%' : '100%';
      lbl.textContent = `${label}: ${done.toLocaleString()}/${total.toLocaleString()}`;
    });
    enrichStatus.innerHTML = '<b>done.</b> closing…';
    setTimeout(() => { enrichDialog.close(); render(); }, 600);
  } catch (e) {
    enrichStatus.textContent = 'error: ' + e.message;
  }
}

// === RENDER ===
// Cached, all-streams (un-filtered) for the exclude-dialog UI.
let _allStreamsCache = null;

async function render() {
  const allStreams = await getAllStreams();
  _allStreamsCache = allStreams;
  const hasData = allStreams.length > 0;
  $('enrichBtn').style.display = hasData ? '' : 'none';
  $('addMoreBtn').style.display = hasData ? '' : 'none';
  $('resetBtn').style.display = hasData ? '' : 'none';
  $('excludeBtn').style.display = hasData ? '' : 'none';
  if (!hasData) {
    dashboard.classList.add('hidden');
    dropzone.classList.remove('hidden');
    explainer?.classList.remove('hidden');
    summaryLine.textContent = '';
    return;
  }
  dropzone.classList.add('hidden');
  explainer?.classList.add('hidden');
  dashboard.classList.remove('hidden');
  const excluded = await X.loadExcluded();
  updateExcludeBadge(excluded.size);
  const streams = X.applyExclusions(allStreams, excluded);
  const tracksArr = await getTracks();
  const artistsArr = await getArtists();
  const tracks = new Map(tracksArr.map(t => [t.id, t]));
  const artists = new Map(artistsArr.map(a => [a.id, a]));
  renderDashboard(streams, tracks, artists, excluded);
}

function updateExcludeBadge(n) {
  const btn = $('excludeBtn');
  let badge = btn.querySelector('.btn-badge');
  if (n > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'btn-badge'; btn.appendChild(badge); }
    badge.textContent = String(n);
  } else if (badge) {
    badge.remove();
  }
}

function el(tag, attrs={}, children=[]) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

function kpi(label, value, hint) {
  return el('div',{class:'kpi'},[
    el('div',{class:'v'},[String(value)]),
    el('div',{class:'l'},[label]),
    hint ? el('div',{class:'h'},[hint]) : null,
  ]);
}

function section(title, meta, body, openByDefault=false) {
  const open = openByDefault;
  const hdr = el('header',{},[
    el('div',{},[
      el('span',{class:'chev'},['▶ ']),
      el('h2',{style:'display:inline'},[title]),
    ]),
    el('span',{class:'meta'},[meta || '']),
  ]);
  const sec = el('section',{class:'section'+(open?' open':'')},[hdr, el('div',{class:'body'},[body])]);
  hdr.addEventListener('click', () => sec.classList.toggle('open'));
  return sec;
}

function tableTopRows(rows, cols) {
  // cols: [{label, get, num?, bar?, node?}]  node=true => get() returns an Element
  const barCol = cols.find(c=>c.bar);
  const max = Math.max(1, ...rows.map((r,i) => barCol ? (barCol.get(r,i)||0) : 0));
  const tbl = el('table',{class:'lite'});
  const thead = el('thead');
  const trh = el('tr');
  for (const c of cols) trh.appendChild(el('th',{class:c.num?'num':''},[c.label||'']));
  thead.appendChild(trh); tbl.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr');
    for (const c of cols) {
      if (c.bar) {
        const v = c.get(r, i);
        const td = el('td',{class:'bar-cell num'});
        const w = (v/max)*100;
        const bar = el('div',{class:'bar',style:`width:${w}%`});
        const lbl = el('div',{class:'bar-label'},[c.format?c.format(v):fmtNum(v)]);
        td.appendChild(bar); td.appendChild(lbl);
        tr.appendChild(td);
      } else if (c.node) {
        const td = el('td',{class:c.num?'num':''});
        const node = c.get(r, i);
        if (node) td.appendChild(node);
        tr.appendChild(td);
      } else {
        const v = c.get(r, i);
        tr.appendChild(el('td',{class:c.num?'num':''},[c.format?c.format(v):String(v??'')]));
      }
    }
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  return tbl;
}

function makeExcludeBtn(key, isOn=false) {
  const btn = el('button', {
    class: 'row-act' + (isOn ? ' on' : ''),
    type: 'button',
    title: isOn ? 'Re-include in analytics' : 'Exclude from analytics',
    'aria-label': 'toggle exclusion',
  }, [isOn ? '↺' : '×']);
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const set = await X.loadExcluded();
    const next = !set.has(key);
    await X.setExcluded(key, next);
    await render();
  });
  return btn;
}

function renderDashboard(streams, tracks, artists, excluded) {
  // === overview / KPIs ===
  const sm = I.summary(streams);
  const yearsSpan = sm.firstTs && sm.lastTs ? `${sm.firstTs.slice(0,10)} → ${sm.lastTs.slice(0,10)}` : '';
  summaryLine.textContent = ` · ${sm.plays.toLocaleString()} plays · ${C.fmtMs(sm.msPlayed)} · ${yearsSpan}`;

  const splits = I.splitMs(streams);
  const stk = I.streaks(streams);

  kpisEl.innerHTML = '';
  [
    kpi('listening time', C.fmtMs(sm.msPlayed), `${(sm.msPlayed/3600000).toFixed(0)} hours`),
    kpi('plays', fmtNum(sm.plays), `${(sm.skips? (sm.skips/(sm.plays+sm.skips)*100).toFixed(1):'0')}% skip rate`),
    kpi('unique tracks', fmtNum(sm.uniqueTracks)),
    kpi('unique artists', fmtNum(sm.uniqueArtists)),
    kpi('unique albums', fmtNum(sm.uniqueAlbums)),
    kpi('active days', fmtNum(stk.totalActiveDays), `longest streak: ${stk.longest}d`),
    kpi('shuffle share', `${Math.round(splits.shuffle/(splits.shuffle+splits.normal||1)*100)}%`),
    kpi('first stream', fmtDate(sm.firstTs)),
  ].forEach(k => kpisEl.appendChild(k));

  // === sections ===
  sectionsEl.innerHTML = '';

  // ----- Overall timeline -----
  {
    const monthly = I.timeline(streams, 'month', 'ms');
    const weekly = I.timeline(streams, 'week', 'ms');
    const body = el('div',{},[
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['monthly listening (hours)']),
        C.lineChart(monthly.map(d=>({x:d.x, y:d.y/3600000})), { yFormat: v => v.toFixed(0)+'h', xFormat: t => new Date(t).toISOString().slice(0,7) })
      ]),
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['weekly listening (hours)']),
        C.lineChart(weekly.map(d=>({x:d.x, y:d.y/3600000})), { yFormat: v => v.toFixed(0)+'h', xFormat: t => new Date(t).toISOString().slice(0,10) })
      ]),
    ]);
    sectionsEl.appendChild(section('Listening over time', `monthly · weekly`, body, true));
  }

  // ----- Habits / hour×day heatmap -----
  {
    const h = I.hourDayMatrix(streams);
    const dows = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const hours = Array.from({length:24}, (_,i)=>String(i).padStart(2,'0'));
    const hist = I.hourHistogram(streams);
    const dow  = I.dowHistogram(streams);
    const body = el('div',{class:'row'},[
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['hour × day-of-week (UTC)']),
        C.heatmap(h, dows, hours, { cell:14, format: v => C.fmtHours(v) })
      ]),
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['by hour of day']),
        C.barChart(hist.map((v,i)=>({label:String(i).padStart(2,'0'),value:v/3600000})), { horizontal:false, height:140, color:'var(--series-2)', format:v=>v.toFixed(1)+'h' }),
        el('div',{class:'chart-title',style:'margin-top:14px'},['by day of week']),
        C.barChart(dow.map((v,i)=>({label:dows[i],value:v/3600000})), { horizontal:true, color:'var(--series-3)', format:v=>v.toFixed(1)+'h', labelWidth:60 })
      ]),
    ]);
    sectionsEl.appendChild(section('Habits & timing', 'when you listen', body));
  }

  // ----- Calendar (one per year) -----
  {
    const { map, minY, maxY } = I.calendarMap(streams);
    if (minY != null) {
      const body = el('div',{});
      for (let y=maxY; y>=minY; y--) {
        body.appendChild(el('div',{class:'chart-title',style:'margin-top:10px'},[String(y)]));
        const wrap = el('div',{style:'overflow-x:auto'});
        wrap.appendChild(C.calendar(map, y, { format: v => C.fmtHours(v) }));
        body.appendChild(wrap);
      }
      sectionsEl.appendChild(section('Calendar', `${minY}–${maxY}`, body));
    }
  }

  // ----- Top artists / tracks / albums -----
  {
    const tArtists = I.topN(streams, s => s.artist || null, 25);
    const tTracks  = I.topN(streams, s => s.tid ? s.tid : (s.artist+'\u0001'+s.track), 25);
    // map track keys back to display
    const trackLabel = new Map();
    for (const s of streams) {
      const k = s.tid || (s.artist+'\u0001'+s.track);
      if (!trackLabel.has(k)) trackLabel.set(k, { label: s.track, sub: s.artist });
    }
    const tAlbums = I.topN(streams, s => s.album ? s.artist+'\u0001'+s.album : null, 25);
    const albumLabel = new Map();
    for (const s of streams) {
      if (!s.album) continue;
      const k = s.artist+'\u0001'+s.album;
      if (!albumLabel.has(k)) albumLabel.set(k, { label: s.album, sub: s.artist });
    }

    const body = el('div',{class:'row'},[
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['top artists by listening time']),
        tableTopRows(tArtists, [
          { label:'#', get:(_,i)=>i+1, num:true },
          { label:'artist', get:r=>r.key },
          { label:'plays', get:r=>r.plays, num:true, format:fmtNum },
          { label:'time', get:r=>r.ms, num:true, format:C.fmtMs, bar:true },
        ]),
      ]),
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['top tracks by listening time']),
        tableTopRows(tTracks, [
          { label:'#', get:(_,i)=>i+1, num:true },
          { label:'track', get:r => trackLabel.get(r.key)?.label || '?' },
          { label:'artist', get:r => trackLabel.get(r.key)?.sub || '' },
          { label:'plays', get:r=>r.plays, num:true, format:fmtNum },
          { label:'time', get:r=>r.ms, num:true, format:C.fmtMs, bar:true },
          { label:'', node:true, num:true, get:r => makeExcludeBtn(r.key) },
        ]),
      ]),
    ]);
    body.appendChild(el('div',{class:'col',style:'margin-top:18px;width:100%'},[
      el('div',{class:'chart-title'},['top albums']),
      tableTopRows(tAlbums, [
        { label:'#', get:(_,i)=>i+1, num:true },
        { label:'album', get:r => albumLabel.get(r.key)?.label || '?' },
        { label:'artist', get:r => albumLabel.get(r.key)?.sub || '' },
        { label:'plays', get:r=>r.plays, num:true, format:fmtNum },
        { label:'time', get:r=>r.ms, num:true, format:C.fmtMs, bar:true },
      ]),
    ]));
    // Add fix: tableTopRows uses (_, i) but we pass rows.map to td.get(r) — need to handle index
    // (See tableTopRows note below.)
    sectionsEl.appendChild(section('Top artists, tracks & albums', 'all-time', body));
  }

  // ----- Year-by-year top 10s -----
  {
    const yArtists = I.topByYear(streams, s => s.artist);
    const yTracks  = I.topByYear(streams, s => s.tid ? s.tid : (s.artist+'\u0001'+s.track));
    const trackLabel = new Map();
    for (const s of streams) {
      const k = s.tid || (s.artist+'\u0001'+s.track);
      if (!trackLabel.has(k)) trackLabel.set(k, { label: s.track, sub: s.artist });
    }
    const body = el('div',{});
    const years = yArtists.map(x => x.year);
    for (const y of years) {
      const a = yArtists.find(x => x.year === y);
      const t = yTracks.find(x => x.year === y);
      const wrap = el('div',{style:'margin-bottom:18px'});
      wrap.appendChild(el('div',{class:'chart-title',style:'font-size:14px;color:var(--fg);margin-bottom:6px'},[y]));
      const row = el('div',{class:'row'},[
        el('div',{class:'col'},[
          el('div',{class:'chart-title'},['top artists']),
          tableTopRows(a.items.map((r,i)=>({...r,_i:i})), [
            { label:'#', get:r=>r._i+1, num:true },
            { label:'artist', get:r=>r.key },
            { label:'time', get:r=>r.ms, num:true, format:C.fmtMs, bar:true },
          ]),
        ]),
        el('div',{class:'col'},[
          el('div',{class:'chart-title'},['top tracks']),
          tableTopRows(t.items.map((r,i)=>({...r,_i:i})), [
            { label:'#', get:r=>r._i+1, num:true },
            { label:'track', get:r=>trackLabel.get(r.key)?.label || '?' },
            { label:'artist', get:r=>trackLabel.get(r.key)?.sub || '' },
            { label:'time', get:r=>r.ms, num:true, format:C.fmtMs, bar:true },
            { label:'', node:true, num:true, get:r => makeExcludeBtn(r.key) },
          ]),
        ]),
      ]);
      wrap.appendChild(row);
      body.appendChild(wrap);
    }
    sectionsEl.appendChild(section('Year by year', `${years[0]}–${years[years.length-1]}`, body));
  }

  // ----- Discovery -----
  {
    const newTracks = I.discoveryTimeline(streams);
    const newArtists = I.newArtistsTimeline(streams);
    const dataT = [...newTracks.entries()].sort().map(([k,v])=>({x:new Date(k+'-01T00:00:00Z'),y:v}));
    const dataA = [...newArtists.entries()].sort().map(([k,v])=>({x:new Date(k+'-01T00:00:00Z'),y:v}));
    const body = el('div',{},[
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['new tracks discovered per month']),
        C.lineChart(dataT, { color:'var(--series-2)', xFormat:t=>new Date(t).toISOString().slice(0,7) }),
      ]),
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['new artists per month']),
        C.lineChart(dataA, { color:'var(--series-3)', xFormat:t=>new Date(t).toISOString().slice(0,7) }),
      ]),
    ]);
    sectionsEl.appendChild(section('Discovery', 'first-time tracks & artists', body));
  }

  // ----- Stacked share of top artists -----
  {
    const { topArtists, monthMap } = I.topArtistShares(streams, 6);
    const months = [...monthMap.keys()].sort();
    const series = [...topArtists, '_other'].map((a,i) => ({
      label: a === '_other' ? 'Other' : a,
      color: ['var(--series-1)','var(--series-2)','var(--series-3)','var(--series-4)','var(--series-5)','var(--series-6)','var(--line)'][i],
      data: months.map(m => ({ x: new Date(m+'-01T00:00:00Z'), y: monthMap.get(m)[a] || 0 })),
    }));
    const legend = el('div',{class:'legend'},
      series.map(s => el('span',{},[
        el('span',{class:'sw',style:`background:${s.color}`}),
        s.label
      ]))
    );
    const body = el('div',{},[
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['monthly listening time, top 6 artists vs everyone else']),
        C.stackedArea(series, { yFormat: v => (v/3600000).toFixed(0)+'h', xFormat: t => new Date(t).toISOString().slice(0,7) }),
        legend,
      ]),
      el('div',{class:'chart-wrap'},[
        el('div',{class:'chart-title'},['share over time (normalized)']),
        C.stackedArea(series, { normalize:true, xFormat: t => new Date(t).toISOString().slice(0,7) }),
      ]),
    ]);
    sectionsEl.appendChild(section('Top-artist share over time', 'how dominant your favourites are', body));
  }

  // ----- Behaviour: skips, shuffle, reasons -----
  {
    const reasons = I.reasonHistograms(streams);
    const sortMap = m => [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([label,value])=>({label,value}));
    const body = el('div',{class:'row'},[
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['why a track started']),
        C.barChart(sortMap(reasons.start), { horizontal:true, color:'var(--series-2)', format:fmtNum, labelWidth:120 }),
      ]),
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['why a track ended']),
        C.barChart(sortMap(reasons.end), { horizontal:true, color:'var(--series-3)', format:fmtNum, labelWidth:120 }),
      ]),
    ]);

    // Most-skipped songs (>= 5 skips)
    const skipMap = new Map();
    const playMap = new Map();
    const labels = new Map();
    for (const s of streams) {
      const k = s.tid || (s.artist+'\u0001'+s.track);
      if (!labels.has(k)) labels.set(k, { label: s.track, sub: s.artist });
      if (I.isSkip(s)) skipMap.set(k, (skipMap.get(k)||0)+1);
      else if (I.isRealPlay(s)) playMap.set(k, (playMap.get(k)||0)+1);
    }
    const candidates = [...skipMap.entries()]
      .filter(([k,v])=>v>=5)
      .map(([k,sk]) => ({key:k, skips:sk, plays:playMap.get(k)||0, label:labels.get(k)}))
      .sort((a,b)=>b.skips-a.skips).slice(0,15);
    if (candidates.length) {
      body.appendChild(el('div',{class:'col',style:'width:100%'},[
        el('div',{class:'chart-title',style:'margin-top:12px'},['most skipped (≥5 skips)']),
        tableTopRows(candidates, [
          { label:'#', get:(_,i)=>i+1, num:true },
          { label:'track', get:r=>r.label.label },
          { label:'artist', get:r=>r.label.sub },
          { label:'plays', get:r=>r.plays, num:true, format:fmtNum },
          { label:'skips', get:r=>r.skips, num:true, format:fmtNum, bar:true },
        ]),
      ]));
    }
    sectionsEl.appendChild(section('Behaviour: skips, shuffle, reasons', `${sm.skips.toLocaleString()} skips`, body));
  }

  // ----- Platforms / countries -----
  {
    const plats = [...sm.platforms.entries()].sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value}));
    const cs = [...sm.countries.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([label,value])=>({label,value}));
    const body = el('div',{class:'row'},[
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['listening time by device/platform']),
        C.barChart(plats.map(p=>({label:p.label,value:p.value})), { horizontal:true, color:'var(--series-4)', format:C.fmtMs, labelWidth:80 }),
      ]),
      el('div',{class:'col'},[
        el('div',{class:'chart-title'},['by country (plays)']),
        C.barChart(cs, { horizontal:true, color:'var(--series-5)', format:fmtNum, labelWidth:60 }),
      ]),
    ]);
    sectionsEl.appendChild(section('Platforms & places', 'where you listened', body));
  }

  // ----- Streaks & milestones -----
  {
    const sorted = [...streams].filter(I.isRealPlay).sort((a,b)=>a.ts<b.ts?-1:1);
    const total = sorted.length;
    const milestones = [];
    const targets = [1, 100, 1000, 10000, 25000, 50000, 100000, 250000];
    for (const t of targets) if (t <= total) milestones.push({ n: t, s: sorted[t-1] });
    const body = el('div',{},[
      el('table',{class:'lite'},[
        (() => {
          const thead = el('thead',{},[el('tr',{},[
            el('th',{},['milestone']),
            el('th',{},['date']),
            el('th',{},['track']),
            el('th',{},['artist']),
          ])]);
          const tbody = el('tbody');
          for (const m of milestones) {
            tbody.appendChild(el('tr',{},[
              el('td',{class:'num'},[fmtNum(m.n)+'th play']),
              el('td',{},[fmtDate(m.s.ts)]),
              el('td',{},[m.s.track]),
              el('td',{},[m.s.artist]),
            ]));
          }
          const t = el('table',{class:'lite'});
          t.appendChild(thead); t.appendChild(tbody);
          return t;
        })(),
      ]),
      el('div',{class:'pillrow',style:'margin-top:10px'},[
        el('span',{class:'pill'},[el('b',{},[String(stk.longest)+'d ']),'longest streak']),
        stk.start ? el('span',{class:'pill'},['from ',el('b',{},[stk.start])]) : null,
        stk.end ? el('span',{class:'pill'},['to ',el('b',{},[stk.end])]) : null,
        el('span',{class:'pill'},[el('b',{},[String(stk.totalActiveDays)]),' active days']),
      ].filter(Boolean)),
    ]);
    sectionsEl.appendChild(section('Streaks & milestones', '', body));
  }

  // ----- ENRICHED SECTIONS (only if metadata present) -----
  if (tracks.size > 0) {
    renderEnrichedSections(streams, tracks, artists);
  } else {
    const hint = el('div',{class:'muted small',style:'padding:6px 0'},[
      'Click "enrich" in the top right to fetch ',
      el('b',{},['genres, popularity, release date, and audio features']),
      ' from Spotify (privacy-first via PKCE OAuth) or import an Exportify CSV.'
    ]);
    sectionsEl.appendChild(section('Genres, audio features, taste vintage', 'enrich required', hint));
  }
}

function renderEnrichedSections(streams, tracks, artists) {
  // ===== Genres =====
  {
    const g = I.genreTotals(streams, tracks, artists);
    const sorted = [...g.entries()].sort((a,b)=>b[1]-a[1]);
    const top = sorted.slice(0,30).map(([label,value])=>({label,value}));
    const body = el('div',{},[
      el('div',{class:'chart-title'},[`${sorted.length.toLocaleString()} unique genres detected`]),
      C.barChart(top, { horizontal:true, color:'var(--series-1)', format:C.fmtMs, labelWidth:160 }),
    ]);
    sectionsEl.appendChild(section('Genres', `top ${top.length}`, body));
  }

  // ===== Audio features =====
  {
    const af = I.audioFeatureWeighted(streams, tracks);
    if (af) {
      const features = ['energy','valence','danceability','acousticness','instrumentalness','liveness','speechiness'];
      const tbl = el('table',{class:'lite'});
      const thead = el('thead',{},[el('tr',{},[
        el('th',{},['feature']),
        el('th',{class:'num'},['weighted average']),
        el('th',{class:'num',style:'width:50%'},['']),
      ])]);
      const tbody = el('tbody');
      for (const f of features) {
        const v = af[f];
        const tr = el('tr',{},[
          el('td',{},[f]),
          el('td',{class:'num'},[v.toFixed(3)]),
          (() => {
            const td = el('td',{class:'bar-cell num'});
            const bar = el('div',{class:'bar',style:`width:${(v*100).toFixed(1)}%`});
            const lbl = el('div',{class:'bar-label'},[(v*100).toFixed(1)+'%']);
            td.appendChild(bar); td.appendChild(lbl);
            return td;
          })(),
        ]);
        tbody.appendChild(tr);
      }
      tbl.appendChild(thead); tbl.appendChild(tbody);

      // Time-series of valence (mood) and energy
      const vSeries = I.audioFeatureByMonth(streams, tracks, 'valence');
      const eSeries = I.audioFeatureByMonth(streams, tracks, 'energy');
      const dSeries = I.audioFeatureByMonth(streams, tracks, 'danceability');
      const body = el('div',{},[
        tbl,
        el('div',{class:'chart-wrap'},[
          el('div',{class:'chart-title'},['valence (musical positivity) over time']),
          C.lineChart(vSeries, { color:'var(--series-3)', yFormat:v=>v.toFixed(2) }),
        ]),
        el('div',{class:'chart-wrap'},[
          el('div',{class:'chart-title'},['energy over time']),
          C.lineChart(eSeries, { color:'var(--series-2)', yFormat:v=>v.toFixed(2) }),
        ]),
        el('div',{class:'chart-wrap'},[
          el('div',{class:'chart-title'},['danceability over time']),
          C.lineChart(dSeries, { color:'var(--series-4)', yFormat:v=>v.toFixed(2) }),
        ]),
      ]);
      sectionsEl.appendChild(section('Audio features', 'mood, energy, danceability', body));

      // Scatter: valence vs energy (mood quadrants)
      const scatterData = [];
      const counts = new Map();
      for (const s of streams) {
        if (!I.isRealPlay(s) || !s.tid) continue;
        const t = tracks.get(s.tid);
        if (!t || t.valence == null || t.energy == null) continue;
        const k = s.tid;
        const c = counts.get(k) || { x:t.valence, y:t.energy, label:`${t.name} — ${(t.artistNames||[]).join(', ')}`, r:0 };
        c.r += 1;
        counts.set(k, c);
      }
      // size by sqrt of plays, capped
      const arr = [...counts.values()].map(d => ({ ...d, r: Math.min(8, 1.5 + Math.sqrt(d.r) * 0.6) }));
      const body2 = el('div',{},[
        el('div',{class:'chart-title'},['mood map: valence (sad ← → happy) × energy (calm ↓ ↑ intense)']),
        C.scatter(arr, { xMin:0, xMax:1, yMin:0, yMax:1, xLabel:'valence', yLabel:'energy', color:'var(--series-1)', height:340 }),
      ]);
      sectionsEl.appendChild(section('Mood map', `${arr.length.toLocaleString()} unique tracks plotted`, body2));
    }
  }

  // ===== Taste vintage =====
  {
    const yh = I.releaseYearHistogram(streams, tracks);
    const data = [...yh.entries()].sort((a,b)=>a[0]-b[0]);
    if (data.length) {
      const minY = data[0][0], maxY = data[data.length-1][0];
      const arr = [];
      for (let y=minY; y<=maxY; y++) arr.push({ label:String(y), value:(yh.get(y)||0)/3600000 });
      const body = el('div',{},[
        el('div',{class:'chart-title'},['listening time by release year of track']),
        C.barChart(arr, { horizontal:false, color:'var(--series-5)', height:200, format:v=>v.toFixed(1)+'h' }),
      ]);
      sectionsEl.appendChild(section('Taste vintage', `${minY}–${maxY}`, body));
    }
  }

  // ===== Popularity histogram =====
  {
    const ph = I.popularityHistogram(streams, tracks);
    const labels = ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-99'];
    const data = ph.map((v,i)=>({label:labels[i],value:v/3600000}));
    const body = el('div',{},[
      el('div',{class:'chart-title'},['hours listened by track popularity (Spotify\'s 0–100 score)']),
      C.barChart(data, { horizontal:false, color:'var(--series-2)', height:180, format:v=>v.toFixed(1)+'h' }),
    ]);
    sectionsEl.appendChild(section('Popularity', 'mainstream vs deep cuts', body));
  }
}

// === BOOT ===
(async () => {
  // Handle returning from Spotify auth
  const r = await E.handleAuthRedirect();
  if (r) {
    if (r.error) {
      alert('Spotify auth error: ' + r.error);
    } else if (r.ok) {
      // Reopen dialog so user can run enrichment now that we're connected
      await render();
      openEnrichDialog();
      return;
    }
  }
  await render();
})();

// About link
$('aboutLink').addEventListener('click', (e) => {
  e.preventDefault();
  alert(
    'streaming history dashboard\n\n' +
    'Everything runs locally in your browser. Imported streams and any ' +
    'Spotify metadata you fetch are stored only in IndexedDB on this device.\n\n' +
    'Files matching Streaming_History_Audio_*.json are accepted; podcast / ' +
    'video entries are discarded.\n\n' +
    'Click "enrich" to add genres, audio features, popularity and release ' +
    'dates via Spotify\'s catalog API (PKCE OAuth, no backend).'
  );
});
