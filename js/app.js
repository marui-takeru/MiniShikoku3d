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
    // auto: 太陽の高さに合わせて昼はライト、夜はダークの地図に切り替える
    themeMode: ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : 'auto',
    theme: 'light',
    buildings: true,
    terrain: params.has('terrain'),
    groups: Object.fromEntries(NET.groups.map(g => [g.id, true])),
    selected: null,
    station: null,
    reach: null,
    night: 0,
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

  function fallbackStyle(theme) {
    const style = JSON.parse(JSON.stringify(FALLBACK_STYLE));
    if (theme === 'dark') {
      style.layers[0].paint['background-color'] = '#10141b';
      // 淡色地図の明るさを反転気味に落として夜の地図にする
      style.layers[1].paint = { 'raster-brightness-min': 0.32, 'raster-brightness-max': 0, 'raster-saturation': -0.6, 'raster-contrast': 0.1 };
    }
    return style;
  }

  async function loadStyle() {
    const url = STYLES[state.theme];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const style = await res.json();
      map.setStyle(style, { diff: false });
    } catch (e) {
      console.warn('base map unavailable, using fallback', e);
      map.setStyle(fallbackStyle(state.theme), { diff: false });
    }
  }

  map.on('style.load', addOverlays);
  state.theme = resolveTheme(state.clock.base);
  loadStyle();

  function resolveTheme(sec) {
    if (state.themeMode !== 'auto') return state.themeMode;
    return sunPosition(sec).elevation < -4 ? 'dark' : 'light';
  }

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

    // 到達圏
    map.addSource('reach', { type: 'geojson', data: reachGeoJSON() });
    map.addLayer({
      id: 'reach', type: 'circle', source: 'reach',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['get', 'origin'], 7, 4], 14, ['case', ['get', 'origin'], 14, 9]],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': dark ? '#10141b' : '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'reach-labels', type: 'symbol', source: 'reach', minzoom: 10.5,
      layout: {
        'text-field': ['case', ['get', 'origin'], ['concat', ['get', 'name'], ' 出発'], ['concat', ['get', 'name'], ' ', ['get', 'label']]],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, -1.3],
        'text-anchor': 'bottom',
        'text-optional': true,
      },
      paint: {
        'text-color': dark ? '#e8ecf1' : '#1d2733',
        'text-halo-color': dark ? '#0b0e13' : '#ffffff',
        'text-halo-width': 1.6,
      },
    });
    applyReachMode();

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
    map.addSource('train-lights', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'train-lights', type: 'circle', source: 'train-lights',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 3.5, 17, 7],
        'circle-color': ['get', 'color'],
        'circle-blur': 0.7,
        'circle-opacity': 0,
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
        geometry: { type: 'LineString', coordinates: l.shape || l.stations.map(s => s[1]) },
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
  function sunPosition(sec) {
    const SUN_LAT = 33.84, SUN_LON = 132.77;
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
    state.night = 1 - day;
    const theme = resolveTheme(sec);
    if (theme !== state.theme) {
      state.theme = theme;
      renderToggles();
      loadStyle();
      return;
    }
    if (map.getLayer('train-lights')) map.setPaintProperty('train-lights', 'circle-opacity', 0.95 * state.night);
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

  function trainFeatures(trains, scale) {
    const features = [];
    const lights = [];
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
        // 夜間の前照灯 (先頭) と尾灯 (最後尾)
        if (k === 0) lights.push(light(offset(fc, brg, Math.min(L * 0.15, 3 * scale)), '#fff6d8'));
        if (k === sv.cars - 1 || head - (k + 1) * (L + gap) <= 0) lights.push(light(bc, '#ff3b30'));
        const geometry = { type: 'Polygon', coordinates: [ring] };
        // 車体・窓の帯・上部車体を積み重ねて電車らしく見せる (上から見ても路線色が分かるよう屋根も路線色)
        for (const [from, to, color] of [
          [0, 0.5, sv.color], [0.5, 0.78, WINDOW_COLOR], [0.78, 1, sv.color],
        ]) {
          features.push({
            type: 'Feature',
            properties: { id: tr.id, color, b: base + h * from, h: base + h * to },
            geometry,
          });
        }
      }
    }
    return { trains: { type: 'FeatureCollection', features }, lights: { type: 'FeatureCollection', features: lights } };
  }

  function light(c, color) {
    return { type: 'Feature', properties: { color }, geometry: { type: 'Point', coordinates: c } };
  }

  let lastTrains = [];
  let lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastFrame < 33) return; // 約 30fps
    lastFrame = now;
    const t = simTime();
    document.getElementById('clock').textContent = formatTime(t);
    document.getElementById('cinema-clock').textContent = formatTime(t).slice(0, 5);
    if (!map.getSource('trains')) return;
    updateSun(((t % 86400) + 86400) % 86400);
    const trains = sim.trainsAt(((t % 86400) + 86400) % 86400, sv => state.groups[sv.group]);
    lastTrains = trains;
    const drawn = trainFeatures(trains, sizeScale());
    map.getSource('trains').setData(drawn.trains);
    map.getSource('train-lights').setData(state.night > 0.05 ? drawn.lights : empty());
    document.getElementById('train-count').textContent = String(trains.length);
    updateSelection(trains, t);
    if (now - lastBoard > 1000) {
      lastBoard = now;
      if (state.station) renderStation();
      renderChartNow();
    }
  }
  let lastBoard = 0;
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- 列車の選択
  map.on('click', 'trains', e => {
    const id = e.features[0].properties.id;
    state.selected = id;
    state.follow = false;
    state.station = null;
    e.preventDefault();
    renderInfo();
    renderStation();
  });
  for (const layer of ['stations-rail', 'stations-tram']) {
    map.on('click', layer, e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const f = e.features[0];
      openStation(f.properties.name, f.geometry.coordinates);
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', e => {
    if (e.defaultPrevented) return;
    state.selected = null;
    state.follow = false;
    state.station = null;
    renderInfo();
    renderStation();
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
        document.getElementById('info-stops').replaceChildren();
        lastUpcomingKey = '';
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
      status = `${path[tr.at][0]} に到着しました`;
    } else if (tr.stopped) {
      const seg = tr.segs[tr.seg];
      status = `${path[tr.at][0]} に停車中（${formatTime(tr.dep + seg.t0).slice(0, 5)} 発）`;
    } else {
      const seg = tr.segs[tr.seg];
      status = `次は ${path[tr.next][0]}（${formatTime(tr.dep + seg.t1).slice(0, 5)} 着予定）`;
    }
    document.getElementById('info-status').textContent = status;
    renderUpcoming(tr);
  }

  // 選択中の列車のこの先の停車駅と到着予定 (最大 6 駅 + 終着駅)
  let lastUpcomingKey = '';
  function renderUpcoming(tr) {
    const p = tr.pattern;
    const rows = tr.segs
      .filter(sg => sg.t1 > tr.elapsed)
      .map(sg => [p.path[sg.to][0], formatTime(tr.dep + sg.t1).slice(0, 5)]);
    const shown = rows.length > 7 ? [...rows.slice(0, 6), null, rows[rows.length - 1]] : rows;
    const key = tr.id + shown.map(r => (r ? r[0] : '…')).join();
    if (key === lastUpcomingKey) return;
    lastUpcomingKey = key;
    const list = document.getElementById('info-stops');
    list.replaceChildren(...shown.map(r => {
      const li = document.createElement('li');
      if (!r) {
        li.className = 'more';
        li.textContent = `… ほか ${rows.length - 7} 駅`;
        return li;
      }
      li.innerHTML = '<span class="stop-time"></span><span class="stop-name"></span>';
      li.querySelector('.stop-time').textContent = r[1];
      li.querySelector('.stop-name').textContent = r[0];
      return li;
    }));
    list.style.setProperty('--route', tr.service.color);
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

  // ---------------------------------------------------------------- 到達圏
  // 所要時間の段階と色 (青の単色ランプ。近いほど濃い。ライト/ダークで別の段を使う)
  const REACH_BANDS = [10, 20, 30, 45, 60];
  const REACH_COLORS = {
    light: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#86b6ef'],
    dark: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf'],
  };

  function reachColor(minutes) {
    const i = REACH_BANDS.findIndex(b => minutes <= b);
    return REACH_COLORS[state.theme][i < 0 ? REACH_BANDS.length - 1 : i];
  }

  function reachGeoJSON() {
    if (!state.reach) return empty();
    return {
      type: 'FeatureCollection',
      features: state.reach.results.map(r => ({
        type: 'Feature',
        properties: {
          name: r.name,
          origin: r.minutes === 0,
          label: `${Math.round(r.minutes)}分`,
          color: r.minutes === 0 ? (state.theme === 'dark' ? '#ffffff' : '#000000') : reachColor(r.minutes),
        },
        geometry: { type: 'Point', coordinates: r.c },
      })),
    };
  }

  function showReach(name, c) {
    const t0 = ((simTime() % 86400) + 86400) % 86400;
    const results = sim.reachFrom(name, c, t0, { maxMinutes: 60, isVisible: sv => state.groups[sv.group] });
    state.reach = { name, c, t0, results };
    applyReachMode();
    // スマートフォンでは凡例と発車案内が重なるので発車案内を閉じる
    if (matchMedia('(max-width: 640px)').matches) {
      state.station = null;
      renderStation();
    }
    // 到達できた範囲が収まるようにカメラを合わせる
    const b = new maplibregl.LngLatBounds();
    results.forEach(r => b.extend(r.c));
    map.fitBounds(b, { padding: { top: 80, bottom: 80, left: 340, right: 320 }, maxZoom: 14.5, pitch: 40, duration: 1500 });
  }

  function clearReach() {
    state.reach = null;
    applyReachMode();
  }

  function applyReachMode() {
    const on = !!state.reach;
    if (map.getSource('reach')) map.getSource('reach').setData(reachGeoJSON());
    // 到達圏の表示中は線路と駅を控えめにする
    if (map.getLayer('tracks')) {
      map.setPaintProperty('tracks', 'line-opacity', on ? 0.3 : 1);
      map.setPaintProperty('tracks-casing', 'line-opacity', on ? 0.2 : 0.7);
      for (const k of ['rail', 'tram']) {
        map.setPaintProperty(`stations-${k}`, 'circle-opacity', on ? 0.25 : 1);
        map.setPaintProperty(`stations-${k}`, 'circle-stroke-opacity', on ? 0.25 : 1);
        map.setLayoutProperty(`labels-${k}`, 'visibility', on ? 'none' : 'visible');
      }
    }
    if (map.getLayer('trains')) map.setPaintProperty('trains', 'fill-extrusion-opacity', on ? 0.25 : 0.95);
    renderReachLegend();
  }

  function renderReachLegend() {
    const box = document.getElementById('reach-legend');
    if (!state.reach) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const r = state.reach;
    document.getElementById('reach-title').textContent =
      `${r.name} を ${formatTime(r.t0).slice(0, 5)} に出発して 60 分で行ける駅`;
    const counts = REACH_BANDS.map((b, i) =>
      r.results.filter(x => x.minutes > 0 && x.minutes <= b && (i === 0 || x.minutes > REACH_BANDS[i - 1])).length);
    const list = document.getElementById('reach-bands');
    list.replaceChildren(...REACH_BANDS.map((b, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<i></i><span>${i === 0 ? 0 : REACH_BANDS[i - 1]}〜${b}分</span><span class="reach-count">${counts[i]}駅</span>`;
      li.querySelector('i').style.background = REACH_COLORS[state.theme][i];
      return li;
    }));
    document.getElementById('reach-total').textContent = `合計 ${r.results.length - 1} 駅`;
  }

  document.getElementById('reach-clear').addEventListener('click', clearReach);
  document.getElementById('station-reach').addEventListener('click', () => {
    if (state.station) showReach(state.station.name, state.station.c);
  });

  // ---------------------------------------------------------------- 駅の発車案内
  function shortName(sv) {
    const m = sv.name.match(/^(\d+系統)/);
    return m ? m[1] : sv.name;
  }

  function destinationOf(p) {
    return p.service.loop ? p.service.name.replace(/^\d+系統\s*/, '') : `${p.destination} 行`;
  }

  function openStation(name, c) {
    state.station = { name, c };
    state.selected = null;
    state.follow = false;
    renderInfo();
    renderStation();
  }

  function renderStation() {
    const box = document.getElementById('station');
    if (!state.station) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    document.getElementById('station-name').textContent = state.station.name;
    const t = ((simTime() % 86400) + 86400) % 86400;
    const deps = sim.departuresAt(state.station.name, state.station.c, t, {
      limit: 8, isVisible: sv => state.groups[sv.group],
    });
    const list = document.getElementById('station-deps');
    list.replaceChildren(...deps.map(d => {
      const li = document.createElement('li');
      const min = Math.floor(d.wait / 60);
      li.innerHTML = `<span class="dep-time">${formatTime(d.time).slice(0, 5)}</span>
        <i class="dep-swatch"></i>
        <span class="dep-name"></span>
        <span class="dep-wait">${min === 0 ? 'まもなく' : `${min}分後`}</span>`;
      li.querySelector('.dep-swatch').style.background = d.service.color;
      li.querySelector('.dep-name').textContent =
        `${shortName(d.service)} ${destinationOf(d.pattern)}${d.first ? '（始発）' : ''}`;
      return li;
    }));
    document.getElementById('station-empty').hidden = deps.length > 0;
  }

  document.getElementById('station-close').addEventListener('click', () => {
    state.station = null;
    renderStation();
  });

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
      renderDayChart();
    });
    legend.appendChild(label);
  }

  // 駅の検索: 同名で場所の違う駅には路線名を添える
  const stationIndex = (() => {
    const byName = new Map();
    for (const l of NET.lines) {
      for (const [name, c] of l.stations) {
        const list = byName.get(name) || [];
        if (!list.some(x => Sim.haversine(x.c, c) < 400)) list.push({ name, c, line: l.name, kind: l.kind });
        byName.set(name, list);
      }
    }
    const entries = [];
    for (const list of byName.values()) {
      for (const st of list) entries.push({ ...st, label: list.length > 1 ? `${st.name}（${st.line}）` : st.name });
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  })();
  const datalist = document.getElementById('station-list');
  for (const st of stationIndex) {
    const o = document.createElement('option');
    o.value = st.label;
    datalist.appendChild(o);
  }
  document.getElementById('search').addEventListener('change', e => {
    const st = stationIndex.find(x => x.label === e.target.value.trim()) ||
      stationIndex.find(x => x.name === e.target.value.trim());
    if (!st) return;
    state.follow = false;
    map.flyTo({ center: st.c, zoom: st.kind === 'tram' ? 16.3 : 15.3, pitch: 60, duration: 2000, essential: true });
    openStation(st.name, st.c);
    e.target.blur();
  });

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
    themeBtn.textContent = { auto: '地図: 自動（昼夜）', light: '地図: ライト', dark: '地図: ダーク' }[state.themeMode];
    buildingsBtn.setAttribute('aria-pressed', String(state.buildings));
    terrainBtn.setAttribute('aria-pressed', String(state.terrain));
  }
  themeBtn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    state.themeMode = order[(order.indexOf(state.themeMode) + 1) % order.length];
    const theme = resolveTheme(simTime());
    if (theme !== state.theme) {
      state.theme = theme;
      loadStyle();
    }
    renderToggles();
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

  // ---------------------------------------------------------------- 1日の運行本数
  // 10 分ごとに運行中の列車を数えた折れ線。ホバーで値、クリックでその時刻へ移動
  const CHART = { w: 272, h: 84, left: 4, right: 4, top: 8, bottom: 16, step: 600 };
  let dayCounts = null;
  let dayKey = '';

  function computeDayCounts() {
    const key = NET.groups.map(g => (state.groups[g.id] ? 1 : 0)).join('');
    if (key === dayKey && dayCounts) return dayCounts;
    dayKey = key;
    dayCounts = [];
    for (let t = 0; t <= 86400; t += CHART.step) {
      dayCounts.push(sim.trainsAt(t % 86400, sv => state.groups[sv.group]).length);
    }
    return dayCounts;
  }

  const chartX = t => CHART.left + (t / 86400) * (CHART.w - CHART.left - CHART.right);
  function chartY(v, max) {
    return CHART.h - CHART.bottom - (v / max) * (CHART.h - CHART.top - CHART.bottom);
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function renderDayChart() {
    const counts = computeDayCounts();
    const max = Math.max(10, ...counts) * 1.1;
    const svg = document.getElementById('daychart-svg');
    const pts = counts.map((v, i) => `${chartX(i * CHART.step).toFixed(1)},${chartY(v, max).toFixed(1)}`);
    const base = chartY(0, max);
    const nodes = [
      svgEl('path', { class: 'area', d: `M${chartX(0)},${base}L${pts.join('L')}L${chartX(86400)},${base}Z` }),
      svgEl('path', { class: 'line', d: `M${pts.join('L')}` }),
      svgEl('line', { class: 'axis', x1: chartX(0), x2: chartX(86400), y1: base, y2: base }),
    ];
    for (const h of [0, 6, 12, 18, 24]) {
      const t = svgEl('text', { class: 'tick', x: chartX(h * 3600), y: CHART.h - 3, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
      t.textContent = `${h}時`;
      nodes.push(t);
    }
    nodes.push(svgEl('line', { class: 'now', id: 'daychart-now', y1: CHART.top - 4, y2: base }));
    nodes.push(svgEl('line', { class: 'hair', id: 'daychart-hair', y1: CHART.top - 4, y2: base, visibility: 'hidden' }));
    nodes.push(svgEl('circle', { class: 'dot', id: 'daychart-dot', r: 4, visibility: 'hidden' }));
    svg.replaceChildren(...nodes);
    const peak = Math.max(...counts);
    svg.setAttribute('aria-label', `時刻ごとの運行中の列車本数。最大 ${peak} 本（${formatTime(counts.indexOf(peak) * CHART.step).slice(0, 5)} 頃）`);
    // 表で見る (1 時間ごと)
    const tbody = document.querySelector('#daychart-table tbody');
    tbody.replaceChildren(...Array.from({ length: 24 }, (_, h) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td>';
      tr.children[0].textContent = `${String(h).padStart(2, '0')}:00`;
      tr.children[1].textContent = `${counts[h * 6]} 本`;
      return tr;
    }));
    renderChartNow();
  }

  function renderChartNow() {
    const line = document.getElementById('daychart-now');
    if (!line) return;
    const t = ((simTime() % 86400) + 86400) % 86400;
    line.setAttribute('x1', chartX(t));
    line.setAttribute('x2', chartX(t));
  }

  (function bindDayChart() {
    const svg = document.getElementById('daychart-svg');
    const tip = document.getElementById('daychart-tip');
    const toTime = e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * CHART.w;
      const frac = (x - CHART.left) / (CHART.w - CHART.left - CHART.right);
      return Math.min(86400 - CHART.step, Math.max(0, Math.round(frac * 86400 / CHART.step) * CHART.step));
    };
    svg.addEventListener('pointermove', e => {
      const t = toTime(e);
      const counts = computeDayCounts();
      const max = Math.max(10, ...counts) * 1.1;
      const v = counts[t / CHART.step];
      const hair = document.getElementById('daychart-hair');
      const dot = document.getElementById('daychart-dot');
      hair.setAttribute('x1', chartX(t)); hair.setAttribute('x2', chartX(t)); hair.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', chartX(t)); dot.setAttribute('cy', chartY(v, max)); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '<b></b> 本 · <span></span>';
      tip.querySelector('b').textContent = String(v);
      tip.querySelector('span').textContent = formatTime(t).slice(0, 5);
      tip.style.left = `${(chartX(t) / CHART.w) * 100}%`;
    });
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      document.getElementById('daychart-hair').setAttribute('visibility', 'hidden');
      document.getElementById('daychart-dot').setAttribute('visibility', 'hidden');
    });
    svg.addEventListener('click', e => setClock(toTime(e), state.clock.speed));
  })();
  renderDayChart();

  // ---------------------------------------------------------------- 撮影モード・共有
  // 撮影モード: パネル類を隠し、カメラをゆっくり回転させる (動画・GIF 撮影用)
  let cinemaFrame = null;
  function setCinema(on) {
    document.body.classList.toggle('cinema', on);
    if (cinemaFrame) cancelAnimationFrame(cinemaFrame);
    cinemaFrame = null;
    if (!on) return;
    let last = performance.now();
    const spin = now => {
      const dt = now - last;
      last = now;
      // 利用者がドラッグ中のときは回さない (追跡中はカメラが常に動いているので回す)
      if (state.follow || !map.isMoving()) map.setBearing(map.getBearing() + dt * 0.004);
      cinemaFrame = requestAnimationFrame(spin);
    };
    cinemaFrame = requestAnimationFrame(spin);
  }
  document.getElementById('cinema').addEventListener('click', () => setCinema(true));
  document.getElementById('cinema-exit').addEventListener('click', () => setCinema(false));
  // キーボード操作: Space 一時停止 / 1-4 倍速 / N 現在時刻 / C 撮影モード / F 追跡 / Esc 閉じる
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const cinema = document.body.classList.contains('cinema');
    if (e.key === 'Escape') {
      if (cinema) setCinema(false);
      else {
        state.selected = null;
        state.station = null;
        state.follow = false;
        renderInfo();
        renderStation();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      setClock(simTime(), state.clock.speed, !state.clock.paused);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      setClock(simTime(), SPEEDS[Number(e.key) - 1], false);
    } else if (e.key === 'n' || e.key === 'N') {
      setClock(jstNow(), 1, false);
    } else if (e.key === 'c' || e.key === 'C') {
      setCinema(!cinema);
    } else if ((e.key === 'f' || e.key === 'F') && state.selected) {
      document.getElementById('info-follow').click();
    }
  });
  if (params.has('cinema')) setCinema(true);

  document.getElementById('share').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('t', formatTime(simTime()).slice(0, 5));
    if (state.clock.speed !== 1) url.searchParams.set('speed', String(state.clock.speed));
    else url.searchParams.delete('speed');
    const btn = document.getElementById('share');
    try {
      await navigator.clipboard.writeText(url.toString());
      btn.textContent = 'コピーしました';
    } catch (e) {
      window.prompt('このリンクをコピーしてください', url.toString());
    }
    setTimeout(() => { btn.textContent = 'この景色を共有'; }, 2000);
  });

  // スマートフォンでは最初はパネルを畳んでおく
  if (matchMedia('(max-width: 640px)').matches) document.getElementById('panel').classList.add('collapsed');

  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('collapsed');
  });

  // デバッグ・テスト用
  window.mm3d = { map, sim, state, setClock, simTime };
})();
