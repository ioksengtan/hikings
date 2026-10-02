(() => {
  'use strict';

  const COLORS = ['#2f7d5b', '#d9662b', '#3b6fd4', '#b8368f', '#8a7a12', '#12909c', '#c23b3b', '#6a55c7'];
  const STORE_KEY = 'hikings.v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);

  const bundled = window.BUNDLED_ROUTES || [];
  const saved = load();
  const state = {
    user: saved.user || [],        // 使用者匯入的路線（存在 localStorage）
    selected: saved.selected || {}, // key -> { from, to }，key = routeId|dayIndex 或 routeId|p:節點>節點
    paths: saved.paths || {},       // routeId -> [{ via: [節點名稱, ...] }]，使用者自訂的起終點
    yMode: saved.yMode || 'abs'
  };
  let plotted = null; // 目前畫在圖上的資料，給滑鼠游標用
  let builder = null; // 正在編輯的自訂起終點 { routeId, via }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch { alert('瀏覽器儲存空間不足，這次匯入的路線重新整理後會消失。可先按「匯出 routes.js」保存。'); }
  }

  const allRoutes = () => bundled.concat(state.user);
  const keyOf = (routeId, dayIndex) => routeId + '|' + dayIndex;

  // ---------- GPX ----------

  function haversineKm(a, b) {
    const R = 6371.0088, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 台灣時間的日期字串，用來把多日軌跡切成每天一段
  function taipeiDate(ms) {
    return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
  }

  function parseGpx(text, fileName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('不是有效的 GPX');

    const groups = []; // [{ label, pts }]
    const segs = Array.from(doc.getElementsByTagName('trkseg'));
    if (!segs.length) segs.push(...doc.getElementsByTagName('rte'));
    let hasTime = true;

    segs.forEach((seg, i) => {
      const pts = [];
      for (const el of seg.children) {
        if (el.localName !== 'trkpt' && el.localName !== 'rtept') continue;
        const child = (name) => Array.from(el.children).find((c) => c.localName === name);
        const ele = parseFloat(child('ele')?.textContent);
        const lat = parseFloat(el.getAttribute('lat')), lon = parseFloat(el.getAttribute('lon'));
        if (!isFinite(ele) || !isFinite(lat) || !isFinite(lon)) continue;
        const time = Date.parse(child('time')?.textContent || '');
        if (!isFinite(time)) hasTime = false;
        pts.push({ lat, lon, ele, time });
      }
      if (pts.length > 1) groups.push({ label: '第 ' + (i + 1) + ' 段', pts });
    });
    if (!groups.length) throw new Error('找不到含海拔的軌跡點');

    let days = groups;
    if (hasTime) {
      const byDate = new Map();
      groups.flatMap((g) => g.pts).sort((a, b) => a.time - b.time).forEach((p) => {
        const d = taipeiDate(p.time);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(p);
      });
      days = Array.from(byDate, ([date, pts], i) => ({ label: 'D' + (i + 1) + ' ' + date, pts }))
        .filter((d) => d.pts.length > 1);
    }
    if (days.length === 1) days[0].label = '全程';

    const metaName = doc.querySelector('trk > name, metadata > name')?.textContent.trim();
    return {
      id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: metaName || fileName.replace(/\.gpx$/i, ''),
      days: days.map((d) => ({ name: d.label, points: toProfile(d.pts) }))
    };
  }

  // 經緯度點 -> [里程 km, 海拔 m]，並抽稀到大約每 20 m 一點
  function toProfile(pts) {
    const out = [[0, Math.round(pts[0].ele)]];
    let dist = 0, lastKept = 0;
    for (let i = 1; i < pts.length; i++) {
      dist += haversineKm(pts[i - 1], pts[i]);
      if (dist - lastKept >= 0.02 || i === pts.length - 1) {
        out.push([+dist.toFixed(3), Math.round(pts[i].ele)]);
        lastKept = dist;
      }
    }
    return out;
  }

  async function importFiles(files) {
    const errors = [];
    for (const file of files) {
      try {
        const route = parseGpx(await file.text(), file.name);
        state.user.push(route);
        route.days.forEach((_, i) => { state.selected[keyOf(route.id, i)] = {}; });
      } catch (e) {
        errors.push(file.name + '：' + e.message);
      }
    }
    save();
    render();
    if (errors.length) alert('以下檔案無法匯入：\n' + errors.join('\n'));
  }

  // ---------- 計算 ----------

  function interp(points, km) {
    if (km <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (km <= points[i][0]) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        return x1 === x0 ? y1 : y0 + (y1 - y0) * (km - x0) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  }

  // 取出 [from, to] 這一段，里程重新從 0 起算
  function slice(points, from, to) {
    const nameAt = (km) => (points.find((p) => p[0] === km) || [])[2];
    const out = [[0, interp(points, from), nameAt(from)]];
    for (const [x, y, name] of points) if (x > from && x < to) out.push([x - from, y, name]);
    out.push([to - from, interp(points, to), nameAt(to)]);
    return out;
  }

  // 3 m 以下的起伏視為 GPS 雜訊，不計入爬升/下降
  function stats(points) {
    let gain = 0, loss = 0, ref = points[0][1], min = ref, max = ref;
    for (const [, y] of points) {
      min = Math.min(min, y); max = Math.max(max, y);
      const d = y - ref;
      if (Math.abs(d) >= 3) { if (d > 0) gain += d; else loss -= d; ref = y; }
    }
    return { dist: points[points.length - 1][0], gain, loss, min, max };
  }

  // ---------- 路線圖（graph） ----------
  // 有名稱的點是節點；同一段裡相鄰兩個節點之間的剖面是一條邊，正反向都能走。
  // 不同段落裡同名的節點視為同一個點，所以 D1、D2 會在山屋接起來。

  function graphOf(route) {
    const adj = new Map(); // 節點名稱 -> [{ to, points, dist }]
    const link = (a, b, points) => adj.get(a).push({ to: b, points, dist: points[points.length - 1][0] });
    route.days.forEach((day) => {
      let last = -1;
      day.points.forEach((p, j) => {
        if (!p[2]) return;
        if (!adj.has(p[2])) adj.set(p[2], []);
        if (last >= 0 && day.points[last][2] !== p[2]) {
          const part = day.points.slice(last, j + 1), x0 = part[0][0], x1 = p[0];
          link(part[0][2], p[2], part.map(([x, y, n]) => [+(x - x0).toFixed(3), y, n]));
          link(p[2], part[0][2], part.map(([x, y, n]) => [+(x1 - x).toFixed(3), y, n]).reverse());
        }
        last = j;
      });
    });
    return adj;
  }

  // 兩個節點之間里程最短的走法（Dijkstra），回傳依序經過的邊；走不到回傳 null
  function shortest(adj, a, b) {
    const best = new Map([[a, { dist: 0, edges: [] }]]), done = new Set();
    for (;;) {
      let cur = null;
      for (const [n, v] of best) if (!done.has(n) && (cur == null || v.dist < best.get(cur).dist)) cur = n;
      if (cur == null) return null;
      if (cur === b) return best.get(cur).edges;
      done.add(cur);
      for (const e of adj.get(cur) || []) {
        const dist = best.get(cur).dist + e.dist;
        if (!best.has(e.to) || dist < best.get(e.to).dist) best.set(e.to, { dist, edges: best.get(cur).edges.concat(e) });
      }
    }
  }
  const reachable = (adj, a) => [...adj.keys()].filter((n) => shortest(adj, a, n));

  // 依 via 的順序把各段接成一條剖面
  function pathPoints(adj, via) {
    const out = [];
    let offset = 0;
    for (let i = 1; i < via.length; i++) {
      const edges = shortest(adj, via[i - 1], via[i]);
      if (!edges || !edges.length) return null;
      for (const e of edges) {
        e.points.forEach((p, j) => { if (j || !out.length) out.push([+(p[0] + offset).toFixed(3), p[1], p[2]]); });
        offset += e.dist;
      }
    }
    return out.length > 1 ? out : null;
  }

  const pathKey = (route, via) => keyOf(route.id, 'p:' + via.join('>'));

  // 一條路線可勾選的所有段落：原本的每一天，加上內建與自訂的起終點
  function segmentsOf(route) {
    const segs = route.days.map((day, i) => ({ key: keyOf(route.id, i), name: day.name, points: day.points, day }));
    const adj = graphOf(route), seen = new Set();
    const add = (path, custom) => {
      const key = pathKey(route, path.via), points = pathPoints(adj, path.via);
      if (!points || seen.has(key)) return;
      seen.add(key);
      segs.push({ key, name: path.name || path.via.join(' → '), points, path: custom ? path : null });
    };
    (route.paths || []).forEach((p) => add(p, false));
    (state.paths[route.id] || []).forEach((p) => add(p, true));
    return segs;
  }

  function buildSeries() {
    const series = [];
    allRoutes().forEach((route) => segmentsOf(route).forEach((day) => {
      const key = day.key;
      const sel = state.selected[key];
      if (!sel || day.points.length < 2) return;
      const total = day.points[day.points.length - 1][0];
      let from = Math.min(Math.max(+sel.from || 0, 0), total);
      let to = sel.to == null || sel.to === '' ? total : Math.min(Math.max(+sel.to, 0), total);
      if (!(to > from)) { from = 0; to = total; }
      const points = slice(day.points, from, to);
      series.push({ key, label: route.name + '｜' + day.name, total, from, to, points, stats: stats(points) });
    }));
    // 顏色在勾選時就固定下來，之後再加別的線也不會變；新線拿目前最少人用的顏色
    const used = COLORS.map(() => 0);
    series.forEach((s) => { const c = state.selected[s.key].color; if (c != null) used[c]++; });
    series.forEach((s) => {
      const sel = state.selected[s.key];
      if (sel.color == null) { sel.color = used.indexOf(Math.min(...used)); used[sel.color]++; save(); }
      s.color = COLORS[sel.color];
    });
    return series;
  }

  // ---------- 畫面 ----------

  function el(tag, props, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }
  const fmt = (n, digits = 0) => n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });

  function renderList() {
    const list = $('routeList');
    list.replaceChildren();
    allRoutes().forEach((route) => {
      const isUser = state.user.includes(route);
      const title = el('div', { className: 'route-title' }, el('span', { textContent: route.name }));
      if (route.approx) title.append(el('em', { className: 'badge', textContent: '概略', title: '以地標的里程與海拔連成，非實測軌跡' }));
      if (isUser) {
        title.append(
          el('button', { className: 'icon', title: '重新命名', textContent: '✎', onclick: () => rename(route) }),
          el('button', { className: 'icon', title: '刪除', textContent: '✕', onclick: () => removeRoute(route) })
        );
      }
      const box = el('div', { className: 'route' }, title);
      segmentsOf(route).forEach((seg) => {
        const key = seg.key;
        const check = el('input', { type: 'checkbox', checked: !!state.selected[key] });
        check.onchange = () => {
          if (check.checked) state.selected[key] = {}; else delete state.selected[key];
          save(); renderChart();
        };
        const s = stats(seg.points);
        const row = el('div', { className: 'day' },
          el('label', {}, check, el('span', { textContent: seg.name }),
            el('small', { textContent: fmt(s.dist, 1) + ' km ↑' + fmt(s.gain) }))
        );
        if (isUser && seg.day) row.append(el('button', { className: 'icon', title: '重新命名', textContent: '✎', onclick: () => rename(seg.day) }));
        if (seg.path) row.append(el('button', { className: 'icon', title: '刪除', textContent: '✕', onclick: () => removePath(route, seg) }));
        box.append(row);
      });
      if (builder && builder.routeId === route.id) box.append(renderBuilder(route));
      else if (graphOf(route).size > 1) box.append(el('button', { className: 'link', textContent: '＋ 自訂起終點', onclick: () => openBuilder(route) }));
      list.append(box);
    });
  }

  function openBuilder(route) {
    const adj = graphOf(route), start = adj.keys().next().value, reach = reachable(adj, start);
    builder = { routeId: route.id, via: [start, reach[reach.length - 1]] };
    renderList();
  }

  function renderBuilder(route) {
    const adj = graphOf(route), via = builder.via, reach = reachable(adj, via[0]);
    const box = el('div', { className: 'builder' });
    via.forEach((name, i) => {
      const last = i === via.length - 1;
      const select = el('select', {}, ...(i ? reach : [...adj.keys()]).map((n) => el('option', { value: n, textContent: n, selected: n === name })));
      select.onchange = () => {
        via[i] = select.value;
        if (!i) { // 換了起點，把走不到的站換掉
          const r = reachable(adj, via[0]);
          builder.via = via.map((n) => (r.includes(n) ? n : r[r.length - 1]));
        }
        renderList();
      };
      const row = el('div', { className: 'stop' }, el('span', { textContent: !i ? '起點' : last ? '終點' : '經過' }), select);
      if (i && !last) row.append(el('button', { className: 'icon', title: '移除', textContent: '✕', onclick: () => { via.splice(i, 1); renderList(); } }));
      box.append(row);
    });
    const points = pathPoints(adj, via), s = points && stats(points);
    const addStop = () => {
      const prev = via[via.length - 2], end = via[via.length - 1];
      via.splice(via.length - 1, 0, reach.find((n) => n !== prev && n !== end) || end);
      renderList();
    };
    box.append(
      el('div', { className: 'hint', textContent: s ? fmt(s.dist, 1) + ' km ↑' + fmt(s.gain) + ' ↓' + fmt(s.loss) : '相鄰的兩站不能相同' }),
      el('div', { className: 'builder-actions' },
        el('button', { className: 'btn', textContent: '＋ 經過點', onclick: addStop }),
        el('button', { className: 'btn primary', textContent: '加入', disabled: !points, onclick: () => addPath(route) }),
        el('button', { className: 'btn', textContent: '取消', onclick: () => { builder = null; renderList(); } }))
    );
    return box;
  }

  function addPath(route) {
    const via = builder.via.slice(), key = pathKey(route, via);
    const list = state.paths[route.id] || (state.paths[route.id] = []);
    if (!segmentsOf(route).some((seg) => seg.key === key)) list.push({ via });
    state.selected[key] = state.selected[key] || {};
    builder = null;
    save(); render();
  }

  function removePath(route, seg) {
    state.paths[route.id] = state.paths[route.id].filter((p) => p !== seg.path);
    delete state.selected[seg.key];
    save(); render();
  }

  function rename(item) {
    const name = prompt('名稱', item.name);
    if (name && name.trim()) { item.name = name.trim(); save(); render(); }
  }

  function removeRoute(route) {
    if (!confirm('刪除「' + route.name + '」？')) return;
    state.user = state.user.filter((r) => r !== route);
    Object.keys(state.selected).forEach((k) => { if (k.startsWith(route.id + '|')) delete state.selected[k]; });
    delete state.paths[route.id];
    save(); render();
  }

  function niceStep(span, target) {
    const raw = span / target, pow = 10 ** Math.floor(Math.log10(raw));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  function renderChart() {
    const series = buildSeries();
    const rel = state.yMode === 'rel';
    series.forEach((s) => {
      const base = rel ? s.points[0][1] : 0;
      s.plot = s.points.map(([x, y, name]) => [x, y - base, name]);
    });

    const chart = $('chart');
    chart.replaceChildren();
    $('empty').hidden = series.length > 0;
    $('tooltip').hidden = true;
    renderTable(series);
    plotted = null;
    if (!series.length) return;

    const W = chart.clientWidth || 800, H = chart.clientHeight || 420;
    const m = { l: 56, r: 16, t: 14, b: 38 };
    chart.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const xMax = Math.max(...series.map((s) => s.stats.dist));
    const ys = series.flatMap((s) => s.plot.map((p) => p[1]));
    const yStep = niceStep(Math.max(Math.max(...ys) - Math.min(...ys), 50), 6);
    const y0 = Math.floor(Math.min(...ys) / yStep) * yStep;
    const y1 = Math.ceil(Math.max(...ys) / yStep) * yStep || yStep;
    const xStep = niceStep(xMax, Math.max(4, Math.floor(W / 110)));

    const sx = (km) => m.l + km / xMax * (W - m.l - m.r);
    const sy = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);

    for (let v = y0; v <= y1 + 1e-9; v += yStep) {
      chart.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }));
      chart.append(svg('text', { x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end' }, fmt(v)));
    }
    for (let k = 0; k <= xMax + 1e-9; k += xStep) {
      chart.append(svg('line', { class: 'grid', x1: sx(k), x2: sx(k), y1: m.t, y2: H - m.b }));
      chart.append(svg('text', { x: sx(k), y: H - m.b + 16, 'text-anchor': 'middle' }, fmt(k, xStep < 1 ? 1 : 0)));
    }
    chart.append(svg('line', { class: 'axis', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
    chart.append(svg('text', { x: W - m.r, y: H - 6, 'text-anchor': 'end' }, '里程 (km)'));
    chart.append(svg('text', { x: 4, y: m.t + 2, 'dominant-baseline': 'hanging' }, rel ? '相對起點 (m)' : '海拔 (m)'));

    series.forEach((s) => {
      const d = s.plot.map(([x, y], i) => (i ? 'L' : 'M') + sx(x).toFixed(1) + ' ' + sy(y).toFixed(1)).join('');
      chart.append(svg('path', { class: 'series', d, stroke: s.color }));
      // 有名稱的點是地標，游標經過時會把名稱標在圖上
      s.plot.filter((p) => p[2]).forEach(([x, y]) => {
        chart.append(svg('circle', { class: 'mark', cx: sx(x), cy: sy(y), r: 3.5, stroke: s.color }));
      });
    });

    const cursor = svg('g', { visibility: 'hidden' });
    cursor.append(svg('line', { class: 'cursor', y1: m.t, y2: H - m.b }));
    series.forEach((s) => cursor.append(svg('circle', { r: 4, fill: s.color })));
    chart.append(cursor);
    const labels = svg('g', {});
    chart.append(labels);

    plotted = { series, sx, sy, xMax, m, W, cursor, labels, rel };
  }

  function onHover(ev) {
    if (!plotted) return;
    const { series, sx, sy, xMax, m, W, cursor, labels, rel } = plotted;
    const rect = $('chart').getBoundingClientRect();
    const px = (ev.clientX - rect.left) * W / rect.width;
    const km = Math.min(Math.max((px - m.l) / (W - m.l - m.r) * xMax, 0), xMax);

    const line = cursor.firstChild;
    line.setAttribute('x1', sx(km)); line.setAttribute('x2', sx(km));
    const tip = $('tooltip');
    tip.replaceChildren(el('b', { textContent: fmt(km, 2) + ' km' }));
    series.forEach((s, i) => {
      const dot = cursor.children[i + 1];
      const inRange = km <= s.stats.dist;
      dot.setAttribute('visibility', inRange ? 'inherit' : 'hidden');
      if (!inRange) return;
      const v = interp(s.plot, km);
      dot.setAttribute('cx', sx(km)); dot.setAttribute('cy', sy(v));
      const sw = el('span', { className: 'sw' });
      sw.style.background = s.color;
      tip.append(el('div', {}, sw, s.label + '：' + (rel && v > 0 ? '+' : '') + fmt(v) + ' m'));
    });
    cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    const x = sx(km) * rect.width / W;
    const tipOnRight = x + tip.offsetWidth + 16 <= rect.width;
    tip.style.left = (tipOnRight ? x + 12 : x - tip.offsetWidth - 12) + 'px';

    // 游標靠近地標（左右 10px 內）時標出名稱；放在提示框的另一側，並上下錯開避免重疊
    labels.replaceChildren();
    const found = [];
    series.forEach((s) => {
      const near = s.plot.filter((p) => p[2] && Math.abs(sx(p[0]) - sx(km)) <= 10)
        .sort((p, q) => Math.abs(p[0] - km) - Math.abs(q[0] - km))[0];
      if (near) found.push({ x: sx(near[0]), y: sy(near[1]) + 4, name: near[2] });
    });
    found.sort((p, q) => p.y - q.y).forEach((f, i) => {
      if (i && f.y < found[i - 1].y + 17) f.y = found[i - 1].y + 17;
      const width = f.name.length * 13 + 8;
      let lx = tipOnRight ? f.x - 9 : f.x + 9, anchor = tipOnRight ? 'end' : 'start', dy = 0;
      if (tipOnRight && lx - width < 0) { lx = 2; anchor = 'start'; dy = -16; }
      if (!tipOnRight && lx + width > W) { lx = W - 2; anchor = 'end'; dy = -16; }
      labels.append(svg('text', { class: 'label', x: lx, y: f.y + dy, 'text-anchor': anchor }, f.name));
    });
  }

  function hideCursor() {
    if (plotted) { plotted.cursor.setAttribute('visibility', 'hidden'); plotted.labels.replaceChildren(); }
    $('tooltip').hidden = true;
  }

  function renderTable(series) {
    const body = $('stats').tBodies[0];
    body.replaceChildren();
    series.forEach((s) => {
      const sw = el('span', { className: 'sw' });
      sw.style.background = s.color;
      const range = (field, value) => {
        const input = el('input', { type: 'number', min: 0, max: +s.total.toFixed(2), step: 0.1, value: +value.toFixed(2) });
        input.onchange = () => { state.selected[s.key][field] = input.value; save(); renderChart(); };
        return el('td', {}, input);
      };
      const st = s.stats;
      body.append(el('tr', {},
        el('td', {}, sw, s.label),
        range('from', s.from), range('to', s.to),
        el('td', { textContent: fmt(st.dist, 2) + ' km' }),
        el('td', { textContent: '+' + fmt(st.gain) + ' m' }),
        el('td', { textContent: '−' + fmt(st.loss) + ' m' }),
        el('td', { textContent: fmt(st.min) + ' m' }),
        el('td', { textContent: fmt(st.max) + ' m' }),
        el('td', { textContent: st.dist ? fmt(st.gain / st.dist) + ' m' : '–' })
      ));
    });
  }

  function render() { renderList(); renderChart(); }

  // ---------- 事件 ----------

  $('gpxInput').onchange = (e) => { importFiles(Array.from(e.target.files)); e.target.value = ''; };

  $('yMode').onclick = (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    state.yMode = mode;
    save(); syncMode(); renderChart();
  };
  function syncMode() {
    for (const b of $('yMode').children) b.classList.toggle('on', b.dataset.mode === state.yMode);
  }

  $('exportBtn').onclick = () => {
    const routes = allRoutes().map((r) => {
      const paths = (r.paths || []).concat(state.paths[r.id] || []);
      return paths.length ? { ...r, paths } : r;
    });
    const js = '// 網站內建路線。points 為 [累積里程 km, 海拔 m, 地標名稱(可省略)]。\nwindow.BUNDLED_ROUTES = ' + JSON.stringify(routes) + ';\n';
    const a = el('a', { href: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })), download: 'routes.js' });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('chart').addEventListener('pointermove', onHover);
  $('chart').addEventListener('pointerleave', hideCursor);
  window.addEventListener('resize', renderChart);

  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropMask').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropMask').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('dropMask').hidden = true;
    importFiles(Array.from(e.dataTransfer.files).filter((f) => /\.gpx$/i.test(f.name)));
  });

  // 第一次開啟時，預設勾選示範的兩段方便看到效果
  if (!saved.selected) {
    state.selected[keyOf('jiemaosi', 1)] = {};
    state.selected[keyOf('youluo', 0)] = {};
    state.selected[keyOf('xueshan', 0)] = {};
  }
  syncMode();
  render();
})();
