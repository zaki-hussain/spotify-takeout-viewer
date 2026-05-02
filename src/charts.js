// Tiny SVG chart helpers. No external libs.
// All functions return an SVGElement. They size themselves to a width.

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs={}, children=[]) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) {
    if (attrs[k] === undefined || attrs[k] === null) continue;
    e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function tipMgr() {
  let tip = document.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);
  }
  return {
    show(x, y, html) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      const px = Math.min(window.innerWidth - r.width - 8, x + 12);
      const py = Math.max(8, y - r.height - 8);
      tip.style.left = px + 'px';
      tip.style.top = py + 'px';
    },
    hide() { tip.style.display = 'none'; }
  };
}
const TIP = tipMgr();

const COLORS = ['var(--series-1)','var(--series-2)','var(--series-3)','var(--series-4)','var(--series-5)','var(--series-6)'];

function fmtNum(n) {
  if (n == null) return '';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e4) return (n/1e3).toFixed(0)+'k';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return Math.round(n).toString();
}
export function fmtHours(ms) {
  const h = ms / 3600000;
  if (h >= 100) return h.toFixed(0)+' h';
  if (h >= 10) return h.toFixed(1)+' h';
  if (h >= 1) return h.toFixed(2)+' h';
  const m = ms/60000;
  if (m >= 1) return m.toFixed(0)+' m';
  return Math.round(ms/1000)+' s';
}

export function fmtMs(ms) {
  const total = Math.round(ms/1000);
  const d = Math.floor(total/86400);
  const h = Math.floor((total%86400)/3600);
  const m = Math.floor((total%3600)/60);
  const parts = [];
  if (d) parts.push(d+'d');
  if (h || d) parts.push(h+'h');
  parts.push(m+'m');
  return parts.join(' ');
}

// === LINE / AREA ===
// data: [{x: Date|number, y: number}], options: {height, color, area, yLabel}
export function lineChart(data, opts={}) {
  const W = opts.width || 720;
  const H = opts.height || 160;
  const pad = { l: 36, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  if (!data.length) return el('svg',{class:'chart',viewBox:`0 0 ${W} ${H}`,width:'100%',height:H});

  const xs = data.map(d => +d.x);
  const ys = data.map(d => d.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymax = Math.max(1, ...ys);
  const ymin = 0;
  const sx = x => pad.l + ((+x - xmin) / Math.max(1, xmax - xmin)) * iw;
  const sy = y => pad.t + ih - ((y - ymin) / (ymax - ymin || 1)) * ih;

  const svg = el('svg', { class:'chart', viewBox:`0 0 ${W} ${H}`, width:'100%', height:H, preserveAspectRatio:'none' });

  // gridlines (5)
  const gridG = el('g',{class:'grid'});
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih/4)*i;
    gridG.appendChild(el('line',{x1:pad.l,x2:W-pad.r,y1:y,y2:y}));
  }
  svg.appendChild(gridG);

  // y-axis labels
  const axis = el('g',{class:'axis'});
  for (let i = 0; i <= 4; i++) {
    const v = ymax - (ymax/4)*i;
    const y = pad.t + (ih/4)*i;
    axis.appendChild(el('text',{x:pad.l-6,y:y+3,'text-anchor':'end'},[opts.yFormat ? opts.yFormat(v) : fmtNum(v)]));
  }
  // x-axis labels (5 ticks)
  const xticks = 5;
  for (let i = 0; i <= xticks; i++) {
    const t = xmin + (xmax-xmin)*(i/xticks);
    const x = pad.l + iw*(i/xticks);
    const lbl = opts.xFormat ? opts.xFormat(t) : new Date(t).toISOString().slice(0,7);
    axis.appendChild(el('text',{x,y:H-6,'text-anchor':'middle'},[lbl]));
  }
  svg.appendChild(axis);

  // path
  const d = data.map((pt,i) => `${i===0?'M':'L'}${sx(pt.x).toFixed(2)},${sy(pt.y).toFixed(2)}`).join('');
  if (opts.area !== false) {
    const areaD = d + ` L${sx(xs[xs.length-1])},${sy(0)} L${sx(xs[0])},${sy(0)} Z`;
    svg.appendChild(el('path',{d:areaD,class:'area',fill:opts.color||'var(--series-1)'}));
  }
  svg.appendChild(el('path',{d,class:'series',stroke:opts.color||'var(--series-1)'}));

  // hover overlay
  const overlay = el('rect',{x:pad.l,y:pad.t,width:iw,height:ih,fill:'transparent'});
  const dot = el('circle',{r:3,fill:opts.color||'var(--series-1)',style:'display:none'});
  const vline = el('line',{y1:pad.t,y2:pad.t+ih,stroke:'var(--line)',style:'display:none'});
  svg.appendChild(vline); svg.appendChild(dot); svg.appendChild(overlay);
  overlay.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const t = xmin + (px - pad.l) / iw * (xmax - xmin);
    let best = data[0], bestd = Infinity;
    for (const d of data) { const dd = Math.abs(+d.x - t); if (dd < bestd) { bestd = dd; best = d; } }
    const x = sx(+best.x), y = sy(best.y);
    dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.style.display='';
    vline.setAttribute('x1',x); vline.setAttribute('x2',x); vline.style.display='';
    const lbl = opts.xLabel ? opts.xLabel(+best.x) : new Date(+best.x).toISOString().slice(0,10);
    const yl = opts.yFormat ? opts.yFormat(best.y) : fmtNum(best.y);
    TIP.show(ev.clientX, ev.clientY, `<b>${yl}</b><br><span class="muted">${lbl}</span>`);
  });
  overlay.addEventListener('mouseleave', () => { dot.style.display='none'; vline.style.display='none'; TIP.hide(); });

  return svg;
}

