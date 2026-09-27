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
    constructor(service, path, departures, dirLabel) {
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
        if (i !== this.path.length - 1) t += sv.dwell;
        segStart = i;
      }
      this.segs = segs;
      this.duration = t;
    }

    // 発車後 elapsed 秒の状態
    stateAt(elapsed) {
      const segs = this.segs;
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

  function expandDepartures(sv, reverse) {
    const explicit = reverse ? sv.departuresReturn : sv.departures;
    if (explicit) return explicit.map(parseTime);
    const out = [];
    // 上り列車は下りから 4 分ずらして、同じ区間ですれ違う位置がばらけるようにする
    const off = (sv.offset || 0) * 60 + (reverse ? 240 : 0);
    for (const [a, b, headway] of sv.bands) {
      const start = parseTime(a) + off;
      const end = parseTime(b);
      for (let t = start; t < end; t += headway * 60) out.push(t);
    }
    return [...new Set(out)].sort((x, y) => x - y);
  }

  class Simulator {
    constructor(network) {
      this.network = network;
      this.patterns = [];
      for (const sv of network.services) {
        const fwd = sv.path;
        const rev = [...sv.path].reverse();
        if (sv.loop) {
          this.patterns.push(new Pattern(sv, fwd, expandDepartures(sv, false), sv.name));
        } else {
          this.patterns.push(new Pattern(sv, fwd, expandDepartures(sv, false), 'down'));
          if (sv.both) this.patterns.push(new Pattern(sv, rev, expandDepartures(sv, true), 'up'));
        }
      }
    }

    // 時刻 t (0時からの秒, JST) に走行中の列車一覧
    trainsAt(t, isVisible) {
      const trains = [];
      this.patterns.forEach((p, pi) => {
        if (isVisible && !isVisible(p.service)) return;
        // 日付をまたぐ列車のため前日分も確認する
        for (const base of [t, t + 86400]) {
          for (let di = 0; di < p.departures.length; di++) {
            const dep = p.departures[di];
            const elapsed = base - dep;
            if (elapsed < 0 || elapsed > p.duration) continue;
            const st = p.stateAt(elapsed);
            trains.push({
              id: `${p.service.id}:${pi}:${di}`,
              pattern: p,
              service: p.service,
              dep,
              elapsed,
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

  window.Sim = { Simulator, Pattern, offset, bearing, haversine, formatTime, parseTime, easeTrapezoid };
})();
