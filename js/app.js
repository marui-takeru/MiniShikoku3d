// Mini Shikoku 3D — 松山を中心とした四国の鉄道 3D 可視化
(function () {
  'use strict';

  const { Simulator, offset, bearing, formatTime, parseTime } = window.Sim;
  const NET = window.NETWORK;
  const sim = new Simulator(NET);
  // 今日 (JST) が平日か土休日かで、時刻表データの便を選ぶ。?day=weekday|holiday で固定もできる
  const todayYmd = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const dayParam = new URLSearchParams(location.search).get('day');
  sim.setDayType(['weekday', 'holiday'].includes(dayParam) ? dayParam : sim.dayTypeOf(todayYmd));

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
    setouchi: { center: [132.95, 33.95], zoom: 8.6, pitch: 45, bearing: 0 },
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
    airport: null,
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
    customAttribution: [
      ...(NET.trackSource === '国土数値情報（鉄道データ）'
        ? ['駅・線路・空港: 「<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank">国土数値情報</a>」（国土交通省）を加工して作成']
        : NET.trackSource ? [`線路: ${NET.trackSource}`] : []),
      '駅の並び: <a href="https://ekidata.jp/" target="_blank">駅データ.jp</a>',
      ...(NET.credits && NET.credits.length
        ? [`時刻表（GTFS）: ${NET.credits.map(c => c.replace(/（.*?）/, '').replace(/\s*GTFS$/, '')).join('・')}（<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank">CC BY 4.0</a>）`] : []),
      '航路: © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      '空港統計: 国土交通省',
      'その他の時刻は推計',
      '<a href="DATA_SOURCES.md" target="_blank">データ出典</a>',
    ].join(' | '),
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

    // 航路 (破線)
    map.addLayer({
      id: 'ferry-routes', type: 'line', source: 'tracks',
      filter: ['==', ['get', 'kind'], 'ship'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#8fb6e8' : '#3f6fa8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 2, 16, 3],
        'line-dasharray': [2, 2],
        'line-opacity': 0.8,
      },
    });

    // 駅・港 (JR・郊外線・港は広域から、路面電車は拡大時のみ表示)
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
    map.addSource('station-label-data', { type: 'geojson', data: stationsGeoJSON() });
    for (const kind of ['rail', 'tram']) {
      map.addLayer({
        id: `labels-${kind}`, type: 'symbol', source: 'station-label-data',
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

    // 空港 (敷地と、乗降客数に応じた大きさの印)
    map.addSource('airport-data', { type: 'geojson', data: airportsGeoJSON() });
    map.addLayer({
      id: 'airport-area', type: 'fill', source: 'airport-data',
      filter: ['==', ['get', 'shape'], 'area'],
      paint: { 'fill-color': dark ? '#5b7aa6' : '#7d9cc7', 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: 'airport-points', type: 'circle', source: 'airport-data',
      filter: ['==', ['get', 'shape'], 'point'],
      paint: {
        // 面積が乗降客数に比例するよう、半径は平方根に比例させる
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          7, ['*', 9, ['sqrt', ['/', ['get', 'passengers'], 3300000]]],
          12, ['*', 22, ['sqrt', ['/', ['get', 'passengers'], 3300000]]]],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': dark ? '#8fb6e8' : '#2a5a96',
        'circle-stroke-width': 2,
      },
    });
    // 文字はフォントが読めないとソース全体が描けなくなるので、別のソースにする
    map.addSource('airport-label-data', { type: 'geojson', data: airportsGeoJSON() });
    map.addLayer({
      id: 'airport-labels', type: 'symbol', source: 'airport-label-data',
      filter: ['==', ['get', 'shape'], 'point'],
      layout: {
        'text-field': ['concat', ['get', 'name'], '\n', ['get', 'label']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': dark ? '#e8ecf1' : '#1d2733',
        'text-halo-color': dark ? '#0b0e13' : '#ffffff',
        'text-halo-width': 1.5,
      },
    });

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
    map.addSource('reach-label-data', { type: 'geojson', data: reachGeoJSON() });
    map.addLayer({
      id: 'reach-labels', type: 'symbol', source: 'reach-label-data', minzoom: 10.5,
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

  function airportsGeoJSON() {
    const features = [];
    for (const a of NET.airports || []) {
      const props = {
        id: a.id, name: a.name, passengers: a.stats.passengers,
        label: `${a.stats.year}年 ${Math.round(a.stats.passengers / 10000)}万人`,
      };
      features.push({ type: 'Feature', properties: { ...props, shape: 'area' }, geometry: { type: 'Polygon', coordinates: [a.polygon] } });
      features.push({ type: 'Feature', properties: { ...props, shape: 'point' }, geometry: { type: 'Point', coordinates: a.coord } });
    }
    return { type: 'FeatureCollection', features };
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
    const notShip = ['!=', ['get', 'kind'], 'ship'];
    map.setFilter('tracks', ['all', f, notShip]);
    map.setFilter('tracks-casing', ['all', f, notShip]);
    map.setFilter('ferry-routes', ['all', f, ['==', ['get', 'kind'], 'ship']]);
    const inGroups = ['any', ...[...lineGroups].map(g => ['in', `,${g},`, ['get', 'groups']])];
    for (const kind of ['rail', 'tram']) {
      // 'rail' のレイヤーには鉄道の駅と港を、'tram' のレイヤーには電停を出す
      const kindFilter = kind === 'tram' ? ['==', ['get', 'kind'], 'tram'] : ['!=', ['get', 'kind'], 'tram'];
      const sf = ['all', kindFilter, inGroups];
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

  const HULL_COLOR = '#1f3f66';

  // 飛行機: 胴体・主翼・尾翼を、その地点の高度に浮かべて描く
  function altitudeAt(sv, d) {
    const a = sv.alt;
    if (!a) return 0;
    let lo = 0, hi = a.length - 1;
    if (d <= a[0][0]) return a[0][1];
    if (d >= a[hi][0]) return a[hi][1];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] <= d) lo = mid; else hi = mid;
    }
    const f = (d - a[lo][0]) / (a[hi][0] - a[lo][0] || 1);
    return a[lo][1] + (a[hi][1] - a[lo][1]) * f;
  }

  function planeFeatures(tr, scale, features, lights) {
    const sv = tr.service;
    const s = Math.max(1, scale / 2);
    const L = sv.carLength * s, span = sv.width * s, h = sv.height * s;
    const p = tr.pattern.pointAt(tr.dist);
    const brg = p.brg;
    const left = brg - Math.PI / 2;
    // 機首を現在地に置き、胴体・翼をその後ろに描く
    const at = (back, side) => offset(offset(p.c, brg + Math.PI, back), left, side);
    const alt = altitudeAt(sv, tr.dist);
    const base = alt + 0.5 * s;
    const poly = ring => { ring.push(ring[0]); return { type: 'Polygon', coordinates: [ring] }; };
    const body = poly([at(0, 0), at(L * 0.08, L * 0.06), at(L, L * 0.05), at(L, -L * 0.05), at(L * 0.08, -L * 0.06)]);
    const wing = poly([at(L * 0.38, 0), at(L * 0.55, span / 2), at(L * 0.62, span / 2), at(L * 0.55, 0),
      at(L * 0.62, -span / 2), at(L * 0.55, -span / 2)]);
    const tail = poly([at(L * 0.85, 0), at(L * 0.95, span * 0.18), at(L, span * 0.18), at(L, -span * 0.18),
      at(L * 0.95, -span * 0.18)]);
    for (const [geometry, color, hh] of [[body, sv.color, h], [wing, '#c9d2dc', h * 0.35], [tail, '#c9d2dc', h * 0.35]]) {
      features.push({ type: 'Feature', properties: { id: tr.id, color, b: base, h: base + hh }, geometry });
    }
    lights.push(light(at(L * 0.6, span / 2), '#ff3b30'));
    lights.push(light(at(L * 0.6, -span / 2), '#34c759'));
    lights.push(light(at(0, 0), '#fff6d8'));
  }

  // 船: 船首のとがった船体と、船尾寄りの客室を重ねる
  function shipFeatures(tr, scale, features, lights) {
    const sv = tr.service;
    const s = Math.max(1, scale / 4); // 船は大きいので誇張を控えめにする
    const L = sv.carLength * s, W = sv.width * s, h = sv.height * s;
    const head = Math.max(tr.dist, Math.min(L, tr.pattern.length));
    const f = tr.pattern.pointAt(head);
    const b = tr.pattern.pointAt(Math.max(0, head - L));
    const brg = bearing(b.c, f.c) || f.brg;
    const left = brg - Math.PI / 2;
    const at = (d, side) => offset(offset(b.c, brg, d), left, side);
    const hull = [at(0, W / 2), at(L * 0.75, W / 2), at(L, 0), at(L * 0.75, -W / 2), at(0, -W / 2)];
    hull.push(hull[0]);
    const cabin = [at(L * 0.12, W * 0.35), at(L * 0.6, W * 0.35), at(L * 0.6, -W * 0.35), at(L * 0.12, -W * 0.35)];
    cabin.push(cabin[0]);
    const base = 0.3 * s;
    features.push({ type: 'Feature', properties: { id: tr.id, color: HULL_COLOR, b: base, h: base + h * 0.4 },
      geometry: { type: 'Polygon', coordinates: [hull] } });
    features.push({ type: 'Feature', properties: { id: tr.id, color: sv.color, b: base + h * 0.4, h: base + h },
      geometry: { type: 'Polygon', coordinates: [cabin] } });
    lights.push(light(at(L, 0), '#fff6d8'));
    lights.push(light(at(0, 0), '#ff3b30'));
  }

  function trainFeatures(trains, scale) {
    const features = [];
    const lights = [];
    for (const tr of trains) {
      const sv = tr.service;
      if (sv.kind === 'ship') {
        shipFeatures(tr, scale, features, lights);
        continue;
      }
      if (sv.kind === 'plane') {
        planeFeatures(tr, scale, features, lights);
        continue;
      }
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

  // 画面の外 (表示範囲を 30% 広げた外側) の列車は描かない。選択中の列車は常に描く
  function visibleTrains(trains) {
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.3;
    const padY = (b.getNorth() - b.getSouth()) * 0.3;
    const w = b.getWest() - padX, e = b.getEast() + padX, sth = b.getSouth() - padY, n = b.getNorth() + padY;
    return trains.filter(tr => {
      if (tr.id === state.selected) return true;
      const c = tr.pattern.pointAt(tr.dist).c;
      return c[0] >= w && c[0] <= e && c[1] >= sth && c[1] <= n;
    });
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
    const drawn = trainFeatures(visibleTrains(trains), sizeScale());
    map.getSource('trains').setData(drawn.trains);
    map.getSource('train-lights').setData(state.night > 0.05 ? drawn.lights : empty());
    document.getElementById('train-count').textContent = String(trains.length);
    updateSelection(trains, t);
    if (now - lastBoard > 1000) {
      lastBoard = now;
      if (state.station) renderStation();
      if (state.airport) renderAirportFlights();
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
  for (const layer of ['airport-points', 'airport-area']) {
    map.on('click', layer, e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      openAirport(e.features[0].properties.id);
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
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
    state.airport = null;
    renderInfo();
    renderStation();
    renderAirport();
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
    const ship = tr.service.kind === 'ship';
    if (tr.service.kind === 'plane') {
      const sv = tr.service;
      const alt = Math.round(altitudeAt(sv, tr.dist) / 10) * 10;
      const left = Math.max(0, Math.round((tr.segs[tr.segs.length - 1].t1 - tr.elapsed) / 60));
      status = sv.flight === 'dep'
        ? (alt > 0 ? `${sv.toName} へ向けて上昇中（高度 約${alt.toLocaleString()} m）` : '離陸滑走中')
        : (alt > 0 ? `着陸まで あと約${left}分（高度 約${alt.toLocaleString()} m）` : '着陸しました');
      document.getElementById('info-status').textContent = status;
      document.getElementById('info-stops').replaceChildren();
      return;
    }
    if (tr.waiting) {
      status = `${path[0][0]} で${ship ? '出港' : '発車'}待ち（${formatTime(tr.dep).slice(0, 5)} 発）`;
    } else if (tr.stopped && tr.at === path.length - 1) {
      status = `${path[tr.at][0]} に${ship ? '入港' : '到着'}しました`;
    } else if (tr.stopped) {
      const seg = tr.segs[tr.seg];
      status = `${path[tr.at][0]} に${ship ? '停泊' : '停車'}中（${formatTime(tr.dep + seg.t0).slice(0, 5)} 発）`;
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
    const dest = sv.kind === 'plane'
      ? (sv.flight === 'dep' ? `${sv.toName} 行き（出発便）` : `${sv.fromName} 発（到着便）`)
      : sv.loop ? '' : `${p.destination} 行`;
    const origin = p.path[0][0];
    document.getElementById('info-swatch').style.background = sv.color;
    document.getElementById('info-name').textContent = sv.name;
    document.getElementById('info-dest').textContent = dest;
    document.getElementById('info-detail').textContent =
      (sv.kind === 'plane'
        ? (sv.flight === 'dep'
          ? `${sv.fromName} ${formatTime(tr.dep).slice(0, 5)} 離陸`
          : `${sv.toName} ${formatTime(tr.dep + tr.segs[tr.segs.length - 1].t1).slice(0, 5)} 着陸予定`)
        : `${origin} ${formatTime(tr.dep).slice(0, 5)} 発 · ${p.tripSegs ? '時刻表データ' : '推計ダイヤ'}`)
      + (sv.note ? ` · ${sv.note}` : '');
    const followBtn = document.getElementById('info-follow');
    const noun = { ship: '船', plane: '飛行機' }[sv.kind] || '列車';
    followBtn.textContent = state.follow ? '追跡をやめる' : `この${noun}を追跡`;
    followBtn.setAttribute('aria-pressed', String(state.follow));
    box.hidden = false;
  }

  // ---------------------------------------------------------------- 到達圏
  // 所要時間の段階と色 (青の単色ランプ。近いほど濃い。ライト/ダークで別の段を使う)
  const REACH_BAND_SETS = { 30: [5, 10, 15, 20, 30], 60: [10, 20, 30, 45, 60], 90: [15, 30, 45, 60, 90] };
  let REACH_BANDS = REACH_BAND_SETS[60];
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

  function showReach(name, c, { fit = true } = {}) {
    const t0 = ((simTime() % 86400) + 86400) % 86400;
    const maxMinutes = Number(document.getElementById('reach-max').value);
    REACH_BANDS = REACH_BAND_SETS[maxMinutes];
    const results = sim.reachFrom(name, c, t0, { maxMinutes, isVisible: sv => state.groups[sv.group] });
    state.reach = { name, c, t0, maxMinutes, results };
    applyReachMode();
    if (!fit) return;
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
    if (map.getSource('reach')) {
      const data = reachGeoJSON();
      map.getSource('reach').setData(data);
      map.getSource('reach-label-data').setData(data);
    }
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
      `${r.name} を ${formatTime(r.t0).slice(0, 5)} に出発して ${r.maxMinutes} 分で行ける駅`;
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
  // 時刻や上限時間を変えて再計算 (カメラはそのまま、比較しやすいように)
  document.getElementById('reach-recalc').addEventListener('click', () => {
    if (state.reach) showReach(state.reach.name, state.reach.c, { fit: false });
  });
  document.getElementById('reach-max').addEventListener('change', () => {
    if (state.reach) showReach(state.reach.name, state.reach.c, { fit: false });
  });
  document.getElementById('station-reach').addEventListener('click', () => {
    if (state.station) showReach(state.station.name, state.station.c);
  });

  // ---------------------------------------------------------------- 空港の利用状況
  function openAirport(id) {
    state.airport = id;
    state.station = null;
    state.selected = null;
    state.follow = false;
    renderInfo();
    renderStation();
    renderAirport();
  }

  const fmtInt = n => Math.round(n).toLocaleString('ja-JP');
  const man = n => `${(n / 10000).toFixed(n >= 1e6 ? 0 : 1)}万`;

  // 単一系列の縦棒グラフ (月別) と折れ線グラフ (年別)。ホバーで値、表でも確認できる
  function barChart(svg, tip, rows, label) {
    const W = 272, H = 96, top = 8, bottom = 16, gap = 2;
    const max = Math.max(...rows.map(r => r.v)) * 1.1;
    const bw = (W - gap * (rows.length - 1)) / rows.length;
    const y = v => H - bottom - (v / max) * (H - top - bottom);
    const nodes = [svgEl('line', { class: 'axis', x1: 0, x2: W, y1: H - bottom, y2: H - bottom })];
    rows.forEach((r, i) => {
      const x = i * (bw + gap);
      const hgt = H - bottom - y(r.v);
      // 上端だけ角を丸めた棒 (4px)
      const rad = Math.min(4, bw / 2, hgt);
      const d = `M${x},${H - bottom}V${y(r.v) + rad}Q${x},${y(r.v)} ${x + rad},${y(r.v)}H${x + bw - rad}` +
        `Q${x + bw},${y(r.v)} ${x + bw},${y(r.v) + rad}V${H - bottom}Z`;
      const bar = svgEl('path', { class: 'bar', d, tabindex: 0 });
      const show = () => {
        svg.querySelectorAll('.bar').forEach(b => b.classList.remove('on'));
        bar.classList.add('on');
        tip.hidden = false;
        tip.innerHTML = '<b></b> <span></span>';
        tip.querySelector('b').textContent = `${man(r.v)}人`;
        tip.querySelector('span').textContent = r.label;
        tip.style.left = `${((x + bw / 2) / W) * 100}%`;
      };
      bar.addEventListener('pointerenter', show);
      bar.addEventListener('focus', show);
      nodes.push(bar);
      if (i % 3 === 0 || i === rows.length - 1) {
        const t = svgEl('text', { class: 'tick', x: x + bw / 2, y: H - 3, 'text-anchor': 'middle' });
        t.textContent = r.short;
        nodes.push(t);
      }
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', label);
    svg.replaceChildren(...nodes);
    svg.onpointerleave = () => {
      tip.hidden = true;
      svg.querySelectorAll('.bar').forEach(b => b.classList.remove('on'));
    };
  }

  function lineChart(svg, tip, rows, label) {
    const W = 272, H = 96, top = 10, bottom = 16, side = 6;
    const max = Math.max(...rows.map(r => r.v)) * 1.1;
    const x = i => side + (i / (rows.length - 1)) * (W - side * 2);
    const y = v => H - bottom - (v / max) * (H - top - bottom);
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.v).toFixed(1)}`).join('');
    const nodes = [
      svgEl('line', { class: 'axis', x1: 0, x2: W, y1: H - bottom, y2: H - bottom }),
      svgEl('path', { class: 'line', d }),
      svgEl('circle', { class: 'dot', r: 4, cx: x(rows.length - 1), cy: y(rows[rows.length - 1].v) }),
    ];
    rows.forEach((r, i) => {
      if (i === 0 || i === rows.length - 1 || r.short === '2020') {
        const t = svgEl('text', { class: 'tick', x: x(i), y: H - 3, 'text-anchor': i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' });
        t.textContent = r.short;
        nodes.push(t);
      }
    });
    const hair = svgEl('line', { class: 'hair', y1: top - 4, y2: H - bottom, visibility: 'hidden' });
    const hot = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    nodes.push(hair, hot);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', label);
    svg.replaceChildren(...nodes);
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * W;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((px - side) / (W - side * 2) * (rows.length - 1))));
      const r = rows[i];
      hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
      hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(r.v)); hot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '<b></b> <span></span>';
      tip.querySelector('b').textContent = `${man(r.v)}人`;
      tip.querySelector('span').textContent = r.label;
      tip.style.left = `${(x(i) / W) * 100}%`;
    };
    svg.onpointerleave = () => {
      tip.hidden = true;
      hair.setAttribute('visibility', 'hidden');
      hot.setAttribute('visibility', 'hidden');
    };
  }

  function renderAirport() {
    const box = document.getElementById('airport');
    const a = state.airport && (NET.airports || []).find(x => x.id === state.airport);
    if (!a) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const st = a.stats;
    document.getElementById('airport-name').textContent = a.name;
    document.getElementById('airport-total').textContent = `${fmtInt(st.passengers)} 人`;
    document.getElementById('airport-split').textContent =
      `国内線 ${man(st.domestic)}人 ・ 国際線 ${man(st.international)}人 ・ 着陸 ${fmtInt(st.landings)} 回`;
    document.getElementById('airport-meta').textContent =
      `滑走路 ${fmtInt(a.runway)} m ・ 運用 ${a.hours[0].slice(0, 2)}:${a.hours[0].slice(2)}〜${a.hours[1].slice(0, 2)}:${a.hours[1].slice(2)}`;
    const monthly = st.monthly.map(m => ({ v: m.passengers, label: `${st.year}年${m.month}月`, short: `${m.month}月` }));
    barChart(document.getElementById('airport-monthly'), document.getElementById('airport-monthly-tip'), monthly,
      `${a.name} ${st.year}年の月別乗降客数。最多は${monthly.reduce((b, r) => (r.v > b.v ? r : b)).label}`);
    const trend = st.trend.map(t => ({ v: t.passengers, label: `${t.year}年`, short: String(t.year) }));
    lineChart(document.getElementById('airport-trend'), document.getElementById('airport-trend-tip'), trend,
      `${a.name}の乗降客数の推移（${trend[0].label}〜${trend[trend.length - 1].label}）`);
    const tbody = document.querySelector('#airport-table tbody');
    tbody.replaceChildren(...st.trend.map(t => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td>';
      tr.children[0].textContent = `${t.year}年`;
      tr.children[1].textContent = fmtInt(t.passengers);
      tr.children[2].textContent = fmtInt(t.landings);
      return tr;
    }));
    renderAirportFlights();
  }

  function renderAirportFlights() {
    const a = state.airport && (NET.airports || []).find(x => x.id === state.airport);
    if (!a) return;
    const t = ((simTime() % 86400) + 86400) % 86400;
    const visible = sv => state.groups[sv.group];
    const deps = sim.departuresAt(a.name, a.coord, t, { limit: 4, radius: 4000, isVisible: visible });
    const arrs = sim.arrivalsAt(a.name, a.coord, t, { limit: 4, radius: 4000, isVisible: visible });
    const row = (time, text) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="dep-time"></span><span class="dep-name"></span>';
      li.querySelector('.dep-time').textContent = formatTime(time).slice(0, 5);
      li.querySelector('.dep-name').textContent = text;
      return li;
    };
    document.getElementById('airport-deps').replaceChildren(...deps.map(d => row(d.time, `${d.service.toName} 行き`)));
    document.getElementById('airport-arrs').replaceChildren(...arrs.map(d => row(d.time, `${d.service.fromName} から`)));
  }

  document.getElementById('airport-close').addEventListener('click', () => {
    state.airport = null;
    renderAirport();
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
    state.airport = null;
    renderAirport();
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
    // 時刻の出どころ (時刻表データか推計か) を明記する
    const real = deps.filter(d => d.pattern.tripSegs).length;
    document.getElementById('station-source').textContent =
      real === deps.length && real > 0 ? '発車時刻は時刻表データ（GTFS）にもとづきます。'
        : real > 0 ? '発車時刻は時刻表データ（GTFS）と運行パターンからの推計の混在です。'
          : '発車時刻は運行パターンからの推計です。';
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
    for (const a of NET.airports || []) entries.push({ name: a.name, c: a.coord, line: '空港', kind: 'air', label: a.name, airport: a.id });
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
    map.flyTo({ center: st.c, zoom: st.kind === 'tram' ? 16.3 : st.airport ? 12.5 : 15.3, pitch: 60, duration: 2000, essential: true });
    if (st.airport) openAirport(st.airport);
    else openStation(st.name, st.c);
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
    const key = sim.dayType + NET.groups.map(g => (state.groups[g.id] ? 1 : 0)).join('');
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

  // ---------------------------------------------------------------- 平日 / 土休日ダイヤ
  const dayBtn = document.getElementById('daytype');
  function renderDayType() {
    dayBtn.textContent = sim.dayType === 'holiday' ? '土休日ダイヤ' : '平日ダイヤ';
  }
  dayBtn.addEventListener('click', () => {
    sim.setDayType(sim.dayType === 'holiday' ? 'weekday' : 'holiday');
    // 便の番号が変わるので、選択中の列車と到達圏は解除する
    state.selected = null;
    state.follow = false;
    renderInfo();
    if (state.reach) clearReach();
    dayKey = '';
    renderDayChart();
    if (state.station) renderStation();
    renderDayType();
  });
  renderDayType();

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
    if (sim.dayType !== sim.dayTypeOf(todayYmd)) url.searchParams.set('day', sim.dayType);
    else url.searchParams.delete('day');
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