// === BAR ===
// data: [{label, value}]
export function barChart(data, opts={}) {
  const horiz = opts.horizontal !== false;
  const W = opts.width || 480;
  const rowH = opts.rowHeight || 18;
  const H = horiz ? Math.max(60, data.length * rowH + 20) : (opts.height || 180);

  const svg = el('svg', { class:'chart', viewBox:`0 0 ${W} ${H}`, width:'100%', height:H });
  if (!data.length) return svg;
  const max = Math.max(...data.map(d => d.value), 1);

  if (horiz) {
    const labelW = opts.labelWidth || 140;
    const valW = opts.valueWidth || 50;
    const barW = W - labelW - valW - 8;
    data.forEach((d,i) => {
      const y = i*rowH + 6;
      svg.appendChild(el('text',{x:labelW-6,y:y+rowH-6,'text-anchor':'end',fill:'var(--fg)'},[d.label.length>22?d.label.slice(0,21)+'…':d.label]));
      const w = (d.value/max)*barW;
      svg.appendChild(el('rect',{x:labelW,y:y,width:w,height:rowH-6,fill:opts.color||'var(--series-1)',opacity:.85,rx:2}));
      const lbl = opts.format ? opts.format(d.value) : fmtNum(d.value);
      svg.appendChild(el('text',{x:labelW+w+4,y:y+rowH-6,fill:'var(--muted)'},[lbl]));
      // tooltip area
      const hit = el('rect',{x:0,y:y-2,width:W,height:rowH,fill:'transparent'});
      hit.addEventListener('mouseenter', (e) => TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${lbl}${d.sub?'<br><span class="muted">'+d.sub+'</span>':''}`));
      hit.addEventListener('mousemove', (e) => TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${lbl}${d.sub?'<br><span class="muted">'+d.sub+'</span>':''}`));
      hit.addEventListener('mouseleave', () => TIP.hide());
      svg.appendChild(hit);
    });
  } else {
    const pad = { l:30, r:8, t:6, b:24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const bw = iw / data.length;
    data.forEach((d,i) => {
      const h = (d.value/max)*ih;
      const x = pad.l + i*bw + 1;
      const y = pad.t + ih - h;
      svg.appendChild(el('rect',{x,y,width:Math.max(1,bw-2),height:h,fill:opts.color||'var(--series-2)',rx:2}));
      if (data.length <= 24 || i % Math.ceil(data.length/12) === 0) {
        svg.appendChild(el('text',{x:x+bw/2-1,y:H-8,'text-anchor':'middle'},[d.label]));
      }
      const hit = el('rect',{x:pad.l+i*bw,y:pad.t,width:bw,height:ih,fill:'transparent'});
      const lbl = opts.format ? opts.format(d.value) : fmtNum(d.value);
      hit.addEventListener('mouseenter',(e)=>TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${lbl}`));
      hit.addEventListener('mousemove',(e)=>TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${lbl}`));
      hit.addEventListener('mouseleave',()=>TIP.hide());
      svg.appendChild(hit);
    });
  }
  return svg;
}

