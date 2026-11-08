// workdocs: optional presentation helper. Adds a theme toggle, copy buttons on code blocks, and runs the animated
// flow and the step player (both self-running: documentation is read, not operated). It never loads or inserts documentation content:
// every page is complete and readable without it.
(function () {
  "use strict";
  var KEY = "docs-theme";   // shared with the workmap page, so one choice applies to every page in docs/
  var root = document.documentElement;
  var reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function store(op, value) {
    try {
      if (op === "get") return window.localStorage.getItem(KEY);
      window.localStorage.setItem(KEY, value);
    } catch (e) { /* storage blocked (file://, private mode): theme still follows the OS */ }
    return null;
  }
  var saved = store("get");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  function isDark() {
    var t = root.getAttribute("data-theme");
    if (t) return t === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(cls, text, label) {
    var b = el("button", cls, text); b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    return b;
  }

  function addToggle() {
    var bar = document.querySelector(".wd-bar");
    if (!bar || bar.querySelector(".wd-theme")) return;
    var b = btn("wd-theme", "◐", "Toggle colour theme");
    b.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store("set", next);
    });
    bar.appendChild(b);
  }

  function addCopyButtons() {
    if (!navigator.clipboard) return;
    var blocks = document.querySelectorAll("pre > code");
    for (var i = 0; i < blocks.length; i++) {
      (function (code) {
        var pre = code.parentNode;
        if (pre.querySelector(".wd-copy")) return;
        var b = btn("wd-copy", "Copy");
        b.addEventListener("click", function () {
          navigator.clipboard.writeText(code.textContent).then(function () {
            b.textContent = "Copied";
            setTimeout(function () { b.textContent = "Copy"; }, 1200);
          }, function () { b.textContent = "Copy failed"; });
        });
        pre.appendChild(b);
      })(blocks[i]);
    }
  }

  // Animated flow: <section class="wd-flow playing"> with an inline SVG whose packets move along the wires
  // (SMIL animateMotion) and whose wires are dashed (CSS). It runs on its own: no controls to click. It pauses
  // while the tab is hidden, and under prefers-reduced-motion it stays still (the CSS also hides the packets).
  function startFlows() {
    var flows = document.querySelectorAll(".wd-flow");
    for (var i = 0; i < flows.length; i++) {
      (function (sec) {
        var svg = sec.querySelector("svg");
        if (!svg) return;
        function set(on) {
          sec.classList.toggle("playing", on);
          try { if (on) svg.unpauseAnimations(); else svg.pauseAnimations(); } catch (e) { /* no SMIL */ }
        }
        set(!reduced && !document.hidden);
        document.addEventListener("visibilitychange", function () { set(!reduced && !document.hidden); });
      })(flows[i]);
    }
  }

  // Step player: <ol class="wd-steps" data-player data-lanes="client=Client|web app;api=API;db=PostgreSQL">
  // whose <li> items carry data-from / data-to (lane ids), optionally data-label and data-kind="ret".
  // JS draws a sequence diagram above the list and walks the steps on its own, in a loop, starting when the
  // section scrolls into view; there is nothing to click. The list itself stays in the HTML and is readable
  // without JS. Under prefers-reduced-motion every step is shown lit and nothing moves.
  function startStepPlayers() {
    var lists = document.querySelectorAll("ol.wd-steps[data-player]");
    for (var i = 0; i < lists.length; i++) {
      (function (ol) {
        if (ol.getAttribute("data-player-ready")) return;
        var lanes = (ol.getAttribute("data-lanes") || "").split(";").map(function (s) {
          var eq = s.indexOf("="); if (eq < 0) return null;
          var p = s.slice(eq + 1).split("|");
          return { id: s.slice(0, eq).trim(), label: p[0].trim(), sub: (p[1] || "").trim() };
        }).filter(Boolean);
        var items = Array.prototype.slice.call(ol.children);
        var steps = items.map(function (li, n) {
          var b = li.querySelector("b, strong");
          return { li: li, from: li.getAttribute("data-from"), to: li.getAttribute("data-to"), kind: li.getAttribute("data-kind") || "",
            label: li.getAttribute("data-label") || (b ? b.textContent : String(n + 1)) };
        });
        if (!lanes.length || !steps.length) return;
        ol.setAttribute("data-player-ready", "1");
        var NS = "http://www.w3.org/2000/svg";
        var colW = 200, left = 100, top = 46, rowH = 40;
        var W = left * 2 + colW * (lanes.length - 1), H = top + rowH * (steps.length + 1);
        function node(tag, attrs, text) {
          var e = document.createElementNS(NS, tag);
          for (var k in attrs) e.setAttribute(k, attrs[k]);
          if (text != null) e.textContent = text;
          return e;
        }
        var svg = node("svg", { "class": "wd-stage", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Sequence diagram of the steps listed below" });
        var x = {};
        lanes.forEach(function (l, k) {
          x[l.id] = left + k * colW;
          svg.appendChild(node("line", { "class": "life", x1: x[l.id], y1: top, x2: x[l.id], y2: H - 6 }));
          svg.appendChild(node("rect", { "class": "lane", x: x[l.id] - 80, y: 6, width: 160, height: 32, rx: 9 }));
          svg.appendChild(node("text", { "class": "lane-t", x: x[l.id], y: l.sub ? 21 : 26, "text-anchor": "middle" }, l.label));
          if (l.sub) svg.appendChild(node("text", { "class": "lane-s", x: x[l.id], y: 33, "text-anchor": "middle" }, l.sub));
        });
        var marks = steps.map(function (s, n) {
          var g = node("g", { "class": "step" + (s.kind === "ret" ? " ret" : "") });
          var y = top + rowH * (n + 1), a = x[s.from], b = x[s.to];
          if (a != null && b != null) {
            if (a === b) {
              g.appendChild(node("path", { "class": "msg", d: "M" + a + " " + (y - 10) + " h36 v20 h-36" }));
              g.appendChild(node("path", { "class": "head", d: "M" + a + " " + (y + 10) + " l8 -5 v10 z" }));
              g.appendChild(node("text", { "class": "msg-t", x: a + 42, y: y + 4 }, s.label));
            } else {
              var d = b > a ? -8 : 8;
              g.appendChild(node("line", { "class": "msg", x1: a, y1: y, x2: b, y2: y }));
              g.appendChild(node("path", { "class": "head", d: "M" + b + " " + y + " l" + d + " -5 v10 z" }));
              g.appendChild(node("text", { "class": "msg-t", x: (a + b) / 2, y: y - 6, "text-anchor": "middle" }, s.label));
            }
          }
          svg.appendChild(g);
          return g;
        });
        ol.parentNode.insertBefore(svg, ol);
        var cur = -1, timer = null;
        function go(n) {
          cur = (n + steps.length) % steps.length;
          steps.forEach(function (s, k) {
            s.li.classList.toggle("current", k === cur);
            marks[k].classList.toggle("on", k === cur);
            marks[k].classList.toggle("past", k < cur);
          });
        }
        function stop() { if (timer) clearInterval(timer); timer = null; }
        function start() { if (timer) return; timer = setInterval(function () { go(cur + 1); }, 2200); }
        if (reduced) {
          marks.forEach(function (m) { m.classList.add("on"); });
          return;
        }
        go(0);
        var visible = true;
        if (window.IntersectionObserver) {
          visible = false;
          new IntersectionObserver(function (entries) {
            visible = entries[0].isIntersecting;
            if (visible) { go(0); if (!document.hidden) start(); } else stop();
          }, { threshold: 0.2 }).observe(svg);
        } else start();
        document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else if (visible) start(); });
      })(lists[i]);
    }
  }

  function init() { addToggle(); addCopyButtons(); startFlows(); startStepPlayers(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
