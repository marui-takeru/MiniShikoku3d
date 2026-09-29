// 運行シミュレーション: ダイヤパターン (運転間隔・停車駅・所要時間) から
// 任意の時刻における各列車の位置を決定的に計算する。
(function () {
  'use strict';

  const R = 6371008.8;
  const DEG = Math.PI / 180;

  function parseTime(s) {
    const [h, m] = s.split(':').map(Number);
    return h * 3600 + m * 60;
  }

  function haversine(a, b) {
    const dLat = (b[1] - a[1]) * DEG;
    const dLon = (b[0] - a[0]) * DEG;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    const y = Math.sin((b[0] - a[0]) * DEG) * Math.cos(b[1] * DEG);
    const x = Math.cos(a[1] * DEG) * Math.sin(b[1] * DEG) -
      Math.sin(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.cos((b[0] - a[0]) * DEG);
    return Math.atan2(y, x); // ラジアン, 北=0 時計回り
  }

  // 座標 c から方位 brg (rad) へ dist [m] 進んだ点 (近距離なので平面近似)
  function offset(c, brg, dist) {
    const dLat = dist * Math.cos(brg) / R;
    const dLon = dist * Math.sin(brg) / (R * Math.cos(c[1] * DEG));
    return [c[0] + dLon / DEG, c[1] + dLat / DEG];
  }

  // 1 方向分の運行パターン (経路 + 時刻の骨組み)
  class Pattern {
    // trips を渡すと、列車ごとの実際の発着時刻 (GTFS など) を使う。
    // trips[i].t = 停車駅ごとの [到着, 発車] (始発駅発車からの秒)
    constructor(service, path, departures, dirLabel, trips) {
      this.service = service;
      this.path = path; // [[name, [lon,lat], stop], ...]
      this.departures = departures; // 始発駅発車時刻 [秒]
      this.dirLabel = dirLabel;
      this.coords = path.map(p => p[1]);
      this.cum = [0];
      for (let i = 1; i < path.length; i++) {
        this.cum.push(this.cum[i - 1] + haversine(this.coords[i - 1], this.coords[i]));
      }
      this.length = this.cum[this.cum.length - 1];
      this._buildTimeline();
      if (trips) this._useTripTimes(trips);
      this.layover = service.kind === 'plane' ? 0 : layoverFor(service, departures);
      // 終着駅に着いた列車も少しの間ホームに停車させる (飛行機は滑走路で止まったら消す)
      this.linger = service.loop || service.kind === 'plane' ? 0 : (service.kind === 'tram' ? 60 : 120);
      const lastStop = [...path].reverse().find(p => p[2]);
      this.destination = service.loop ? null : lastStop[0];
    }

    // 各区間の [発車時刻, 到着時刻] を計算 (始発駅発車を 0 秒とする)
    _buildTimeline() {
      const sv = this.service;
      const v = sv.speed / 3.6;
      const segs = [];
      let t = 0;
      let segStart = 0; // 直前の停車駅の index
      // 停車駅から停車駅までを 1 区間として扱い、通過駅はその途中に含める
      for (let i = 1; i < this.path.length; i++) {
        const isStop = this.path[i][2] || i === this.path.length - 1;
        if (!isStop) continue;
        const d = this.cum[i] - this.cum[segStart];
        const run = d / v + sv.accel * 2;
        segs.push({ from: segStart, to: i, d0: this.cum[segStart], d1: this.cum[i], t0: t, t1: t + run });
        t += run;
        // 駅ごとの停車時間 (例: 併結・切り離しをする駅は長め)
        const dwell = sv.stopDwell && sv.stopDwell[this.path[i][0]] !== undefined ? sv.stopDwell[this.path[i][0]] : sv.dwell;
        if (i !== this.path.length - 1) t += dwell;
        segStart = i;
      }
      this.segs = segs;
      this.duration = t;
    }

    _useTripTimes(trips) {
      const stops = this.path.map((p, i) => (p[2] ? i : -1)).filter(i => i >= 0);
      this.tripSegs = trips.map(tr => stops.slice(0, -1).map((from, k) => ({
        from, to: stops[k + 1], d0: this.cum[from], d1: this.cum[stops[k + 1]],
        t0: tr.t[k][1], t1: Math.max(tr.t[k + 1][0], tr.t[k][1] + 1),
      })));
    }

    // 列車 (departures の添字) ごとの区間時刻と所要時間
    segsOf(di) {
      return this.tripSegs ? this.tripSegs[di] : this.segs;
    }

    durationOf(di) {
      const segs = this.segsOf(di);
      return segs[segs.length - 1].t1;
    }

    // 発車後 elapsed 秒の状態
    stateAt(elapsed, segs = this.segs) {
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        if (elapsed < s.t0) {
          // 停車中 (s.from 駅)
          return { dist: s.d0, stopped: true, at: s.from, next: s.from, seg: k };
        }
        if (elapsed <= s.t1) {
          const u = (elapsed - s.t0) / (s.t1 - s.t0);
          // 加減速を表す緩急カーブ (停車駅間は加速→巡航→減速)
          const accelFrac = Math.min(0.45, this.service.accel / (s.t1 - s.t0));
          const e = easeTrapezoid(u, accelFrac);
          return { dist: s.d0 + (s.d1 - s.d0) * e, stopped: false, at: null, next: s.to, seg: k };
        }
      }
      const last = segs[segs.length - 1];
      return { dist: last.d1, stopped: true, at: last.to, next: last.to, seg: segs.length - 1 };
    }

    // 経路上の距離 d における座標と進行方位
    pointAt(d) {
      const cum = this.cum;
      if (d <= 0) return { c: this.coords[0], brg: bearing(this.coords[0], this.coords[1]) };
      if (d >= this.length) {
        const n = this.coords.length;
        return { c: this.coords[n - 1], brg: bearing(this.coords[n - 2], this.coords[n - 1]) };
      }
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid; else hi = mid;
      }
      const a = this.coords[lo], b = this.coords[hi];
      const f = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
      return { c: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], brg: bearing(a, b) };
    }
  }

  // 台形速度プロファイルを正規化した位置関数 (u, 戻り値とも 0..1)
  function easeTrapezoid(u, a) {
    if (a <= 0) return u;
    const vmax = 1 / (1 - a); // 面積が 1 になる最高速度
    if (u < a) return 0.5 * vmax * u * u / a;
    if (u > 1 - a) {
      const r = 1 - u;
      return 1 - 0.5 * vmax * r * r / a;
    }
    return 0.5 * vmax * a + vmax * (u - a);
  }

  // 始発駅での発車待ち時間 [秒]。環状線は駅に列車が重なるので待たせない。
  // 続行列車と重ならないよう、最小運転間隔より 1 分短くする。
  function layoverFor(sv, departures) {
    if (sv.loop) return 0;
    const base = sv.kind === 'tram' ? 180 : 300;
    let minGap = Infinity;
    for (let i = 1; i < departures.length; i++) minGap = Math.min(minGap, departures[i] - departures[i - 1]);
    return Math.max(0, Math.min(base, minGap - 60));
  }

  // 運転間隔の帯 (bands) から発車時刻を作る。
  // bandsByDay があれば平日 / 土休日で使い分け、bandsReturn* があれば上りは別の帯を使う
  function expandDepartures(sv, reverse, dayType = 'weekday') {
    if (sv.coupleWith) return []; // 併結相手の時刻から後で決める (Simulator._couple)
    const explicit = reverse ? sv.departuresReturn : sv.departures;
    if (explicit) return explicit.map(parseTime);
    const byDay = reverse && sv.bandsByDayReturn ? sv.bandsByDayReturn : sv.bandsByDay;
    const own = byDay ? (byDay[dayType] || byDay.weekday) : null;
    const bands = own || sv.bands;
    const out = [];
    // 上り列車は下りから 4 分ずらして、同じ区間ですれ違う位置がばらけるようにする
    // (上り専用の帯があるときは、その時刻をそのまま使う)
    const off = (sv.offset || 0) * 60 + (reverse && !sv.bandsByDayReturn ? 240 : 0);
    for (const [a, b, headway] of bands) {
      const start = parseTime(a) + off;
      const end = parseTime(b);
      for (let t = start; t < end; t += headway * 60) out.push(t);
    }
    return [...new Set(out)].sort((x, y) => x - y);
  }

  // 朝夕の増結: rushCars がある系統は、この時間帯に始発駅を出る列車の両数を増やす
  const RUSH = [[6.5 * 3600, 8.5 * 3600], [16.5 * 3600, 19 * 3600]];
  function carsFor(sv, dep) {
    if (!sv.rushCars) return sv.cars;
    const t = ((dep % 86400) + 86400) % 86400;
    return RUSH.some(([a, b]) => t >= a && t < b) ? sv.rushCars : sv.cars;
  }

  class Simulator {
    constructor(network) {
      this.network = network;
      this.dayType = 'weekday';
      this._build();
    }

    // 平日ダイヤ / 土休日ダイヤの切り替え。時刻表データ (trips) の便を選び直す
    setDayType(type) {
      if (type === this.dayType) return;
      this.dayType = type;
      this._build();
    }

    // JST の日付 (YYYYMMDD) から、その日のダイヤの種類を判定する (土日・祝日は土休日ダイヤ)
    dayTypeOf(ymd) {
      const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
      const holidays = (this.network.calendar && this.network.calendar.holidays) || [];
      return d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.includes(ymd) ? 'holiday' : 'weekday';
    }

    _build() {
      this.patterns = [];
      this._st = null;
      this._conn = null;
      for (const sv of this.network.services) {
        if (sv.trips) {
          const trips = sv.trips.filter(tr => !tr.days || tr.days.includes(this.dayType));
          if (trips.length) this.patterns.push(new Pattern(sv, sv.path, trips.map(tr => tr.dep), 'trips', trips));
          continue;
        }
        const fwd = sv.path;
        const rev = [...sv.path].reverse();
        if (sv.loop) {
          this.patterns.push(new Pattern(sv, fwd, expandDepartures(sv, false, this.dayType), sv.name));
        } else {
          this.patterns.push(this._anchor(new Pattern(sv, fwd, expandDepartures(sv, false, this.dayType), 'down'), sv.departuresAt));
          if (sv.both) this.patterns.push(this._anchor(new Pattern(sv, rev, expandDepartures(sv, true, this.dayType), 'up'), sv.departuresReturnAt));
        }
      }
      for (const p of this.patterns) if (p.service.coupleWith) this._couple(p);
    }

    // 併結・切り離し: 相手の列車 (partner) の駅の発着時刻に合わせて、この列車の時刻を決める。
    //   終点がその駅 (例: 高松→宇多津) … 相手が発車する lead 秒前に着き、相手の後ろに連結して消える
    //   始発がその駅 (例: 宇多津→高松) … 相手が着いた瞬間に切り離されて現れ、split 秒後に発車する
    // departuresAt: 発車時刻を始発駅ではなく途中駅 (その駅を発車する時刻) で指定した系統。始発駅の時刻に直す
    _anchor(p, station) {
      if (!station) return p;
      const k = p.path.findIndex(x => x[0] === station && x[2]);
      const sg = k >= 0 && p.segs.find(x => x.from === k);
      if (sg) p.departures = p.departures.map(d => d - sg.t0);
      return p;
    }

    _couple(p) {
      const cw = p.service.coupleWith;
      const q = this.patterns.find(x => x.service.id === cw.partner && x.dirLabel === p.dirLabel);
      if (!q) return;
      const k = q.path.findIndex(x => x[0] === cw.station && x[2]);
      const joins = p.path[p.path.length - 1][0] === cw.station;
      const partnerCars = q.service.cars;
      const extra = { cars: p.service.cars, color: p.service.color, name: p.service.name };
      if (joins) {
        const sg = q.segs.find(x => x.from === k); // 相手がその駅を発車する区間
        p.departures = q.departures.map(d => d + sg.t0 - cw.lead - p.duration);
        p.layover = 0;
        p.linger = cw.lead;
        p.couple = { role: 'join', partner: q, partnerCars, station: cw.station, partnerName: cw.partnerName };
        q.couple = { role: 'lead-join', at: sg.t0, station: cw.station, index: k, ...extra };
      } else {
        const sg = q.segs.find(x => x.to === k); // 相手がその駅に着く区間
        p.departures = q.departures.map(d => d + sg.t1 + cw.split);
        p.layover = cw.split;
        p.couple = { role: 'split', partner: q, partnerCars, station: cw.station, partnerName: cw.partnerName, stationCum: q.cum[k] };
        q.couple = { role: 'lead-split', at: sg.t1, station: cw.station, index: k, ...extra };
      }
    }

    // ---- 到達圏 (Connection Scan Algorithm) ----
    // 同名で 400m 以内の駅を 1 つの駅としてまとめ、駅間の乗り換え徒歩も考慮する
    _stations() {
      if (this._st) return this._st;
      const list = [];
      const idOf = (name, c) => {
        let st = list.find(x => x.name === name && haversine(x.c, c) < 400);
        if (!st) {
          st = { id: list.length, name, c };
          list.push(st);
        }
        return st.id;
      };
      // 航空便は四国の外と行き来するだけなので、乗り換えの計算には入れない
      for (const p of this.patterns) {
        p.stopIds = p.service.kind === 'plane' ? p.path.map(() => -1) : p.path.map(q => (q[2] ? idOf(q[0], q[1]) : -1));
      }
      // 徒歩連絡: 別の駅でも 500m 以内なら歩いて乗り換えられる (迂回率 1.3, 時速 4.3km, +1分)
      const walks = list.map(() => []);
      for (const a of list) {
        for (const b of list) {
          if (a.id >= b.id) continue;
          const d = haversine(a.c, b.c);
          if (d > 500) continue;
          const sec = d * 1.3 / 1.2 + 60;
          walks[a.id].push([b.id, sec]);
          walks[b.id].push([a.id, sec]);
        }
      }
      this._st = { list, walks };
      return this._st;
    }

    _connections(isVisible) {
      const { list } = this._stations();
      const key = this.patterns.map(p => (isVisible && !isVisible(p.service) ? 0 : 1)).join('');
      if (this._conn && this._conn.key === key) return this._conn.items;
      const items = [];
      let trip = 0;
      for (const p of this.patterns) {
        if (isVisible && !isVisible(p.service)) continue;
        if (p.service.kind === 'plane') continue;
        p.departures.forEach((dep, di) => {
          for (const sg of p.segsOf(di)) {
            items.push([dep + sg.t0, dep + sg.t1, p.stopIds[sg.from], p.stopIds[sg.to], trip, p]);
          }
          trip++;
        });
      }
      items.sort((a, b) => a[0] - b[0]);
      this._conn = { key, items, stations: list.length };
      return items;
    }

    // name 駅 (座標 c 付近) を時刻 t0 に出発したとき、各駅に最も早く着く時刻
    reachFrom(name, c, t0, { maxMinutes = 60, isVisible } = {}) {
      const { list, walks } = this._stations();
      const conns = this._connections(isVisible);
      const limit = t0 + maxMinutes * 60;
      const arr = new Float64Array(list.length).fill(Infinity);
      const via = new Array(list.length).fill(null);
      const origin = list.filter(x => x.name === name && haversine(x.c, c) < 400);
      const relax = (id, time, how) => {
        if (time >= arr[id]) return;
        arr[id] = time;
        via[id] = how;
        for (const [to, sec] of walks[id]) {
          if (time + sec < arr[to]) {
            arr[to] = time + sec;
            via[to] = { walk: true, from: id };
          }
        }
      };
      for (const o of origin) relax(o.id, t0, null);
      const boarded = new Set();
      const CHANGE = 60; // 乗り換えの最低時間 [秒]
      let lo = 0, hi = conns.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (conns[m][0] < t0) lo = m + 1; else hi = m; }
      for (let i = lo; i < conns.length; i++) {
        const [dep, arrT, from, to, trip, p] = conns[i];
        if (dep > limit) break;
        const onBoard = boarded.has(trip);
        const isOrigin = origin.some(o => o.id === from);
        if (!onBoard && arr[from] + (isOrigin ? 0 : CHANGE) > dep) continue;
        boarded.add(trip);
        if (arrT <= limit) relax(to, arrT, { service: p.service, pattern: p });
      }
      return list
        .map(st => ({ ...st, time: arr[st.id], minutes: (arr[st.id] - t0) / 60, via: via[st.id] }))
        .filter(x => x.time <= limit);
    }

    // 駅の発車案内: 時刻 t 以降に name 駅 (座標 c の近く) を発車する列車
    departuresAt(name, c, t, { limit = 10, horizon = 3 * 3600, isVisible, radius = 400 } = {}) {
      const out = [];
      for (const p of this.patterns) {
        if (isVisible && !isVisible(p.service)) continue;
        for (let k = 0; k < p.segs.length; k++) {
          const from = p.segs[k].from;
          const st = p.path[from];
          if (st[0] !== name || haversine(st[1], c) > radius) continue;
          p.departures.forEach((dep, di) => {
            const time = dep + p.segsOf(di)[k].t0;
            const wait = ((time - t) % 86400 + 86400) % 86400;
            if (wait > horizon) return;
            out.push({ pattern: p, service: p.service, time: time % 86400, wait, first: from === 0 });
          });
        }
      }
      out.sort((a, b) => a.wait - b.wait);
      return out.slice(0, limit);
    }

    // 到着案内: 時刻 t 以降に name 駅 (座標 c の近く) が終点の便の到着時刻
    arrivalsAt(name, c, t, { limit = 10, horizon = 3 * 3600, isVisible, radius = 400 } = {}) {
      const out = [];
      for (const p of this.patterns) {
        if (isVisible && !isVisible(p.service)) continue;
        const last = p.path[p.path.length - 1];
        if (last[0] !== name || haversine(last[1], c) > radius) continue;
        p.departures.forEach((dep, di) => {
          const segs = p.segsOf(di);
          const time = dep + segs[segs.length - 1].t1;
          const wait = ((time - t) % 86400 + 86400) % 86400;
          if (wait <= horizon) out.push({ pattern: p, service: p.service, time: time % 86400, wait });
        });
      }
      out.sort((a, b) => a.wait - b.wait);
      return out.slice(0, limit);
    }

    // 時刻 t (0時からの秒, JST) に走行中の列車一覧
    // 始発駅では発車の数分前から「発車待ち」として停車させる
    trainsAt(t, isVisible) {
      const trains = [];
      this.patterns.forEach((p, pi) => {
        if (isVisible && !isVisible(p.service)) return;
        const wait = p.layover;
        // 日付をまたぐ列車のため前日分も確認する
        for (const base of [t, t + 86400]) {
          for (let di = 0; di < p.departures.length; di++) {
            const dep = p.departures[di];
            const elapsed = base - dep;
            if (elapsed < -wait) continue;
            const segs = p.segsOf(di);
            if (elapsed > segs[segs.length - 1].t1 + p.linger) continue;
            const st = p.stateAt(Math.max(0, elapsed), segs);
            trains.push({
              id: `${p.service.id}:${pi}:${di}`,
              pattern: p,
              service: p.service,
              dep,
              cars: carsFor(p.service, dep),
              elapsed,
              waiting: elapsed < 0,
              segs,
              ...st,
            });
          }
        }
      });
      return trains;
    }
  }

  function formatTime(sec) {
    sec = ((Math.floor(sec) % 86400) + 86400) % 86400;
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
  }

  window.Sim = { Simulator, Pattern, carsFor, offset, bearing, haversine, formatTime, parseTime, easeTrapezoid };
})();