// === HEATMAP (calendar / hour-of-day x day-of-week, etc) ===
// cells: 2D array values[row][col], rowLabels, colLabels
export function heatmap(values, rowLabels, colLabels, opts={}) {
  const cell = opts.cell || 14;
  const padL = opts.padL ?? 30;
  const padT = opts.padT ?? 18;
  const cols = colLabels.length;
  const rows = rowLabels.length;
  const W = padL + cols*cell + 4;
  const H = padT + rows*cell + 4;
  const svg = el('svg',{class:'chart',viewBox:`0 0 ${W} ${H}`,width:W,height:H});

  let max = 0;
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) if (values[r][c] > max) max = values[r][c];
  if (max === 0) max = 1;

  for (let c=0;c<cols;c++) {
    if (c % (opts.colStep || 1) === 0)
      svg.appendChild(el('text',{x:padL+c*cell+cell/2,y:padT-4,'text-anchor':'middle'},[colLabels[c]]));
  }
  for (let r=0;r<rows;r++) {
    svg.appendChild(el('text',{x:padL-4,y:padT+r*cell+cell-3,'text-anchor':'end'},[rowLabels[r]]));
  }
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {
    const v = values[r][c] || 0;
    const a = v === 0 ? 0 : 0.15 + 0.85 * (v/max);
    const x = padL + c*cell, y = padT + r*cell;
    const rect = el('rect',{x,y,width:cell-1,height:cell-1,class:'heat-cell',fill:opts.color||'var(--accent)','fill-opacity':a});
    const lbl = opts.format ? opts.format(v) : fmtNum(v);
    rect.addEventListener('mouseenter',(e)=>TIP.show(e.clientX,e.clientY,`<b>${rowLabels[r]} · ${colLabels[c]}</b><br>${lbl}`));
    rect.addEventListener('mousemove',(e)=>TIP.show(e.clientX,e.clientY,`<b>${rowLabels[r]} · ${colLabels[c]}</b><br>${lbl}`));
    rect.addEventListener('mouseleave',()=>TIP.hide());
    svg.appendChild(rect);
  }
  return svg;
}

