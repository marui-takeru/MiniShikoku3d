// Mini Shikoku 3D — 松山を中心とした四国の鉄道 3D 可視化
(function () {
  'use strict';

  const { Simulator, offset, bearing, formatTime, parseTime } = window.Sim;
  const NET = window.NETWORK;
  const sim = new Simulator(NET);

  // ---------------------------------------------------------------- 設定
  const STYLES = {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };
  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  // ベースマップが読めないときの予備: 国土地理院 淡色地図
  const FALLBACK_STYLE = {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      gsi: {
        type: 'raster', tileSize: 256, maxzoom: 18,
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe3e6' } },
      { id: 'gsi', type: 'raster', source: 'gsi' },
    ],
  };

  const VIEWS = {
    matsuyama: { center: [132.7655, 33.8425], zoom: 14.6, pitch: 60, bearing: -25 },
    dogo: { center: [132.7835, 33.8490], zoom: 16.3, pitch: 65, bearing: 30 },
    matsuyama_wide: { center: [132.785, 33.828], zoom: 11.8, pitch: 50, bearing: -10 },
    takamatsu: { center: [134.046, 34.338], zoom: 13.2, pitch: 55, bearing: 0 },
    kochi: { center: [133.535, 33.562], zoom: 13.4, pitch: 55, bearing: 0 },
    tokushima: { center: [134.551, 34.074], zoom: 13.2, pitch: 55, bearing: 0 },
    shikoku: { center: [133.45, 33.72], zoom: 7.7, pitch: 35, bearing: 0 },
  };

  // ---------------------------------------------------------------- 状態
  const params = new URLSearchParams(location.search);
  const state = {
    theme: params.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    buildings: true,
    terrain: params.has('terrain'),
    groups: Object.fromEntries(NET.groups.map(g => [g.id, true])),
    selected: null,
    follow: false,
    clock: { base: jstNow(), realBase: performance.now(), speed: 1, paused: false },
  };
  if (params.get('t')) state.clock.base = parseTime(params.get('t'));
  if (params.get('speed')) state.clock.speed = Number(params.get('speed')) || 1;

  function jstNow() {
    const now = Date.now() / 1000 + 9 * 3600;
    return ((now % 86400) + 86400) % 86400;
  }

  function simTime() {
    const c = state.clock;
    if (c.paused) return c.base;
    return c.base + (performance.now() - c.realBase) / 1000 * c.speed;
  }

  function setClock(base, speed, paused) {
    const c = state.clock;
    c.base = ((base % 86400) + 86400) % 86400;
    c.realBase = performance.now();
    if (speed !== undefined) c.speed = speed;
    if (paused !== undefined) c.paused = paused;
    renderClockControls();
  }

  // ---------------------------------------------------------------- 地図
  const initView = VIEWS[params.get('view')] || VIEWS.matsuyama;
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe3e6' } }] },
    ...initView,
    maxPitch: 85,
    hash: true,
    attributionControl: false,
    antialias: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '駅座標: <a href="https://ekidata.jp/" target="_blank">駅データ.jp</a> | 列車位置はダイヤパターンによる推計',
  }), 'bottom-right');

  async function loadStyle() {
    const url = STYLES[state.theme];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const style = await res.json();
      map.setStyle(style, { diff: false });
    } catch (e) {
      console.warn('base map unavailable, using fallback', e);
      map.setStyle(FALLBACK_STYLE, { diff: false });
    }
  }

  map.on('style.load', addOverlays);
  loadStyle();

  function firstSymbolLayer() {
    const layer = map.getStyle().layers.find(l => l.type === 'symbol');
    return layer && layer.id;
  }

  function addOverlays() {
    const style = map.getStyle();
    const dark = state.theme === 'dark';
    const beforeLabels = firstSymbolLayer();

    // 3D 建物: スタイルに無ければ OpenMapTiles の building レイヤーから作る
    const hasExtrusion = style.layers.some(l => l.type === 'fill-extrusion');
    if (!hasExtrusion && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'mm3d-buildings', type: 'fill-extrusion', source: 'openmaptiles',
        'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': dark ? '#2b3340' : '#d9d4cc',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.8,
        },
      }, beforeLabels);
    }
    applyBuildingVisibility();

    map.addSource('terrain', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    applyTerrain();

    // 線路
    map.addSource('tracks', { type: 'geojson', data: tracksGeoJSON() });
    map.addLayer({
      id: 'tracks-casing', type: 'line', source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#000' : '#fff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 4, 16, 9],
        'line-opacity': 0.7,
      },
    });
    map.addLayer({
      id: 'tracks', type: 'line', source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.2, 12, 2.5, 16, 5],
      },
    });

    // 駅 (JR・郊外線は広域から、路面電車は拡大時のみ表示)
    map.addSource('stations', { type: 'geojson', data: stationsGeoJSON() });
    for (const kind of ['rail', 'tram']) {
      map.addLayer({
        id: `stations-${kind}`, type: 'circle', source: 'stations',
        minzoom: kind === 'rail' ? 0 : 12.5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3, 16, 6],
          'circle-color': dark ? '#1b1f27' : '#ffffff',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 2.5],
        },
      });
    }
    for (const kind of ['rail', 'tram']) {
      map.addLayer({
        id: `labels-${kind}`, type: 'symbol', source: 'stations',
        minzoom: kind === 'rail' ? 11 : 14.5,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': dark ? '#e8ecf1' : '#1d2733',
          'text-halo-color': dark ? '#0b0e13' : '#ffffff',
          'text-halo-width': 1.4,
        },
      });
    }

    // 列車
    map.addSource('train-glow', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'train-glow', type: 'circle', source: 'train-glow',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 16, 40],
        'circle-color': '#ffeb3b',
        'circle-opacity': 0.35,
        'circle-blur': 0.8,
        'circle-pitch-alignment': 'map',
      },
    });
    map.addSource('trains', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'trains', type: 'fill-extrusion', source: 'trains',
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    applyGroupFilter();
    lastSunMinute = -1;
  }

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  function tracksGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: NET.lines.map(l => ({
        type: 'Feature',
        properties: { id: l.id, name: l.name, color: l.color, group: l.group, kind: l.kind },
        geometry: { type: 'LineString', coordinates: l.stations.map(s => s[1]) },
      })),
    };
  }

  function stationsGeoJSON() {
    const seen = new Map();
    for (const l of NET.lines) {
      for (const [name, c] of l.stations) {
        const key = name + c.map(x => x.toFixed(3)).join();
        if (seen.has(key)) {
          seen.get(key).properties.groups += `${l.group},`;
          continue;
        }
        seen.set(key, {
          type: 'Feature',
          properties: { name, color: l.color, kind: l.kind, groups: `,${l.group},` },
          geometry: { type: 'Point', coordinates: c },
        });
      }
    }
    return { type: 'FeatureCollection', features: [...seen.values()] };
  }

  function applyGroupFilter() {
    if (!map.getLayer('tracks')) return;
    const on = Object.keys(state.groups).filter(g => state.groups[g]);
    // 特急は JR の線路を走るので、JR 普通を消しても特急が見えていれば線路は残す
    const lineGroups = new Set(on);
    if (state.groups.jr_ltd) lineGroups.add('jr');
    const f = ['in', ['get', 'group'], ['literal', [...lineGroups]]];
    map.setFilter('tracks', f);
    map.setFilter('tracks-casing', f);
    const inGroups = ['any', ...[...lineGroups].map(g => ['in', `,${g},`, ['get', 'groups']])];
    for (const kind of ['rail', 'tram']) {
      const sf = ['all', ['==', ['get', 'kind'], kind], inGroups];
      map.setFilter(`stations-${kind}`, sf);
      map.setFilter(`labels-${kind}`, sf);
    }
  }

  function applyBuildingVisibility() {
    for (const l of map.getStyle().layers) {
      if (l.type === 'fill-extrusion' && l.id !== 'trains') {
        map.setLayoutProperty(l.id, 'visibility', state.buildings ? 'visible' : 'none');
      }
    }
  }

  function applyTerrain() {
    map.setTerrain(state.terrain ? { source: 'terrain', exaggeration: 1.4 } : null);
  }

  // ---------------------------------------------------------------- 太陽と空
  // シミュレーション時刻の太陽の位置 (松山付近) から光の向き・色・空の色を決める
  const SUN_LAT = 33.84, SUN_LON = 132.77;

  function sunPosition(sec) {
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const day = Math.floor((now.getTime() - start) / 86400000);
    const rad = Math.PI / 180;
    const decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365) * rad;
    const B = 2 * Math.PI * (day - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 均時差 [分]
    const solarMin = sec / 60 + 4 * (SUN_LON - 135) + eot;
    const hour = (solarMin / 4 - 180) * rad;
    const lat = SUN_LAT * rad;
    const elev = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour));
    const az = Math.atan2(Math.sin(hour), Math.cos(hour) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
    return { elevation: elev / rad, azimuth: az / rad };
  }

  function mix(a, b, f) {
    const pa = a.match(/\w\w/g).map(x => parseInt(x, 16));
    const pb = b.match(/\w\w/g).map(x => parseInt(x, 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * f).toString(16).padStart(2, '0')).join('');
  }

  let lastSunMinute = -1;
  function updateSun(sec, force) {
    const minute = Math.floor(sec / 60);
    if (!force && minute === lastSunMinute) return;
    lastSunMinute = minute;
    const { elevation, azimuth } = sunPosition(sec);
    // day: 太陽高度 6° 以上で 1、-6° (市民薄明の終わり) 以下で 0
    const day = Math.min(1, Math.max(0, (elevation + 6) / 12));
    const low = Math.max(0, 1 - Math.abs(elevation) / 12); // 朝夕の赤み
    const color = mix(mix('#b4c2ff', '#ffffff', day), '#ffb070', low * day);
    map.setLight({
      anchor: 'map',
      position: [1.5, azimuth, Math.min(88, Math.max(10, 90 - Math.max(elevation, 0)))],
      color,
      intensity: 0.32 + 0.18 * day,
    });
    if (typeof map.setSky === 'function') {
      map.setSky({
        'sky-color': mix('#0b1026', '#6fa8e8', day),
        'horizon-color': mix(mix('#1b2448', '#dce9f5', day), '#ffb27a', low * 0.8),
        'fog-color': mix('#0e1424', '#e6edf3', day),
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.5,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
      });
    }
  }

  // ---------------------------------------------------------------- 列車の描画
  function sizeScale() {
    // 引いた視点でも列車が見えるよう、縮尺に応じて誇張する
    return Math.min(120, Math.max(2, Math.pow(2, 16.6 - map.getZoom())));
  }

  const WINDOW_COLOR = '#22303c';
  const ROOF_COLOR = '#9aa3ab';

  function trainFeatures(trains, scale) {
    const features = [];
    for (const tr of trains) {
      const sv = tr.service;
      const L = sv.carLength * scale;
      const W = sv.width * scale;
      const gap = 0.8 * scale;
      // 日本の鉄道は左側通行: 進行方向左へずらして複線を表現
      const lateral = (sv.kind === 'tram' ? 1.6 : 2.0) * scale;
      const h = sv.height * scale;
      const base = 0.4 * scale;
      // 始発駅では編成全体がホームに収まるよう、先頭を 1 編成分だけ前に置く
      const trainLen = Math.min(sv.cars * (L + gap) - gap, tr.pattern.length);
      const head = Math.max(tr.dist, trainLen);
      for (let k = 0; k < sv.cars; k++) {
        const dFront = head - k * (L + gap);
        if (dFront <= 0) break;
        const f = tr.pattern.pointAt(dFront);
        const b = tr.pattern.pointAt(Math.max(0, dFront - L));
        const brg = bearing(b.c, f.c) || f.brg;
        const left = brg - Math.PI / 2;
        const fc = offset(f.c, left, lateral);
        const bc = offset(b.c, left, lateral);
        const ring = [
          offset(fc, left, W / 2), offset(fc, left + Math.PI, W / 2),
          offset(bc, left + Math.PI, W / 2), offset(bc, left, W / 2),
        ];
        // 先頭車は少し先細りにして進行方向を分かりやすくする
        if (k === 0) {
          const nose = offset(fc, brg, Math.min(L * 0.15, 3 * scale));
          ring.splice(1, 0, nose);
        }
        ring.push(ring[0]);
        const geometry = { type: 'Polygon', coordinates: [ring] };
        // 車体・窓・屋根を積み重ねて電車らしく見せる
        for (const [from, to, color] of [
          [0, 0.5, sv.color], [0.5, 0.78, WINDOW_COLOR], [0.78, 0.92, sv.color], [0.92, 1, ROOF_COLOR],
        ]) {
          features.push({
            type: 'Feature',
            properties: { id: tr.id, color, b: base + h * from, h: base + h * to },
            geometry,
          });
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  let lastTrains = [];
  let lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastFrame < 33) return; // 約 30fps
    lastFrame = now;
    const t = simTime();
    document.getElementById('clock').textContent = formatTime(t);
    if (!map.getSource('trains')) return;
    updateSun(((t % 86400) + 86400) % 86400);
    const trains = sim.trainsAt(((t % 86400) + 86400) % 86400, sv => state.groups[sv.group]);
    lastTrains = trains;
    map.getSource('trains').setData(trainFeatures(trains, sizeScale()));
    document.getElementById('train-count').textContent = String(trains.length);
    updateSelection(trains, t);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- 列車の選択
  map.on('click', 'trains', e => {
    const id = e.features[0].properties.id;
    state.selected = id;
    state.follow = false;
    e.preventDefault();
    renderInfo();
  });
  map.on('click', e => {
    if (e.defaultPrevented) return;
    const hits = map.getLayer('trains') ? map.queryRenderedFeatures(e.point, { layers: ['trains'] }) : [];
    if (!hits.length) {
      state.selected = null;
      state.follow = false;
      renderInfo();
    }
  });
  map.on('mouseenter', 'trains', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'trains', () => { map.getCanvas().style.cursor = ''; });
  map.on('dragstart', () => { if (state.follow) { state.follow = false; renderInfo(); } });

  function updateSelection(trains, t) {
    const glow = map.getSource('train-glow');
    const tr = state.selected && trains.find(x => x.id === state.selected);
    if (!tr) {
      glow.setData(empty());
      if (state.selected) {
        document.getElementById('info-status').textContent = '運行を終了しました';
      }
      return;
    }
    const p = tr.pattern.pointAt(tr.dist);
    glow.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p.c } });
    if (state.follow) map.jumpTo({ center: p.c });
    const path = tr.pattern.path;
    let status;
    if (tr.waiting) {
      status = `${path[0][0]} で発車待ち（${formatTime(tr.dep).slice(0, 5)} 発）`;
    } else if (tr.stopped && tr.at === path.length - 1) {
      status = `${path[tr.at][0]} に到着`;
    } else if (tr.stopped) {
      const seg = tr.pattern.segs[tr.seg];
      status = `${path[tr.at][0]} に停車中（${formatTime(tr.dep + seg.t0).slice(0, 5)} 発）`;
    } else {
      const seg = tr.pattern.segs[tr.seg];
      status = `次は ${path[tr.next][0]}（${formatTime(tr.dep + seg.t1).slice(0, 5)} 着予定）`;
    }
    document.getElementById('info-status').textContent = status;
  }

  function renderInfo() {
    const box = document.getElementById('info');
    const tr = state.selected && lastTrains.find(x => x.id === state.selected);
    if (!state.selected || !tr) {
      box.hidden = true;
      return;
    }
    const sv = tr.service;
    const p = tr.pattern;
    const dest = sv.loop ? '' : `${p.destination} 行`;
    const origin = p.path[0][0];
    document.getElementById('info-swatch').style.background = sv.color;
    document.getElementById('info-name').textContent = sv.name;
    document.getElementById('info-dest').textContent = dest;
    document.getElementById('info-detail').textContent =
      `${origin} ${formatTime(tr.dep).slice(0, 5)} 発 · ${sv.cars}両` + (sv.note ? ` · ${sv.note}` : '');
    const followBtn = document.getElementById('info-follow');
    followBtn.textContent = state.follow ? '追跡をやめる' : 'この列車を追跡';
    followBtn.setAttribute('aria-pressed', String(state.follow));
    box.hidden = false;
  }

  document.getElementById('info-follow').addEventListener('click', () => {
    state.follow = !state.follow;
    if (state.follow) {
      const tr = lastTrains.find(x => x.id === state.selected);
      if (tr) {
        map.easeTo({ center: tr.pattern.pointAt(tr.dist).c, zoom: Math.max(map.getZoom(), 15.5), pitch: 60, duration: 800 });
      }
    }
    renderInfo();
  });
  document.getElementById('info-close').addEventListener('click', () => {
    state.selected = null;
    state.follow = false;
    renderInfo();
  });

  // ---------------------------------------------------------------- 操作パネル
  const SPEEDS = [1, 10, 60, 300];

  function renderClockControls() {
    document.querySelectorAll('[data-speed]').forEach(b => {
      b.setAttribute('aria-pressed', String(!state.clock.paused && Number(b.dataset.speed) === state.clock.speed));
    });
    document.getElementById('pause').setAttribute('aria-pressed', String(state.clock.paused));
    document.getElementById('pause').textContent = state.clock.paused ? '▶' : '❚❚';
  }

  const speedBox = document.getElementById('speeds');
  for (const s of SPEEDS) {
    const b = document.createElement('button');
    b.dataset.speed = s;
    b.textContent = s === 1 ? '実時間' : `×${s}`;
    b.addEventListener('click', () => setClock(simTime(), s, false));
    speedBox.appendChild(b);
  }
  document.getElementById('pause').addEventListener('click', () => {
    setClock(simTime(), state.clock.speed, !state.clock.paused);
  });
  document.getElementById('now').addEventListener('click', () => setClock(jstNow(), 1, false));
  document.getElementById('jump').addEventListener('change', e => {
    if (e.target.value) setClock(parseTime(e.target.value), state.clock.speed);
  });
  renderClockControls();

  const legend = document.getElementById('legend');
  for (const g of NET.groups) {
    const services = NET.services.filter(s => s.group === g.id);
    const colors = [...new Set(services.map(s => s.color))].slice(0, 6);
    const label = document.createElement('label');
    label.className = 'legend-item';
    label.innerHTML = `<input type="checkbox" checked>
      <span class="legend-swatches">${colors.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      <span>${g.name}</span>`;
    label.querySelector('input').addEventListener('change', e => {
      state.groups[g.id] = e.target.checked;
      applyGroupFilter();
    });
    legend.appendChild(label);
  }

  document.querySelectorAll('[data-view]').forEach(b => {
    b.addEventListener('click', () => {
      state.follow = false;
      map.flyTo({ ...VIEWS[b.dataset.view], duration: 2500, essential: true });
    });
  });

  const themeBtn = document.getElementById('theme');
  const buildingsBtn = document.getElementById('buildings');
  const terrainBtn = document.getElementById('terrain');
  function renderToggles() {
    document.documentElement.dataset.theme = state.theme;
    themeBtn.textContent = state.theme === 'dark' ? '☾ ダーク' : '☀ ライト';
    buildingsBtn.setAttribute('aria-pressed', String(state.buildings));
    terrainBtn.setAttribute('aria-pressed', String(state.terrain));
  }
  themeBtn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    renderToggles();
    loadStyle();
  });
  buildingsBtn.addEventListener('click', () => {
    state.buildings = !state.buildings;
    renderToggles();
    applyBuildingVisibility();
  });
  terrainBtn.addEventListener('click', () => {
    state.terrain = !state.terrain;
    renderToggles();
    applyTerrain();
    if (state.terrain && map.getPitch() < 50) map.easeTo({ pitch: 60 });
  });
  renderToggles();

  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('collapsed');
  });

  // デバッグ・テスト用
  window.mm3d = { map, sim, state, setClock, simTime };
})();
