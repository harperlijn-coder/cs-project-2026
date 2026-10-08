/* arch3d.js — mall-cus-service 架构站的可交互 3D 舞台。
 *
 * 无外部依赖：Canvas 2D 手写透视投影。视觉语言对齐 TraceMind 资金态势原型——深色舞台、发光球体、
 * 沿曲线流动的粒子、透视地面网格；交互：拖拽旋转、点击画布后滚轮缩放、双击复位、悬停提示、点击聚焦、
 * 模式切换时节点缓动到新坐标、时间轴状态机（熔断演示）。
 *
 * 场景数据由 scripts/architecture-pages 生成器写进页面：
 *   <div class="s3" data-scene="ID"></div><script type="application/json" id="s3-ID">{...}</script>
 * 离屏或标签页隐藏时暂停；prefers-reduced-motion 时关闭自动旋转并减速。
 */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var MAX_PARTICLES = 420;
  var BASIS = { x: [[0, 1, 0], [0, 0, 1]], y: [[1, 0, 0], [0, 0, 1]], z: [[1, 0, 0], [0, 1, 0]] };
  var rgbCache = {};

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rgb(hex) {
    var c = rgbCache[hex];
    if (c) return c;
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    c = rgbCache[hex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return c;
  }
  function rgba(hex, a) {
    var c = rgb(hex);
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')';
  }
  function mixHex(a, b, t) {
    var x = rgb(a), y = rgb(b), q = Math.round(clamp(t, 0, 1) * 16) / 16;
    var r = Math.round(x[0] + (y[0] - x[0]) * q), g = Math.round(x[1] + (y[1] - x[1]) * q), bl = Math.round(x[2] + (y[2] - x[2]) * q);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function bez(g, t) {
    var u = 1 - t;
    return {
      x: u * u * g.a.x + 2 * u * t * g.c.x + t * t * g.b.x,
      y: u * u * g.a.y + 2 * u * t * g.c.y + t * t * g.b.y,
      z: u * u * g.a.z + 2 * u * t * g.c.z + t * t * g.b.z
    };
  }
  function d3(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function matchTags(tags, filter) {
    if (!filter || !filter.length || !tags || !tags.length) return true;
    for (var i = 0; i < tags.length; i++) if (filter.indexOf(tags[i]) >= 0) return true;
    return false;
  }
  function fmt(v, f) {
    if (f === 'pct') return Math.round(v * 100) + '%';
    if (f === 'mmss') { var s = Math.max(0, Math.round(v)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    if (f === 'int') return String(Math.round(v));
    return v.toFixed(2);
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ------------------------------------------------------------------ Stage
  function Stage(root, scene) {
    var self = this;
    this.root = root;
    this.sc = scene;
    var cam = scene.camera || {};
    this.cam0 = { yaw: num(cam.yaw, -0.55), pitch: num(cam.pitch, 0.42), zoom: num(cam.zoom, 1) };
    this.yaw = this.tYaw = this.cam0.yaw;
    this.pitch = this.tPitch = this.cam0.pitch;
    this.zoom = this.cam0.zoom * 0.72;
    this.tZoom = this.cam0.zoom;
    this.dist = num(cam.distance, 1300);
    this.span = scene.span || [1400, 820];
    this.extent = num(scene.extent, 650);
    this.offY = num(scene.offsetY, 16);
    this.auto = scene.autoRotate !== false && !REDUCED;
    this.sway = scene.autoRotate === 'sway';
    var sw = scene.sway || [];
    this.swayAmp = num(sw[0], 0.38); this.swayFreq = num(sw[1], 0.16); this.swayBase = this.cam0.yaw;
    this.autoSpeed = num(scene.autoSpeed, 0.06);
    this.deco = 1; this.decoT = 1;
    this.speedK = REDUCED ? 0.55 : 1;
    this.particlesOn = true;
    this.labels = scene.labels || 'key';
    this.now = 0; this.last = 0; this.frames = 0; this.fpsT = 0; this.fps = 0;
    this.visible = false; this.running = false; this.armed = false; this.dragging = false;
    this.hover = null; this.sel = null; this.focusTags = null; this.modeTags = null;
    this.hits = []; this.labelQ = []; this.loop = 0; this.topPad = 44; this.twc = {}; this.modeIdx = 0;

    this.nodes = {}; this.nodeList = []; this.torusNodes = [];
    (scene.nodes || []).forEach(function (n) {
      var o = {};
      for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) o[k] = n[k];
      var p = n.p || [0, 0, 0];
      o.base = { x: p[0], y: p[1], z: p[2] };
      o.pos = { x: p[0], y: p[1], z: p[2] };
      o.tgt = { x: p[0], y: p[1], z: p[2] };
      o.kind = n.kind || 'sphere';
      o.r = num(n.r, 12);
      o.color = n.color || '#60a5fa';
      o.glow = 0;
      o.phase = Math.random() * TAU;
      o.orig = { color: o.color, label: o.label, sub: o.sub, state: o.state || '', inactive: !!n.inactive };
      o.inactive = !!n.inactive;
      o.vis = 1; o.visT = 1; o.orbitOn = false;
      if (typeof n.angle === 'number') { o.rad = n.angle * Math.PI / 180; self.torusNodes.push(o); }
      self.nodes[o.id] = o;
      self.nodeList.push(o);
    });

    this.edges = []; this.edgeMap = {}; this.adj = {};
    (scene.edges || []).forEach(function (e) { self.addEdge(e); });

    var tlIds = {};
    if (scene.timeline) {
      scene.timeline.phases.forEach(function (ph) { for (var id in (ph.weights || {})) tlIds[id] = true; });
    }
    this.flows = [];
    (scene.flows || []).forEach(function (f) { self.addFlow(f, !!tlIds[f.id]); });
    this.particles = []; this.bursts = [];
    this.modes = scene.modes || [];
    this.focusList = scene.focus || [];
    this.tl = scene.timeline ? { idx: 0, t: 0, playing: true } : null;

    this.buildDom();
    this.bind();
    this.applyMode(0, true);
    if (this.tl) this.applyPhase(0);
    this.fit();
  }

  Stage.prototype.addEdge = function (e) {
    var o = {
      from: e.from, to: e.to, color: e.color || null, lift: e.lift, bend: num(e.bend, 0),
      dashed: !!e.dashed, hidden: !!e.hidden, straight: !!e.straight, tags: e.tags || null,
      w: num(e.w, 1.4), alpha: num(e.alpha, 1)
    };
    this.edges.push(o);
    this.edgeMap[e.from + '>' + e.to] = o;
    if (!o.hidden) {
      (this.adj[e.from] = this.adj[e.from] || {})[e.to] = true;
      (this.adj[e.to] = this.adj[e.to] || {})[e.from] = true;
    }
    return o;
  };

  Stage.prototype.segment = function (a, b) {
    var e = this.edgeMap[a + '>' + b];
    if (e) return { e: e, dir: 1 };
    e = this.edgeMap[b + '>' + a];
    if (e) return { e: e, dir: -1 };
    return { e: this.addEdge({ from: a, to: b, hidden: true, straight: true }), dir: 1 };
  };

  Stage.prototype.addFlow = function (f, tlControlled) {
    var o = {
      id: f.id, kind: f.kind || 'path', color: f.color || '#e2e8f0', rate: num(f.rate, 1),
      speed: num(f.speed, 240), size: num(f.size, 3), tags: f.tags || null, end: f.end || 'burst', color2: f.color2 || null,
      spread: typeof f.spread === 'number' ? f.spread : null, axes: f.axes || 'yz',
      trail: num(f.trail, 5), w: 1, modeW: 1, acc: Math.random(), tlControlled: tlControlled, path: f.path || []
    };
    if (o.kind === 'path') {
      o.segs = [];
      var spreadOn = o.spread != null;
      for (var i = 0; i + 1 < o.path.length; i++) o.segs.push(this.segment(o.path[i], o.path[i + 1]));
      for (var j = 0; j < o.path.length; j++) {
        var n = this.nodes[o.path[j]];
        if (n && typeof n.spread === 'number') spreadOn = true;
      }
      o.spreadOn = spreadOn;
    } else if (o.kind === 'knot') {
      o.R = num(f.R, 240); o.r = num(f.r, 60); o.p = num(f.p, 1); o.q = num(f.q, 5);
      o.phase = num(f.phase, 0); o.c = f.center || [0, 0, 0]; o.uSpeed = num(f.uSpeed, 0.04);
      o.items = [];
      var count = num(f.count, 18);
      for (var k = 0; k < count; k++) o.items.push({ u: k / count });
    }
    this.flows.push(o);
  };

  // ---------------------------------------------------------------- geometry
  Stage.prototype.anchor = function (n) {
    if (n.kind === 'cube' || n.kind === 'slab') return { x: n.pos.x, y: n.pos.y, z: n.pos.z + num(n.h, 40) };
    return n.pos;
  };

  Stage.prototype.ctrl = function (e) {
    var a = this.anchor(this.nodes[e.from]), b = this.anchor(this.nodes[e.to]);
    if (e.straight) return { a: a, b: b, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } };
    var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var lift = e.lift == null ? len * 0.14 : e.lift;
    var hl = Math.sqrt(dx * dx + dy * dy) || 1;
    var bx = -dy / hl * e.bend * len, by = dx / hl * e.bend * len;
    return { a: a, b: b, c: { x: (a.x + b.x) / 2 + bx, y: (a.y + b.y) / 2 + by, z: (a.z + b.z) / 2 + lift } };
  };

  Stage.prototype.geo = function (e) { return e.g || (e.g = this.ctrl(e)); };

  Stage.prototype.segLen = function (sg) {
    var g = this.geo(sg.e), prev = g.a, len = 0;
    for (var i = 1; i <= 8; i++) { var p = bez(g, i / 8); len += d3(prev, p); prev = p; }
    return Math.max(20, len);
  };

  Stage.prototype.spreadOf = function (n, f) {
    return n && typeof n.spread === 'number' ? n.spread : (f.spread || 0);
  };

  Stage.prototype.ppos = function (pt) {
    var sg = pt.f.segs[pt.i];
    var p = bez(this.geo(sg.e), sg.dir > 0 ? pt.t : 1 - pt.t);
    if (pt.off) {
      var s = lerp(this.spreadOf(this.nodes[pt.f.path[pt.i]], pt.f), this.spreadOf(this.nodes[pt.f.path[pt.i + 1]], pt.f), pt.t);
      if (pt.f.axes === 'xy') { p.x += pt.off[0] * s; p.y += pt.off[1] * s; }
      else { p.y += pt.off[0] * s; p.z += pt.off[1] * s; }
    }
    return p;
  };

  Stage.prototype.knotPos = function (f, u) {
    var phi = f.p * u * TAU, th = f.q * u * TAU + f.phase * TAU;
    var rr = f.R + f.r * Math.cos(th);
    return { x: f.c[0] + rr * Math.cos(phi), y: f.c[1] + rr * Math.sin(phi), z: f.c[2] + f.r * Math.sin(th) };
  };

  Stage.prototype.project = function (p) {
    var x1 = p.x * this.cy - p.y * this.sy;
    var y1 = p.x * this.sy + p.y * this.cy;
    var depth = y1 * this.cp - p.z * this.sp;
    var vert = y1 * this.sp + p.z * this.cp;
    var s = Math.max(0.2, this.dist / (this.dist + depth + 200)) * this.zoom * this.fitS;
    return { x: this.W / 2 + x1 * s, y: this.H / 2 - vert * s + this.offY, d: depth, s: s };
  };

  Stage.prototype.nd = function (depth) { return clamp((depth + this.extent) / (2 * this.extent), 0, 1); };

  Stage.prototype.circlePts = function (c, r, U, V, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = i / n * TAU, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      pts.push(this.project({ x: c.x + U[0] * ca + V[0] * sa, y: c.y + U[1] * ca + V[1] * sa, z: c.z + U[2] * ca + V[2] * sa }));
    }
    return pts;
  };

  Stage.prototype.strokeDepth = function (pts, col, baseA, width) {
    var c = this.ctx, buckets = [[], [], [], []];
    for (var i = 1; i < pts.length; i++) {
      var b = Math.min(3, Math.floor(this.nd((pts[i].d + pts[i - 1].d) / 2) * 4));
      buckets[b].push(pts[i - 1], pts[i]);
    }
    c.lineWidth = width;
    for (var k = 0; k < 4; k++) {
      var arr = buckets[k];
      if (!arr.length) continue;
      c.strokeStyle = rgba(col, baseA * (1 - k * 0.24));
      c.beginPath();
      for (var j = 0; j < arr.length; j += 2) { c.moveTo(arr[j].x, arr[j].y); c.lineTo(arr[j + 1].x, arr[j + 1].y); }
      c.stroke();
    }
  };

  // ---------------------------------------------------------------- DOM chrome
  Stage.prototype.buildDom = function () {
    var self = this, r = this.root, sc = this.sc;
    r.innerHTML = '';
    r.classList.add('s3-on');
    this.cv = el('canvas');
    r.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');

    var head = el('div', 's3-head');
    head.appendChild(el('div', 's3-title', '<b>' + esc(sc.title || '') + '</b>' + (sc.subtitle ? '<span>' + esc(sc.subtitle) + '</span>' : '')));
    function seg(labels, onPick) {
      var box = el('div', 's3-seg');
      labels.forEach(function (lb, i) {
        var b = el('button', i === 0 ? 'on' : '', esc(lb));
        b.type = 'button';
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          Array.prototype.forEach.call(box.children, function (x, j) { x.classList.toggle('on', j === i); });
          onPick(i);
        });
        box.appendChild(b);
      });
      return box;
    }
    if (this.modes.length > 1) head.appendChild(seg(this.modes.map(function (m) { return m.label; }), function (i) { self.applyMode(i); }));
    if (this.focusList.length) head.appendChild(seg(this.focusList.map(function (f) { return f.label; }), function (i) { self.setFocus(i); }));
    r.appendChild(head);
    this.head = head;

    var tools = el('div', 's3-tools');
    function tool(icon, title, on, fn) {
      var b = el('button', on ? 'on' : '', icon);
      b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(b); });
      tools.appendChild(b);
      return b;
    }
    if (this.tl) {
      this.btnPlay = tool('❚❚', '暂停 / 播放时间轴', true, function (b) {
        self.tl.playing = !self.tl.playing;
        b.innerHTML = self.tl.playing ? '❚❚' : '▶';
        b.classList.toggle('on', self.tl.playing);
        self.renderHud(true);
      });
      if (typeof sc.timeline.inject === 'number') tool('⚡', sc.timeline.injectLabel || '注入故障', false, function () { self.applyPhase(sc.timeline.inject); });
      tool('↺', '从头播放', false, function () { self.applyPhase(0); });
    }
    tool('⟳', this.sway ? '自动摆动视角' : '自动旋转', this.auto, function (b) {
      self.auto = !self.auto; b.classList.toggle('on', self.auto);
      if (self.auto && self.sway) { self.swayBase = self.tYaw; self.swayT0 = self.now; }
    });
    tool('✦', '粒子流', true, function (b) { self.particlesOn = !self.particlesOn; if (!self.particlesOn) self.particles = []; b.classList.toggle('on', self.particlesOn); });
    tool('⌖', '复位视角', false, function () { self.resetView(); });
    this.btnFs = tool('⛶', '全屏', false, function () { self.toggleFullscreen(); });
    r.appendChild(tools);
    this.toolsEl = tools;
    if (sc.kpis && sc.kpis.length && !this.tl) {
      var kp = el('div', 's3-kpi');
      sc.kpis.forEach(function (k) { kp.appendChild(el('div', '', '<b style="color:' + (k[2] || '#e2e8f0') + '">' + esc(k[1]) + '</b><span>' + esc(k[0]) + '</span>')); });
      r.appendChild(kp);
      this.kpi = kp;
    }
    if (this.tl) r.classList.add('s3-has-hud');

    if (sc.legend && sc.legend.length) {
      var lg = el('div', 's3-legend');
      sc.legend.forEach(function (it) { lg.appendChild(el('span', '', '<i style="background:' + it[1] + ';color:' + it[1] + '"></i>' + esc(it[0]))); });
      r.appendChild(lg);
      this.legend = lg;
    }
    if (this.tl) { this.hud = el('div', 's3-hud'); r.appendChild(this.hud); }
    this.note = el('div', 's3-note'); r.appendChild(this.note);
    this.info = el('div', 's3-info'); r.appendChild(this.info);
    this.foot = el('div', 's3-foot'); r.appendChild(this.foot);
    this.tip = el('div', 's3-tip'); r.appendChild(this.tip);
  };

  Stage.prototype.bind = function () {
    var self = this, cv = this.cv;
    cv.addEventListener('pointerdown', function (ev) {
      self.dragging = true; self.moved = 0; self.px = ev.clientX; self.py = ev.clientY; self.ptype = ev.pointerType;
      self.armed = true; self.root.classList.add('s3-armed', 's3-drag');
      if (ev.pointerType === 'mouse') { try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    });
    cv.addEventListener('pointermove', function (ev) {
      var rect = cv.getBoundingClientRect();
      if (self.dragging) {
        var dx = ev.clientX - self.px, dy = ev.clientY - self.py;
        self.px = ev.clientX; self.py = ev.clientY;
        self.moved += Math.abs(dx) + Math.abs(dy);
        self.tYaw += dx * 0.0065;
        self.swayBase += dx * 0.0065;
        if (self.ptype === 'mouse') self.tPitch = clamp(self.tPitch + dy * 0.0045, 0.02, 1.35);
        self.hideTip();
      } else {
        self.hoverAt(ev.clientX - rect.left, ev.clientY - rect.top);
      }
    });
    function up(ev) {
      if (!self.dragging) return;
      self.dragging = false;
      self.root.classList.remove('s3-drag');
      if (self.moved < 6) {
        var rect = cv.getBoundingClientRect();
        self.clickAt(ev.clientX - rect.left, ev.clientY - rect.top);
      }
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', function () { self.dragging = false; self.root.classList.remove('s3-drag'); });
    cv.addEventListener('pointerleave', function () {
      self.hover = null; self.hideTip();
      if (!self.dragging) { self.armed = false; self.root.classList.remove('s3-armed'); }
    });
    cv.addEventListener('wheel', function (ev) {
      if (!self.armed) return;
      ev.preventDefault();
      self.tZoom = clamp(self.tZoom * (ev.deltaY > 0 ? 0.92 : 1.08), 0.45, 2.6);
    }, { passive: false });
    cv.addEventListener('dblclick', function () { self.resetView(); });
    if (window.ResizeObserver) new ResizeObserver(function () { self.fit(); }).observe(this.root);
    else window.addEventListener('resize', function () { self.fit(); });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        self.visible = entries[entries.length - 1].isIntersecting;
        self.updateRun();
      }, { threshold: 0.04 }).observe(this.root);
    } else { this.visible = true; }
    document.addEventListener('visibilitychange', function () { self.updateRun(); });
    document.addEventListener('fullscreenchange', function () {
      var fs = document.fullscreenElement === self.root;
      self.root.classList.toggle('s3-fs', fs);
      if (self.btnFs) self.btnFs.classList.toggle('on', fs);
      setTimeout(function () { self.fit(); }, 30);
    });
    this.updateRun();
  };

  Stage.prototype.fit = function () {
    var rect = this.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = rect.width; this.H = rect.height;
    this.cv.width = Math.round(rect.width * dpr);
    this.cv.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fitS = Math.min(this.W / this.span[0], this.H / this.span[1]);
    if (this.head && this.toolsEl) {
      this.head.style.right = (this.toolsEl.offsetWidth + 26) + 'px';
      this.topPad = Math.max(40, this.head.offsetTop + this.head.offsetHeight + 8);
    }
    if (!this.running) this.render();
  };

  Stage.prototype.updateRun = function () {
    var want = this.visible && !document.hidden;
    var self = this;
    if (want && !this.running) {
      this.running = true;
      this.last = 0;
      var id = ++this.loop;
      requestAnimationFrame(function (ts) { self.frame(ts, id); });
    } else if (!want) {
      this.running = false;
    }
  };

  Stage.prototype.toggleFullscreen = function () {
    var r = this.root;
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
    else if (r.requestFullscreen) r.requestFullscreen();
    else if (r.webkitRequestFullscreen) r.webkitRequestFullscreen();
  };

  Stage.prototype.resetView = function () {
    this.tYaw = this.cam0.yaw; this.tPitch = this.cam0.pitch; this.tZoom = this.cam0.zoom;
    this.swayBase = this.cam0.yaw; this.swayT0 = this.now;
    this.sel = null; this.showInfo(null);
  };

  Stage.prototype.applyMode = function (i, instant) {
    var m = this.modes[i] || {};
    this.modeIdx = i;
    var pos = m.pos || {};
    for (var k = 0; k < this.nodeList.length; k++) {
      var n = this.nodeList[k], p = pos[n.id];
      n.tgt = p ? { x: p[0], y: p[1], z: p[2] } : { x: n.base.x, y: n.base.y, z: n.base.z };
      n.orbitOn = !!n.orbit && !p && m.orbit !== false;
      if (n.orbitOn) n.tgt = this.orbitPos(n);
      if (instant) n.pos = { x: n.tgt.x, y: n.tgt.y, z: n.tgt.z };
      n.modeOff = !!(m.inactive && m.inactive.indexOf(n.id) >= 0);
      n.visT = (m.hide && m.hide.indexOf(n.id) >= 0) ? 0 : 1;
      if (instant) n.vis = n.visT;
    }
    var fw = m.flows || {};
    for (var j = 0; j < this.flows.length; j++) {
      var f = this.flows[j];
      f.modeW = Object.prototype.hasOwnProperty.call(fw, f.id) ? fw[f.id] : 1;
    }
    this.modeTags = m.tags || null;
    this.decoT = m.deco === false ? 0 : 1;
    if (instant) this.deco = this.decoT;
    if (m.camera) {
      if (typeof m.camera.pitch === 'number') this.tPitch = m.camera.pitch;
      if (typeof m.camera.zoom === 'number') this.tZoom = m.camera.zoom;
    }
    var note = m.note || this.sc.note || '';
    if (this.note) { this.note.innerHTML = note; this.note.style.display = note ? '' : 'none'; this.obst = null; }
  };

  Stage.prototype.setFocus = function (i) {
    var f = this.focusList[i] || {};
    this.focusTags = f.tags || null;
    if (f.camera) {
      if (typeof f.camera.yaw === 'number') this.tYaw = f.camera.yaw + Math.round((this.tYaw - f.camera.yaw) / TAU) * TAU;
      if (typeof f.camera.pitch === 'number') this.tPitch = f.camera.pitch;
      if (typeof f.camera.zoom === 'number') this.tZoom = f.camera.zoom;
    }
    if (this.note && (f.note || this.sc.note)) { this.note.innerHTML = f.note || (this.modes[this.modeIdx] || {}).note || this.sc.note || ''; this.note.style.display = ''; }
  };

  Stage.prototype.orbitPos = function (n) {
    var o = n.orbit, a = num(o.phase, 0) + this.now * num(o.speed, 0.1);
    var c = o.c || [0, 0, 0], R = num(o.R, 200), tilt = num(o.tilt, 0), yw = num(o.yaw, 0);
    var ux = Math.cos(yw), uy = Math.sin(yw);
    var ct = Math.cos(tilt), st = Math.sin(tilt);
    var vx = -uy * ct, vy = ux * ct, vz = st;
    var ca = Math.cos(a) * R, sa = Math.sin(a) * R;
    return { x: c[0] + ux * ca + vx * sa, y: c[1] + uy * ca + vy * sa, z: c[2] + vz * sa };
  };

  Stage.prototype.applyPhase = function (i) {
    var tl = this.tl, ph = this.sc.timeline.phases[i];
    tl.idx = i; tl.t = 0;
    for (var k = 0; k < this.nodeList.length; k++) {
      var n = this.nodeList[k];
      n.color = n.orig.color; n.label = n.orig.label; n.sub = n.orig.sub; n.state = n.orig.state; n.inactive = n.orig.inactive;
    }
    var ov = ph.nodes || {};
    for (var id in ov) {
      var nn = this.nodes[id];
      if (!nn) continue;
      for (var key in ov[id]) nn[key] = ov[id][key];
      nn.glow = Math.max(nn.glow, 0.9);
    }
    var w = ph.weights || {};
    for (var j = 0; j < this.flows.length; j++) {
      var f = this.flows[j];
      if (Object.prototype.hasOwnProperty.call(w, f.id)) f.w = w[f.id];
      else f.w = f.tlControlled ? 0 : 1;
    }
    this.renderHud(true);
  };

  // ---------------------------------------------------------------- simulation
  Stage.prototype.frame = function (ts, id) {
    if (!this.running || id !== this.loop) return;
    var self = this;
    var dt = this.last ? Math.min(0.05, (ts - this.last) / 1000) : 0.016;
    this.last = ts;
    this.step(dt);
    this.render();
    this.frames++;
    if (!this.fpsT) this.fpsT = ts;
    if (ts - this.fpsT > 600) {
      this.fps = Math.round(this.frames * 1000 / (ts - this.fpsT));
      this.frames = 0; this.fpsT = ts;
      this.updateFoot();
    }
    requestAnimationFrame(function (t) { self.frame(t, id); });
  };

  Stage.prototype.step = function (dt) {
    this.now += dt;
    if (this.auto && !this.dragging) {
      if (this.sway) this.tYaw = this.swayBase + this.swayAmp * Math.sin((this.now - (this.swayT0 || 0)) * this.swayFreq * TAU);
      else this.tYaw += this.autoSpeed * dt;
    }
    this.deco += (this.decoT - this.deco) * (1 - Math.exp(-dt * 3));
    var cvs = this.sc.curves;
    if (cvs) for (var ci = 0; ci < cvs.length; ci++) {
      var cv = cvs[ci];
      if (cv.mode == null) continue;
      var want = this.modeIdx === cv.mode ? 1 : 0;
      cv._v = cv._v == null ? want : cv._v + (want - cv._v) * (1 - Math.exp(-dt * 3));
    }
    var k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;
    this.zoom += (this.tZoom - this.zoom) * (1 - Math.exp(-dt * 3.2));
    var kn = 1 - Math.exp(-dt * 3.6), decay = Math.exp(-dt * 2.4);
    for (var i = 0; i < this.nodeList.length; i++) {
      var n = this.nodeList[i];
      if (n.orbitOn) n.tgt = this.orbitPos(n);
      n.vis += (n.visT - n.vis) * kn;
      n.pos.x += (n.tgt.x - n.pos.x) * kn;
      n.pos.y += (n.tgt.y - n.pos.y) * kn;
      n.pos.z += (n.tgt.z - n.pos.z) * kn;
      n.glow *= decay;
    }
    if (this.tl && this.tl.playing) {
      var ph = this.sc.timeline.phases[this.tl.idx];
      this.tl.t += dt;
      if (this.tl.t >= ph.dur) this.applyPhase((this.tl.idx + 1) % this.sc.timeline.phases.length);
    }
    for (var j = 0; j < this.edges.length; j++) this.edges[j].g = this.ctrl(this.edges[j]);
    this.stepParticles(dt);
    for (var b = this.bursts.length - 1; b >= 0; b--) if (this.now - this.bursts[b].t0 > 0.75) this.bursts.splice(b, 1);
  };

  Stage.prototype.flowLit = function (f) {
    return matchTags(f.tags, this.focusTags) && matchTags(f.tags, this.modeTags);
  };

  Stage.prototype.stepParticles = function (dt) {
    var i, f;
    if (this.particlesOn) {
      for (i = 0; i < this.flows.length; i++) {
        f = this.flows[i];
        if (f.kind !== 'path' || !f.segs.length) continue;
        var rate = f.rate * f.w * f.modeW * (this.flowLit(f) ? 1 : 0.12);
        f.acc = Math.min(3, f.acc + rate * dt * this.speedK);
        while (f.acc >= 1 && this.particles.length < MAX_PARTICLES) { f.acc -= 1; this.spawn(f); }
      }
    }
    for (i = this.particles.length - 1; i >= 0; i--) {
      var pt = this.particles[i];
      pt.t += pt.f.speed * pt.jit * this.speedK * dt / pt.len;
      var done = false;
      while (pt.t >= 1) {
        pt.t -= 1;
        pt.i++;
        var last = pt.i >= pt.f.segs.length;
        var node = this.nodes[pt.f.path[pt.i]];
        if (node) node.glow = Math.min(1.8, node.glow + (last ? 0.42 : 0.14));
        if (last) { done = true; break; }
        pt.len = this.segLen(pt.f.segs[pt.i]);
      }
      if (done) { this.finish(pt); this.particles.splice(i, 1); continue; }
      pt.hist.push(this.ppos(pt));
      if (pt.hist.length > pt.f.trail) pt.hist.shift();
    }
    if (!this.particlesOn) return;
    for (i = 0; i < this.flows.length; i++) {
      f = this.flows[i];
      if (f.kind !== 'knot') continue;
      for (var k = 0; k < f.items.length; k++) {
        var it = f.items[k];
        it.u = (it.u + f.uSpeed * dt * this.speedK) % 1;
        var phi = ((f.p * it.u * TAU) % TAU + TAU) % TAU;
        for (var q = 0; q < this.torusNodes.length; q++) {
          var tn = this.torusNodes[q];
          var dphi = Math.abs(((phi - tn.rad + Math.PI) % TAU + TAU) % TAU - Math.PI);
          if (dphi < 0.05) tn.glow = Math.min(1.8, tn.glow + 0.05);
        }
      }
    }
  };

  Stage.prototype.spawn = function (f) {
    var off = null;
    if (f.spreadOn) {
      var a = Math.random() * TAU, r = Math.sqrt(Math.random());
      off = [Math.cos(a) * r, Math.sin(a) * r];
    }
    var pt = { f: f, i: 0, t: 0, off: off, hist: [], jit: 0.82 + Math.random() * 0.36 };
    pt.len = this.segLen(f.segs[0]);
    this.particles.push(pt);
  };

  Stage.prototype.finish = function (pt) {
    if (pt.f.end === 'none' || !pt.hist.length) return;
    this.bursts.push({ p: pt.hist[pt.hist.length - 1], col: pt.f.color2 || pt.f.color, t0: this.now, big: pt.f.end === 'drop' });
  };

  // ---------------------------------------------------------------- rendering
  Stage.prototype.render = function () {
    var c = this.ctx;
    if (!c || !this.W) return;
    this.cy = Math.cos(this.yaw); this.sy = Math.sin(this.yaw);
    this.cp = Math.cos(this.pitch); this.sp = Math.sin(this.pitch);
    this.hits = []; this.labelQ = [];
    this.drawBg();
    this.drawGrid();
    this.drawGlobe();
    this.drawCurves();
    this.drawPlanes();
    this.drawTorus();
    this.drawEdges();
    if (!this.sc.particlesOnTop) this.drawParticles();
    this.drawNodes();
    if (this.sc.particlesOnTop) this.drawParticles();
    this.drawBursts();
    this.drawLabels();
    if (this.tl) this.renderHud(false);
  };

  Stage.prototype.drawBg = function () {
    var c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    var g = c.createRadialGradient(W * 0.55, H * 0.42, 10, W * 0.55, H * 0.42, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(44,128,214,0.16)');
    g.addColorStop(0.5, 'rgba(12,44,88,0.06)');
    g.addColorStop(1, 'rgba(2,6,12,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    for (var i = 0; i < 70; i++) {
      var x = (i * 193.7 + this.now * 6 * (i % 3 + 1)) % W;
      var y = (i * 97.3 + 43 + i * i * 0.37) % H;
      var tw = 0.5 + 0.5 * Math.sin(this.now * 1.7 + i);
      c.fillStyle = 'rgba(140,205,255,' + (0.05 + (i % 7) * 0.014 + tw * 0.05).toFixed(3) + ')';
      c.fillRect(x, y, i % 11 === 0 ? 2 : 1, i % 11 === 0 ? 2 : 1);
    }
  };

  Stage.prototype.drawGrid = function () {
    var gd = this.sc.grid;
    if (!gd) return;
    var c = this.ctx, S = num(gd.size, 700), st = num(gd.step, 70), z = num(gd.z, 0), col = gd.color || '#3b82f6', ba = num(gd.alpha, 0.1);
    c.lineWidth = 1;
    for (var v = -S; v <= S + 0.1; v += st) {
      var a1 = this.project({ x: -S, y: v, z: z }), b1 = this.project({ x: S, y: v, z: z });
      var a2 = this.project({ x: v, y: -S, z: z }), b2 = this.project({ x: v, y: S, z: z });
      c.strokeStyle = rgba(col, ba * (1 - 0.7 * this.nd((a1.d + b1.d) / 2)));
      c.beginPath(); c.moveTo(a1.x, a1.y); c.lineTo(b1.x, b1.y); c.stroke();
      c.strokeStyle = rgba(col, ba * (1 - 0.7 * this.nd((a2.d + b2.d) / 2)));
      c.beginPath(); c.moveTo(a2.x, a2.y); c.lineTo(b2.x, b2.y); c.stroke();
    }
  };

  Stage.prototype.drawGlobe = function () {
    var G = this.sc.globe;
    if (!G || this.deco < 0.02) return;
    var c = this.ctx, R = num(G.R, 300), col = G.color || '#60a5fa', al = num(G.alpha, 0.16) * this.deco;
    var c0 = G.center ? { x: G.center[0], y: G.center[1], z: G.center[2] } : { x: 0, y: 0, z: 0 };
    var lat = num(G.lat, 6), lon = num(G.lon, 8), spin = this.now * num(G.spin, 0.05);
    var cp = this.project(c0), rs = R * cp.s;
    var g = c.createRadialGradient(cp.x, cp.y, rs * 0.15, cp.x, cp.y, rs * 1.2);
    g.addColorStop(0, rgba(col, 0.07 * this.deco));
    g.addColorStop(0.8, rgba(col, 0.04 * this.deco));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.beginPath(); c.arc(cp.x, cp.y, rs * 1.2, 0, TAU); c.fill();
    for (var i = 1; i < lat; i++) {
      var th = -Math.PI / 2 + i * Math.PI / lat;
      this.strokeDepth(this.circlePts({ x: c0.x, y: c0.y, z: c0.z + R * Math.sin(th) }, R * Math.cos(th), [1, 0, 0], [0, 1, 0], 72), col, al, 1);
    }
    for (var j = 0; j < lon; j++) {
      var ph = spin + j * Math.PI / lon;
      this.strokeDepth(this.circlePts(c0, R, [Math.cos(ph), Math.sin(ph), 0], [0, 0, 1], 72), col, al, 1);
    }
  };

  Stage.prototype.drawCurves = function () {
    var cs = this.sc.curves;
    if (!cs) return;
    for (var i = 0; i < cs.length; i++) {
      var cv = cs[i], pts = [];
      var vis = cv.mode == null ? this.deco : (cv._v == null ? (this.modeIdx === cv.mode ? 1 : 0) : cv._v);
      if (vis < 0.02) continue;
      for (var k = 0; k < cv.pts.length; k++) pts.push(this.project({ x: cv.pts[k][0], y: cv.pts[k][1], z: cv.pts[k][2] }));
      var w = num(cv.width, 1.2);
      this.strokeDepth(pts, cv.color || '#60a5fa', num(cv.glow, 0.08) * vis, w + 7);
      this.strokeDepth(pts, cv.color || '#60a5fa', num(cv.alpha, 0.5) * vis, w);
    }
  };

  Stage.prototype.drawPlanes = function () {
    var c = this.ctx;
    for (var i = 0; i < this.nodeList.length; i++) {
      var n = this.nodeList[i];
      if (n.kind !== 'plane') continue;
      var w = num(n.w, 800) / 2, d = num(n.d, 400) / 2, P = n.pos;
      var q = [
        this.project({ x: P.x - w, y: P.y - d, z: P.z }), this.project({ x: P.x + w, y: P.y - d, z: P.z }),
        this.project({ x: P.x + w, y: P.y + d, z: P.z }), this.project({ x: P.x - w, y: P.y + d, z: P.z })
      ];
      var a = this.nodeAlpha(n);
      if (a < 0.02) continue;
      c.beginPath(); c.moveTo(q[0].x, q[0].y); for (var k = 1; k < 4; k++) c.lineTo(q[k].x, q[k].y); c.closePath();
      c.fillStyle = rgba(n.color, (0.055 + n.glow * 0.03) * a); c.fill();
      c.setLineDash([5, 6]); c.strokeStyle = rgba(n.color, 0.5 * a); c.lineWidth = 1.2; c.stroke(); c.setLineDash([]);
      var lp = q[0];
      for (var qi = 1; qi < 4; qi++) if (q[qi].x < lp.x) lp = q[qi];
      if (n.vis > 0.3) {
        this.labelQ.push({ n: n, x: lp.x, y: lp.y, R: 0, side: 'plane', pri: 1, a: a, d: lp.d });
        var cp = this.project(P);
        this.hits.push({ n: n, x: cp.x, y: cp.y, r: 30, d: cp.d + 400 });
      }
    }
  };

  Stage.prototype.drawTorus = function () {
    var T = this.sc.torus;
    if (!T || this.deco < 0.02) return;
    var c = this.ctx, R = T.R, r = T.r, col = T.color || '#60a5fa', C = { x: 0, y: 0, z: 0 }, dk = this.deco;
    var tubes = num(T.tubes, 14), rings = num(T.rings, 40);
    // soft band along the core circle
    var band = this.circlePts(C, R, [1, 0, 0], [0, 1, 0], 96);
    this.strokeDepth(band, col, 0.10 * dk, Math.max(6, r * this.fitS * this.zoom * 1.4));
    for (var k = 0; k < tubes; k++) {
      var th = k / tubes * TAU;
      this.strokeDepth(this.circlePts({ x: 0, y: 0, z: r * Math.sin(th) }, R + r * Math.cos(th), [1, 0, 0], [0, 1, 0], 96), col, 0.34 * dk, 1);
    }
    for (var j = 0; j < rings; j++) {
      var ph = j / rings * TAU;
      var U = [Math.cos(ph), Math.sin(ph), 0];
      this.strokeDepth(this.circlePts({ x: R * U[0], y: R * U[1], z: 0 }, r, U, [0, 0, 1], 28), col, 0.3 * dk, 1);
    }
  };

  Stage.prototype.edgeAlpha = function (e) {
    var a = e.alpha;
    if (!matchTags(e.tags, this.focusTags) || !matchTags(e.tags, this.modeTags)) a *= 0.1;
    if (this.sel) a *= (e.from === this.sel.id || e.to === this.sel.id) ? 1.6 : 0.3;
    var fn = this.nodes[e.from], tn = this.nodes[e.to];
    if ((fn && (fn.inactive || fn.modeOff)) || (tn && (tn.inactive || tn.modeOff))) a *= 0.35;
    if (fn && tn) a *= Math.min(fn.vis, tn.vis);
    return a;
  };

  Stage.prototype.drawEdges = function () {
    var c = this.ctx;
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (e.hidden) continue;
      var a = this.edgeAlpha(e);
      if (a < 0.02) continue;
      var g = this.geo(e), pts = [];
      for (var k = 0; k <= 20; k++) pts.push(this.project(bez(g, k / 20)));
      var col = e.color || this.nodes[e.from].color;
      var ws = clamp((pts[0].s + pts[20].s) / 2 / this.fitS, 0.5, 1.7);
      c.beginPath();
      for (var j = 0; j < pts.length; j++) { if (j) c.lineTo(pts[j].x, pts[j].y); else c.moveTo(pts[j].x, pts[j].y); }
      c.strokeStyle = rgba(col, 0.07 * a); c.lineWidth = (e.w + 6) * ws; c.stroke();
      if (e.dashed) c.setLineDash([6, 6]);
      c.strokeStyle = rgba(col, 0.36 * a); c.lineWidth = e.w * ws; c.stroke();
      if (e.dashed) c.setLineDash([]);
    }
  };

  Stage.prototype.particleAlpha = function (pt) {
    var a = this.flowLit(pt.f) ? 1 : 0.14;
    if (this.sel && pt.f.path.indexOf(this.sel.id) < 0) a *= 0.3;
    return a;
  };

  Stage.prototype.drawGlowDot = function (p, r, col, a) {
    var c = this.ctx;
    var g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.95 * a).toFixed(3) + ')');
    g.addColorStop(0.22, rgba(col, 0.95 * a));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(p.x, p.y, r * 3.2, 0, TAU); c.fill();
  };

  Stage.prototype.drawParticles = function () {
    var c = this.ctx, i, k;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < this.particles.length; i++) {
      var pt = this.particles[i], h = pt.hist;
      if (!h.length) continue;
      var a = this.particleAlpha(pt);
      if (a < 0.02) continue;
      var col = pt.f.color2 ? mixHex(pt.f.color, pt.f.color2, (pt.i + pt.t) / pt.f.segs.length) : pt.f.color;
      for (k = 0; k < h.length - 1; k++) {
        var tp = this.project(h[k]), fr = (k + 1) / h.length;
        c.fillStyle = rgba(col, a * 0.3 * fr);
        c.beginPath(); c.arc(tp.x, tp.y, Math.max(0.8, pt.f.size * tp.s * 0.7 * fr), 0, TAU); c.fill();
      }
      var p = this.project(h[h.length - 1]);
      this.drawGlowDot(p, clamp(pt.f.size * p.s * 1.25, 1.4, 7), col, a);
    }
    if (!this.particlesOn) { c.restore(); return; }
    for (i = 0; i < this.flows.length; i++) {
      var f = this.flows[i];
      if (f.kind !== 'knot') continue;
      var fa = this.flowLit(f) ? 1 : 0.14;
      for (var q = 0; q < f.items.length; q++) {
        var u = f.items[q].u;
        for (k = 12; k >= 1; k--) {
          var tp2 = this.project(this.knotPos(f, u - k * 0.0028)), fr2 = 1 - k / 13;
          c.fillStyle = rgba(f.color, fa * 0.34 * fr2);
          c.beginPath(); c.arc(tp2.x, tp2.y, Math.max(0.6, f.size * tp2.s * 0.6 * fr2), 0, TAU); c.fill();
        }
        var hp = this.project(this.knotPos(f, u));
        this.drawGlowDot(hp, clamp(f.size * hp.s * 1.25, 1.4, 7), f.color, fa);
      }
    }
    c.restore();
  };

  Stage.prototype.drawBursts = function () {
    var c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.bursts.length; i++) {
      var b = this.bursts[i], fr = (this.now - b.t0) / 0.75, p = this.project(b.p);
      var rr = (b.big ? 22 : 12) * fr * clamp(p.s / this.fitS, 0.5, 1.6) + 2;
      c.strokeStyle = rgba(b.col, (1 - fr) * 0.9);
      c.lineWidth = b.big ? 2 : 1.3;
      c.beginPath(); c.arc(p.x, p.y, rr, 0, TAU); c.stroke();
      if (b.big) { c.fillStyle = rgba(b.col, (1 - fr) * 0.22); c.fill(); }
    }
    c.restore();
  };

  Stage.prototype.nodeAlpha = function (n) {
    var a = 1;
    if (!matchTags(n.tags, this.focusTags)) a *= 0.2;
    if (this.sel && n !== this.sel && !(this.adj[this.sel.id] && this.adj[this.sel.id][n.id])) a *= 0.45;
    if (n.inactive || n.modeOff) a *= 0.32;
    return a * n.vis;
  };

  Stage.prototype.wantLabel = function (n) {
    if (n === this.sel || n === this.hover) return 3;
    if (n.lab === false) return 0;
    if (n.lab === true) return 2;
    if (this.labels === 'all') return 1;
    return (n.kind === 'core' || n.kind === 'ring' || n.kind === 'cube' || n.kind === 'slab') ? 1 : 0;
  };

  Stage.prototype.drawNodes = function () {
    var list = [];
    for (var i = 0; i < this.nodeList.length; i++) {
      var n = this.nodeList[i];
      if (n.kind === 'anchor' || n.kind === 'plane' || n.hidden || n.vis < 0.02) continue;
      var cz = (n.kind === 'cube' || n.kind === 'slab') ? n.pos.z + num(n.h, 40) / 2 : n.pos.z;
      var p = this.project({ x: n.pos.x, y: n.pos.y, z: cz });
      list.push({ n: n, p: p });
    }
    list.sort(function (a, b) { return b.p.d - a.p.d; });
    for (var j = 0; j < list.length; j++) {
      var it = list[j], nn = it.n;
      if (nn.kind === 'label') this.drawTag(nn, it.p);
      else if (nn.kind === 'ring') this.drawRing(nn, it.p);
      else if (nn.kind === 'cube' || nn.kind === 'slab') this.drawCube(nn, it.p);
      else if (nn.kind === 'core') this.drawCore(nn, it.p);
      else this.drawSphere(nn, it.p);
    }
  };

  Stage.prototype.drawSphere = function (n, p) {
    var c = this.ctx, col = n.color, a = this.nodeAlpha(n);
    var R = clamp(n.r * p.s, 3, 64);
    var pulse = 1 + Math.sin(this.now * 2 + n.phase) * 0.05;
    var hal = R * (2.1 + n.glow * 0.9) * pulse;
    c.save();
    c.globalAlpha = a;
    var hg = c.createRadialGradient(p.x, p.y, R * 0.3, p.x, p.y, hal);
    hg.addColorStop(0, rgba(col, 0.2 + n.glow * 0.14));
    hg.addColorStop(0.5, rgba(col, 0.07));
    hg.addColorStop(1, rgba(col, 0));
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = hg; c.beginPath(); c.arc(p.x, p.y, hal, 0, TAU); c.fill();
    c.globalCompositeOperation = 'source-over';
    var sg = c.createRadialGradient(p.x - R * 0.35, p.y - R * 0.42, R * 0.08, p.x, p.y, R);
    sg.addColorStop(0, 'rgba(255,255,255,0.98)');
    sg.addColorStop(0.18, rgba(col, 0.98));
    sg.addColorStop(0.7, rgba(col, 0.72));
    sg.addColorStop(1, rgba(col, 0.2));
    c.shadowColor = rgba(col, 0.8); c.shadowBlur = 10 + n.glow * 10;
    c.fillStyle = sg; c.beginPath(); c.arc(p.x, p.y, R, 0, TAU); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = rgba(col, 0.8); c.lineWidth = 1; c.stroke();
    this.drawMarks(n, p, R);
    c.restore();
    if (n.vis < 0.3) return;
    this.hits.push({ n: n, x: p.x, y: p.y, r: Math.max(10, R + 4), d: p.d });
    var wl = this.wantLabel(n);
    if (wl) this.labelQ.push({ n: n, x: p.x, y: p.y, R: R, side: n.side || 'sphere', pri: wl, a: a, d: p.d });
  };

  Stage.prototype.drawTag = function (n, p) {
    var a = this.nodeAlpha(n);
    if (a < 0.05) return;
    this.labelQ.push({ n: n, x: p.x, y: p.y, R: 0, side: n.side || 'center', pri: 2.5, a: a, d: p.d });
  };

  Stage.prototype.drawMarks = function (n, p, R) {
    var c = this.ctx;
    if (n === this.sel) {
      c.strokeStyle = 'rgba(255,255,255,0.92)'; c.lineWidth = 2;
      c.beginPath(); c.arc(p.x, p.y, R + 6 + Math.sin(this.now * 4) * 1.5, 0, TAU); c.stroke();
    } else if (n === this.hover) {
      c.strokeStyle = rgba(n.color, 0.75); c.lineWidth = 1.2;
      c.beginPath(); c.arc(p.x, p.y, R + 5, 0, TAU); c.stroke();
    }
  };

  Stage.prototype.drawCore = function (n, p) {
    var c = this.ctx, col = n.color, a = this.nodeAlpha(n), t = this.now;
    c.save();
    c.globalAlpha = a;
    var orbits = [[n.r * 2.0, 0.9, t * 0.5], [n.r * 2.7, -0.55, -t * 0.35], [n.r * 3.4, 0.25, t * 0.22]];
    for (var i = 0; i < orbits.length; i++) {
      var o = orbits[i], ang = o[2], tilt = o[1];
      var U = [Math.cos(ang), Math.sin(ang), 0];
      var V = [-Math.sin(ang) * Math.cos(tilt), Math.cos(ang) * Math.cos(tilt), Math.sin(tilt)];
      this.strokeDepth(this.circlePts(n.pos, o[0], U, V, 72), i === 1 ? '#a78bfa' : col, 0.55, 1.2);
      for (var s = 0; s < 2; s++) {
        var sa = t * (1.1 - i * 0.25) + s * Math.PI + i;
        var sp = this.project({
          x: n.pos.x + (U[0] * Math.cos(sa) + V[0] * Math.sin(sa)) * o[0],
          y: n.pos.y + (U[1] * Math.cos(sa) + V[1] * Math.sin(sa)) * o[0],
          z: n.pos.z + (U[2] * Math.cos(sa) + V[2] * Math.sin(sa)) * o[0]
        });
        this.drawGlowDot(sp, clamp(2.2 * sp.s, 1, 4), i === 1 ? '#c4b5fd' : '#bae6fd', 0.9);
      }
    }
    c.restore();
    var keep = n.r;
    n.r = n.r * (1 + Math.sin(t * 1.6) * 0.04);
    this.drawSphere(n, p);
    n.r = keep;
  };

  Stage.prototype.drawRing = function (n, p) {
    var c = this.ctx, col = n.color, off = n.inactive || n.modeOff;
    var a = this.nodeAlpha(n);
    var B = BASIS[n.axis || 'x'] || BASIS.x, R = num(n.R, 60);
    var pts = this.circlePts(n.pos, R, B[0], B[1], 64);
    c.save();
    c.globalAlpha = a;
    c.beginPath();
    for (var i = 0; i < pts.length; i++) { if (i) c.lineTo(pts[i].x, pts[i].y); else c.moveTo(pts[i].x, pts[i].y); }
    c.fillStyle = rgba(col, off ? 0.02 : 0.05 + n.glow * 0.05); c.fill();
    c.strokeStyle = rgba(col, off ? 0.05 : 0.1 + n.glow * 0.12); c.lineWidth = 10; c.stroke();
    if (off) c.setLineDash([5, 6]);
    c.shadowColor = rgba(col, 0.9); c.shadowBlur = off ? 0 : 8 + n.glow * 12;
    c.strokeStyle = rgba(col, off ? 0.45 : 0.9); c.lineWidth = off ? 1.2 : 2.2; c.stroke();
    c.shadowBlur = 0; c.setLineDash([]);
    c.restore();
    var top = pts[0], bot = pts[0];
    for (var ti = 1; ti < pts.length; ti++) { if (pts[ti].y < top.y) top = pts[ti]; if (pts[ti].y > bot.y) bot = pts[ti]; }
    var rr = Math.max(14, R * p.s);
    if (n.vis < 0.3) return;
    this.hits.push({ n: n, x: p.x, y: p.y, r: rr, d: p.d });
    if (n === this.sel) {
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(p.x, p.y, rr + 6, 0, TAU); c.stroke();
    }
    var wl = this.wantLabel(n);
    if (wl) {
      if (n.side === 'bottom') this.labelQ.push({ n: n, x: bot.x, y: bot.y + 6, R: 0, side: 'under', pri: wl, a: a, d: p.d });
      else this.labelQ.push({ n: n, x: top.x, y: top.y - 6, R: 0, side: 'top', pri: wl, a: a, d: p.d });
    }
  };

  Stage.prototype.drawCube = function (n, p) {
    var c = this.ctx, col = n.color, a = this.nodeAlpha(n);
    var w = num(n.w, 80) / 2, d = num(n.d, num(n.w, 80)) / 2, h = num(n.h, 40), P = n.pos;
    var x0 = P.x - w, x1 = P.x + w, y0 = P.y - d, y1 = P.y + d, z0 = P.z, z1 = P.z + h;
    var V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    var Q = [];
    for (var i = 0; i < 8; i++) Q.push(this.project({ x: V[i][0], y: V[i][1], z: V[i][2] }));
    var faces = [[4, 5, 6, 7, 't'], [0, 1, 5, 4, 's'], [1, 2, 6, 5, 's'], [2, 3, 7, 6, 's'], [3, 0, 4, 7, 's'], [0, 1, 2, 3, 'b']];
    var fl = faces.map(function (f) { return { f: f, d: (Q[f[0]].d + Q[f[1]].d + Q[f[2]].d + Q[f[3]].d) / 4 }; });
    fl.sort(function (x, y) { return y.d - x.d; });
    var slab = n.kind === 'slab';
    c.save();
    c.globalAlpha = a;
    for (var k = 0; k < fl.length; k++) {
      var f = fl[k].f;
      c.beginPath();
      c.moveTo(Q[f[0]].x, Q[f[0]].y); c.lineTo(Q[f[1]].x, Q[f[1]].y); c.lineTo(Q[f[2]].x, Q[f[2]].y); c.lineTo(Q[f[3]].x, Q[f[3]].y);
      c.closePath();
      var fa = f[4] === 't' ? (slab ? 0.2 : 0.36) : f[4] === 's' ? (slab ? 0.26 : 0.2) : 0.06;
      c.fillStyle = rgba(col, fa + n.glow * 0.08);
      c.fill();
    }
    var E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    c.shadowColor = rgba(col, 0.9); c.shadowBlur = 6 + n.glow * 10;
    c.strokeStyle = rgba(col, 0.88); c.lineWidth = 1.2;
    c.beginPath();
    for (var e = 0; e < E.length; e++) { c.moveTo(Q[E[e][0]].x, Q[E[e][0]].y); c.lineTo(Q[E[e][1]].x, Q[E[e][1]].y); }
    c.stroke();
    c.shadowBlur = 0;
    c.restore();
    var topC = this.project({ x: P.x, y: P.y, z: z1 });
    var rr = Math.max(16, Math.sqrt(w * d) * p.s);
    if (n.vis < 0.3) return;
    this.hits.push({ n: n, x: topC.x, y: topC.y, r: rr, d: p.d });
    if (n === this.sel) {
      c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(topC.x, topC.y, rr * 0.7 + 4, 0, TAU); c.stroke();
    }
    var wl = this.wantLabel(n);
    if (wl) {
      if (slab) {
        var corner = Q[4];
        for (var ci = 5; ci < 8; ci++) if (Q[ci].x > corner.x) corner = Q[ci];
        this.labelQ.push({ n: n, x: corner.x + 8, y: corner.y, R: 0, side: 'right', pri: wl, a: a, d: p.d });
      } else {
        var hiY = Q[4];
        for (var cj = 5; cj < 8; cj++) if (Q[cj].y < hiY.y) hiY = Q[cj];
        this.labelQ.push({ n: n, x: topC.x, y: hiY.y - 6, R: 0, side: 'top', pri: wl, a: a, d: p.d });
      }
    }
  };

  // ---------------------------------------------------------------- labels
  Stage.prototype.tw = function (font, text) {
    var key = font + '|' + text, v = this.twc[key];
    if (v == null) { this.ctx.font = font; v = this.twc[key] = this.ctx.measureText(text).width; }
    return v;
  };

  Stage.prototype.obstacles = function () {
    if (this.obst && this.now - this.obstT < 0.5) return this.obst;
    var out = [], rr = this.root.getBoundingClientRect(), els = [this.kpi, this.note, this.legend, this.hud];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (!e || e.style.display === 'none' || !e.offsetWidth) continue;
      var r = e.getBoundingClientRect();
      out.push([r.left - rr.left - 4, r.top - rr.top - 4, r.width + 8, r.height + 8]);
    }
    this.obst = out; this.obstT = this.now;
    return out;
  };

  Stage.prototype.drawLabels = function () {
    var placed = this.obstacles().slice(), top = this.topPad, W = this.W, H = this.H;
    this.labelQ.sort(function (a, b) { return (b.pri - a.pri) || (a.d - b.d); });
    for (var i = 0; i < this.labelQ.length; i++) {
      var L = this.labelQ[i], n = L.n;
      var full = L.pri >= 3 || (n.kind === 'core' && !n.brief) || n.subAlways || this.sc.labelSub === 'all';
      var title = n.label || '', sub = full ? (n.sub || '') : '', state = n.state || '';
      var tw = this.tw('600 12px ' + FONT, title);
      var sw = state ? this.tw('700 10.5px ' + FONT, state) + 10 : 0;
      var subw = sub ? this.tw('10.5px ' + FONT, sub) : 0;
      var bw = Math.max(tw + sw, subw) + 18, bh = sub ? 34 : 21, g = 6, R = L.R || 0;
      var cands;
      if (L.side === 'top') cands = [[L.x - bw / 2, L.y - bh], [L.x + 10, L.y - bh / 2], [L.x - bw - 10, L.y - bh / 2], [L.x - bw / 2, L.y - bh - 18]];
      else if (L.side === 'plane') cands = [[L.x + 6, L.y + 6], [L.x + 6, L.y - bh - 6]];
      else if (L.side === 'left') cands = [[L.x - R - g - bw, L.y - bh / 2], [L.x - bw / 2, L.y - R - g - bh], [L.x + R + g, L.y - bh / 2], [L.x - bw / 2, L.y + R + g]];
      else if (L.side === 'below') cands = [[L.x - bw / 2, L.y + R + g], [L.x + R + g, L.y - bh / 2], [L.x - R - g - bw, L.y - bh / 2], [L.x - bw / 2, L.y - R - g - bh]];
      else if (L.side === 'above') cands = [[L.x - bw / 2, L.y - R - g - bh], [L.x + R + g, L.y - bh / 2], [L.x - R - g - bw, L.y - bh / 2], [L.x - bw / 2, L.y + R + g]];
      else if (L.side === 'right') cands = [[L.x + R, L.y - bh / 2], [L.x + R, L.y - bh - 4], [L.x + R, L.y + 4]];
      else if (L.side === 'under') cands = [[L.x - bw / 2, L.y], [L.x + 10, L.y - bh / 2], [L.x - bw - 10, L.y - bh / 2], [L.x - bw / 2, L.y + 18]];
      else if (L.side === 'center') cands = [[L.x - bw / 2, L.y - bh / 2], [L.x - bw / 2, L.y - bh - 8], [L.x - bw / 2, L.y + 8]];
      else cands = [[L.x + R + g, L.y - bh / 2], [L.x - R - g - bw, L.y - bh / 2], [L.x - bw / 2, L.y - R - g - bh], [L.x - bw / 2, L.y + R + g]];
      var box = null;
      for (var k = 0; k < cands.length && !box; k++) {
        var bx = clamp(cands[k][0], 4, W - bw - 4), by = clamp(cands[k][1], top, H - bh - 30);
        var hit = false;
        for (var j = 0; j < placed.length; j++) {
          var q = placed[j];
          if (bx < q[0] + q[2] + 2 && bx + bw + 2 > q[0] && by < q[1] + q[3] + 2 && by + bh + 2 > q[1]) { hit = true; break; }
        }
        if (!hit) box = [bx, by, bw, bh];
      }
      if (!box) {
        if (L.pri < 3) continue;
        box = [clamp(cands[0][0], 4, W - bw - 4), clamp(cands[0][1], top, H - bh - 30), bw, bh];
      }
      placed.push(box);
      this.pill(box, n, title, sub, state, L.a, tw);
    }
  };

  Stage.prototype.pill = function (box, n, title, sub, state, a, twidth) {
    var c = this.ctx, x = box[0], y = box[1], w = box[2], h = box[3], col = n.color;
    c.save();
    c.globalAlpha = Math.max(0.35, a);
    roundRect(c, x, y, w, h, 6);
    c.fillStyle = 'rgba(5,12,24,0.66)'; c.fill();
    c.strokeStyle = rgba(col, 0.42); c.lineWidth = 1; c.stroke();
    c.fillStyle = rgba(col, 0.95); c.fillRect(x + 1, y + 4, 2.5, h - 8);
    c.textBaseline = 'middle';
    c.font = '600 12px ' + FONT; c.fillStyle = '#f1f5fb';
    c.fillText(title, x + 9, y + 11);
    if (state) {
      c.font = '700 10.5px ' + FONT; c.fillStyle = col;
      c.fillText(state, x + 9 + twidth + 8, y + 11);
    }
    if (sub) { c.font = '10.5px ' + FONT; c.fillStyle = '#9fb3d1'; c.fillText(sub, x + 9, y + 25); }
    c.restore();
  };

  // ---------------------------------------------------------------- interaction
  Stage.prototype.pick = function (x, y) {
    var best = null;
    for (var i = 0; i < this.hits.length; i++) {
      var h = this.hits[i], dx = x - h.x, dy = y - h.y;
      if (dx * dx + dy * dy <= (h.r + 6) * (h.r + 6) && (!best || h.d < best.d)) best = h;
    }
    return best ? best.n : null;
  };

  Stage.prototype.hoverAt = function (x, y) {
    var n = this.pick(x, y);
    this.hover = n;
    this.cv.style.cursor = n ? 'pointer' : '';
    if (!n) { this.hideTip(); return; }
    var t = this.tip;
    t.innerHTML = '<b>' + esc(n.label) + (n.state ? ' <em>' + esc(n.state) + '</em>' : '') + '</b>' +
      (n.sub ? '<div class="k">' + esc(n.sub) + '</div>' : '') + (n.detail ? '<div class="d">' + n.detail + '</div>' : '');
    t.style.display = 'block';
    var tw = t.offsetWidth, th = t.offsetHeight;
    t.style.left = clamp(x + 16, 6, this.W - tw - 6) + 'px';
    t.style.top = clamp(y + 14, 6, this.H - th - 6) + 'px';
  };

  Stage.prototype.hideTip = function () { if (this.tip) this.tip.style.display = 'none'; };

  Stage.prototype.clickAt = function (x, y) {
    var n = this.pick(x, y);
    this.sel = (n && n !== this.sel) ? n : null;
    this.showInfo(this.sel);
  };

  Stage.prototype.showInfo = function (n) {
    var box = this.info, self = this;
    if (!box) return;
    if (!n) { box.classList.remove('on'); box.innerHTML = ''; return; }
    var nb = Object.keys(this.adj[n.id] || {}).map(function (id) { return self.nodes[id] ? self.nodes[id].label : id; });
    box.innerHTML = '<button type="button" class="x" aria-label="关闭">×</button><b>' + esc(n.label) + (n.state ? ' <em>' + esc(n.state) + '</em>' : '') + '</b>' +
      (n.sub ? '<div class="k">' + esc(n.sub) + '</div>' : '') + (n.detail ? '<div class="d">' + n.detail + '</div>' : '') +
      (nb.length ? '<div class="k">关联：' + nb.map(esc).join(' · ') + '</div>' : '');
    box.classList.add('on');
    box.querySelector('.x').addEventListener('click', function (ev) { ev.stopPropagation(); self.sel = null; self.showInfo(null); });
  };

  Stage.prototype.updateFoot = function () {
    if (!this.foot) return;
    var np = this.particles.length;
    for (var i = 0; i < this.flows.length; i++) if (this.flows[i].kind === 'knot') np += this.flows[i].items.length;
    var nn = 0;
    for (var j = 0; j < this.nodeList.length; j++) if (this.nodeList[j].kind !== 'anchor') nn++;
    this.foot.innerHTML = '<span class="h">拖拽旋转 · 点击画布后滚轮缩放 · 双击复位 · 悬停 / 点击查看</span>' +
      '<span>' + Math.min(60, this.fps) + ' FPS · 节点 ' + nn + ' · 粒子 ' + np + '</span>';
  };

  Stage.prototype.renderHud = function (force) {
    if (!this.hud || !this.tl) return;
    if (!force && this.now - (this.hudT || 0) < 0.12) return;
    this.hudT = this.now;
    var tl = this.tl, phs = this.sc.timeline.phases, ph = phs[tl.idx], prog = clamp(tl.t / ph.dur, 0, 1);
    var html = '<div class="ph"><i style="background:' + ph.color + ';box-shadow:0 0 8px ' + ph.color + '"></i><b>' + esc(ph.name) + '</b><span>' +
      (tl.idx + 1) + ' / ' + phs.length + (tl.playing ? '' : ' · 已暂停') + '</span></div>' +
      '<div class="bar"><i style="width:' + (prog * 100).toFixed(1) + '%;background:' + ph.color + '"></i></div>';
    (ph.meters || []).forEach(function (m) {
      var v = lerp(m.from, m.to, prog), col = m.color || '#e2e8f0';
      html += '<div class="m"><span>' + esc(m.label) + '</span><b style="color:' + col + '">' + fmt(v, m.fmt) + '</b>' +
        (m.fmt === 'pct' ? '<div class="mb"><i style="width:' + (v * 100).toFixed(1) + '%;background:' + col + '"></i></div>' : '') + '</div>';
    });
    (ph.lines || []).forEach(function (l) { html += '<div class="l">' + esc(l) + '</div>'; });
    this.hud.innerHTML = html;
  };

  // ---------------------------------------------------------------- mount
  function mountAll() {
    var roots = document.querySelectorAll('.s3[data-scene]');
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (r._s3) continue;
      var src = document.getElementById('s3-' + r.getAttribute('data-scene'));
      if (!src) continue;
      try {
        r._s3 = new Stage(r, JSON.parse(src.textContent));
      } catch (e) {
        r.innerHTML = '<div class="s3-err">3D 场景加载失败：' + esc(e && e.message) + '</div>';
        if (window.console) console.error(e);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
  window.Arch3D = { mountAll: mountAll, Stage: Stage };
})();