// === CALENDAR HEATMAP (GitHub-style) ===
// data: Map of yyyy-mm-dd -> value
export function calendar(map, year, opts={}) {
  const cell = opts.cell || 11;
  const gap = 2;
  const start = new Date(Date.UTC(year,0,1));
  const end = new Date(Date.UTC(year,11,31));
  const pad = { l: 24, t: 14 };
  // align to weeks: column = week index from start, row = day-of-week (0=Sun..6=Sat)
  const startWeekday = start.getUTCDay();
  const totalDays = Math.round((end - start)/86400000) + 1;
  const cols = Math.ceil((startWeekday + totalDays)/7);
  const W = pad.l + cols*(cell+gap);
  const H = pad.t + 7*(cell+gap) + 14;

  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  if (max === 0) max = 1;

  const svg = el('svg',{class:'chart',viewBox:`0 0 ${W} ${H}`,width:W,height:H});
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // month labels above first week of each month
  for (let m=0;m<12;m++) {
    const md = new Date(Date.UTC(year,m,1));
    const dayIdx = Math.round((md - start)/86400000) + startWeekday;
    const col = Math.floor(dayIdx/7);
    svg.appendChild(el('text',{x:pad.l+col*(cell+gap),y:pad.t-2},[months[m]]));
  }
  // day labels (Mon, Wed, Fri)
  ['Mon','Wed','Fri'].forEach((lbl,i) => {
    const r = [1,3,5][i];
    svg.appendChild(el('text',{x:pad.l-3,y:pad.t+r*(cell+gap)+cell-2,'text-anchor':'end'},[lbl]));
  });

  for (let i=0;i<totalDays;i++) {
    const d = new Date(start.getTime() + i*86400000);
    const idx = startWeekday + i;
    const col = Math.floor(idx/7);
    const row = idx % 7;
    const x = pad.l + col*(cell+gap);
    const y = pad.t + row*(cell+gap);
    const key = d.toISOString().slice(0,10);
    const v = map.get(key) || 0;
    const a = v === 0 ? 0.07 : 0.18 + 0.82*(v/max);
    const rect = el('rect',{x,y,width:cell,height:cell,rx:2,fill:opts.color||'var(--accent)','fill-opacity':a});
    const lbl = opts.format ? opts.format(v) : fmtNum(v);
    rect.addEventListener('mouseenter',(e)=>TIP.show(e.clientX,e.clientY,`<b>${key}</b><br>${lbl}`));
    rect.addEventListener('mousemove',(e)=>TIP.show(e.clientX,e.clientY,`<b>${key}</b><br>${lbl}`));
    rect.addEventListener('mouseleave',()=>TIP.hide());
    svg.appendChild(rect);
  }
  return svg;
}

