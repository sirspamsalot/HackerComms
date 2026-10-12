// site.js — hero terminal (typed command + mesh animation) and copy buttons.

// Copy buttons: <button class="copy" data-copy="text"> or data-copy-from="#id">
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const text = btn.dataset.copy ?? document.querySelector(btn.dataset.copyFrom)?.textContent ?? "";
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text.trim());
    btn.textContent = "Copied";
    btn.classList.add("done");
  } catch {
    // Clipboard refused: select the text so it can be copied by hand.
    const target = document.querySelector(btn.dataset.copyFrom || "") || btn.previousElementSibling;
    if (target) { const r = document.createRange(); r.selectNodeContents(target); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    btn.textContent = "Selected";
  }
  setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1400);
});

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Hero: a small random mesh with packets hopping node to node.
(function mesh() {
  const svg = document.querySelector(".hero-mesh");
  if (!svg) return;
  const NS = "http://www.w3.org/2000/svg";
  const W = 1200, H = 600;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");

  // Seeded RNG so the layout is stable between loads.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const nodes = [];
  const cols = 9, rows = 5;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rnd() < 0.28) continue;
    nodes.push({
      x: (c + 0.5 + (rnd() - 0.5) * 0.7) * (W / cols),
      y: (r + 0.5 + (rnd() - 0.5) * 0.7) * (H / rows),
    });
  }
  const edges = [];
  const adj = nodes.map(() => []);
  nodes.forEach((a, i) => {
    nodes.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((o) => o.j !== i).sort((p, q) => p.d - q.d).slice(0, 2)
      .forEach(({ j }) => {
        if (adj[i].includes(j)) return;
        adj[i].push(j); adj[j].push(i); edges.push([i, j]);
      });
  });

  const gE = document.createElementNS(NS, "g");
  const gP = document.createElementNS(NS, "g");
  const gN = document.createElementNS(NS, "g");
  svg.append(gE, gP, gN);
  for (const [i, j] of edges) {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("class", "edge");
    l.setAttribute("x1", nodes[i].x); l.setAttribute("y1", nodes[i].y);
    l.setAttribute("x2", nodes[j].x); l.setAttribute("y2", nodes[j].y);
    gE.append(l);
  }
  const circles = nodes.map((n) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", "node");
    c.setAttribute("cx", n.x); c.setAttribute("cy", n.y); c.setAttribute("r", 5);
    gN.append(c);
    return c;
  });

  if (reduceMotion) return;

  // Packets: flood outward from a random node, one hop at a time.
  function flood() {
    const start = Math.floor(rnd() * nodes.length);
    const seen = new Set([start]);
    let frontier = [start], hop = 0;
    const step = () => {
      if (!frontier.length || hop > 3) { setTimeout(flood, 900); return; }
      const next = [];
      for (const i of frontier) {
        circles[i].classList.add("hot");
        setTimeout(() => circles[i].classList.remove("hot"), 700);
        for (const j of adj[i]) if (!seen.has(j)) { seen.add(j); next.push(j); travel(i, j); }
      }
      frontier = next; hop++;
      setTimeout(step, 650);
    };
    step();
  }
  function travel(i, j) {
    const p = document.createElementNS(NS, "circle");
    p.setAttribute("class", "pulse"); p.setAttribute("r", 3);
    gP.append(p);
    const a = nodes[i], b = nodes[j], t0 = performance.now(), dur = 600;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      p.setAttribute("cx", a.x + (b.x - a.x) * k);
      p.setAttribute("cy", a.y + (b.y - a.y) * k);
      if (k < 1) requestAnimationFrame(tick); else p.remove();
    };
    requestAnimationFrame(tick);
  }
  flood();
})();

// Typed commands: the page is complete without JS; with motion allowed the
// commands are retyped once on load, one line after the other.
(function typed() {
  const cmds = [...document.querySelectorAll("[data-typed]")];
  const out = document.getElementById("typed-out");
  if (!cmds.length || reduceMotion) return;
  const texts = cmds.map((c) => c.textContent);
  cmds.forEach((c) => { c.textContent = ""; c.parentElement.style.visibility = "hidden"; });
  if (out) out.style.visibility = "hidden";
  let line = 0, i = 0;
  const tick = () => {
    const el = cmds[line];
    el.parentElement.style.visibility = "";
    el.textContent = texts[line].slice(0, ++i);
    if (i < texts[line].length) return setTimeout(tick, 18 + Math.random() * 30);
    line++; i = 0;
    if (line < cmds.length) return setTimeout(tick, 350);
    if (out) setTimeout(() => { out.style.visibility = ""; }, 250);
  };
  setTimeout(tick, 300);
})();