// === STACKED AREA (multi-series line, normalised optional) ===
// series: [{label, color, data:[{x,y}]}]
export function stackedArea(series, opts={}) {
  const W = opts.width || 720;
  const H = opts.height || 200;
  const pad = { l:36, r:10, t:10, b:22 };
  const iw = W-pad.l-pad.r, ih = H-pad.t-pad.b;
  const svg = el('svg',{class:'chart',viewBox:`0 0 ${W} ${H}`,width:'100%',height:H});
  if (!series.length || !series[0].data.length) return svg;

  // assume all series share same x's
  const xs = series[0].data.map(d => +d.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  // compute stacked y at each x
  const stacked = xs.map((_,i) => {
    let acc = 0;
    return series.map(s => { acc += (s.data[i].y || 0); return acc; });
  });
  let ymax = 0;
  for (const row of stacked) ymax = Math.max(ymax, row[row.length-1]);
  if (opts.normalize) ymax = 1;
  ymax = Math.max(ymax, 1e-9);

  const sx = x => pad.l + ((x-xmin)/Math.max(1,xmax-xmin))*iw;
  const sy = y => pad.t + ih - (y/ymax)*ih;

  // grid
  const gridG = el('g',{class:'grid'});
  for (let i=0;i<=4;i++) {
    const y = pad.t + (ih/4)*i;
    gridG.appendChild(el('line',{x1:pad.l,x2:W-pad.r,y1:y,y2:y}));
  }
  svg.appendChild(gridG);

  // areas
  for (let s=series.length-1; s>=0; s--) {
    let d = '';
    for (let i=0;i<xs.length;i++) {
      const top = opts.normalize
        ? stacked[i][s] / (stacked[i][stacked[i].length-1] || 1)
        : stacked[i][s];
      d += (i===0?'M':'L') + sx(xs[i]).toFixed(2) + ',' + sy(top).toFixed(2);
    }
    for (let i=xs.length-1;i>=0;i--) {
      const below = s === 0 ? 0 :
        (opts.normalize
          ? stacked[i][s-1]/(stacked[i][stacked[i].length-1] || 1)
          : stacked[i][s-1]);
      d += 'L' + sx(xs[i]).toFixed(2) + ',' + sy(below).toFixed(2);
    }
    d += 'Z';
    svg.appendChild(el('path',{d,fill:series[s].color||COLORS[s%COLORS.length],opacity:.85}));
  }
  // x labels
  const axis = el('g',{class:'axis'});
  for (let i=0;i<=4;i++) {
    const t = xmin + (xmax-xmin)*(i/4);
    axis.appendChild(el('text',{x:pad.l + iw*(i/4),y:H-6,'text-anchor':'middle'},[opts.xFormat?opts.xFormat(t):new Date(t).toISOString().slice(0,7)]));
  }
  // y labels
  for (let i=0;i<=4;i++) {
    const v = ymax - (ymax/4)*i;
    axis.appendChild(el('text',{x:pad.l-6,y:pad.t+(ih/4)*i+3,'text-anchor':'end'},[opts.yFormat?opts.yFormat(v):(opts.normalize?Math.round(v*100)+'%':fmtNum(v))]));
  }
  svg.appendChild(axis);
  return svg;
}

// === SCATTER ===
// data: [{x,y,label?}]
export function scatter(data, opts={}) {
  const W = opts.width || 480;
  const H = opts.height || 220;
  const pad = { l:36, r:10, t:10, b:26 };
  const iw=W-pad.l-pad.r, ih=H-pad.t-pad.b;
  const svg = el('svg',{class:'chart',viewBox:`0 0 ${W} ${H}`,width:'100%',height:H});
  if (!data.length) return svg;
  const xs = data.map(d=>d.x), ys = data.map(d=>d.y);
  const xmin = opts.xMin ?? Math.min(...xs), xmax = opts.xMax ?? Math.max(...xs);
  const ymin = opts.yMin ?? Math.min(...ys), ymax = opts.yMax ?? Math.max(...ys);
  const sx = x => pad.l + ((x-xmin)/(xmax-xmin || 1))*iw;
  const sy = y => pad.t + ih - ((y-ymin)/(ymax-ymin || 1))*ih;

  // grid
  const g = el('g',{class:'grid'});
  for (let i=0;i<=4;i++) {
    g.appendChild(el('line',{x1:pad.l,x2:W-pad.r,y1:pad.t+ih*(i/4),y2:pad.t+ih*(i/4)}));
    g.appendChild(el('line',{y1:pad.t,y2:pad.t+ih,x1:pad.l+iw*(i/4),x2:pad.l+iw*(i/4)}));
  }
  svg.appendChild(g);

  for (const d of data) {
    const c = el('circle',{cx:sx(d.x),cy:sy(d.y),r:d.r||2.5,fill:opts.color||'var(--series-2)',opacity:.7});
    if (d.label) {
      c.addEventListener('mouseenter',(e)=>TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${opts.xLabel||'x'}=${d.x.toFixed(2)}<br>${opts.yLabel||'y'}=${d.y.toFixed(2)}`));
      c.addEventListener('mousemove',(e)=>TIP.show(e.clientX,e.clientY,`<b>${d.label}</b><br>${opts.xLabel||'x'}=${d.x.toFixed(2)}<br>${opts.yLabel||'y'}=${d.y.toFixed(2)}`));
      c.addEventListener('mouseleave',()=>TIP.hide());
    }
    svg.appendChild(c);
  }
  // axis labels
  if (opts.xLabel) svg.appendChild(el('text',{x:W/2,y:H-4,'text-anchor':'middle'},[opts.xLabel]));
  if (opts.yLabel) {
    const t = el('text',{x:0,y:0,'text-anchor':'middle',transform:`translate(10,${pad.t+ih/2}) rotate(-90)`},[opts.yLabel]);
    svg.appendChild(t);
  }
  return svg;
}
