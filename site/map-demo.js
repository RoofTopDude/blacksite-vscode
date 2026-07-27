/* The interactive Codebase Map on the homepage.
 *
 * A hand-rolled canvas stand-in for the real thing, which renders through
 * pixi.js/WebGL against a live workspace index. The interaction model is the
 * same — drag to pan, scroll to zoom, click a star, filter by layer, search —
 * so the demo teaches the controls even though the graph is fixed.
 *
 * Colours come from the same four-way classification the product uses:
 * application, service, data, context.
 */
(() => {
  "use strict";

  const demo = document.querySelector("[data-map-demo]");
  const canvas = demo?.querySelector("[data-map-canvas]");
  if (!demo || !canvas) return;

  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const NODES = [
    { id: "app", name: "App shell", path: "src/webview/react/App.tsx", type: "app", role: "Interface", links: 8, heat: "High", icon: "panel-left", copy: "The workspace entry point. Composes the panel shell and routes user intent into the session." },
    { id: "agent", name: "Agent session", path: "src/agent-session.ts", type: "app", role: "Orchestrator", links: 11, heat: "High", icon: "sparkles", copy: "Coordinates the turn: tool calls, approvals, compaction, and the durable working context." },
    { id: "map", name: "Graph workspace", path: "src/graph/workspace.ts", type: "app", role: "Topology", links: 9, heat: "Medium", icon: "map", copy: "Indexes files, resolves imports per language, and connects services into the queryable graph." },
    { id: "chat", name: "Chat surface", path: "src/webview/react/components/chat", type: "app", role: "Interface", links: 6, heat: "Medium", icon: "message-square", copy: "The transcript, tool log, and input dock — where a request becomes a run you can watch." },
    { id: "lsp", name: "Language service", path: "src/lsp-service.ts", type: "api", role: "Intelligence", links: 7, heat: "Medium", icon: "brain", copy: "Symbols, navigation, hierarchies, diagnostics, and rename, answered by your own language servers." },
    { id: "runtime", name: "Local runtime", path: "packages/local-runtime/src/runtime.ts", type: "api", role: "Execution", links: 10, heat: "High", icon: "terminal", copy: "Executes agent tools in a controlled local environment and returns grounded results." },
    { id: "approval", name: "Approval gate", path: "src/approval-gate.ts", type: "api", role: "Control", links: 5, heat: "Low", icon: "shield-check", copy: "The gap between what the model asks for and what actually runs. Every write and network call passes here." },
    { id: "data", name: "Data workbench", path: "src/data/query-service.ts", type: "data", role: "Query layer", links: 6, heat: "Low", icon: "database", copy: "Catalog discovery, read-only query execution, and write classification that never executes." },
    { id: "store", name: "Vector store", path: "src/vector-store.ts", type: "data", role: "Retrieval", links: 4, heat: "Low", icon: "layers", copy: "Local semantic retrieval over workspace content and attached reference material." },
    { id: "memory", name: "Project memory", path: ".blacksite/memory", type: "docs", role: "Context", links: 4, heat: "Low", icon: "brain", copy: "What the agent recorded for itself, so the second session on a problem starts ahead of the first." },
    { id: "plans", name: "Plan store", path: ".blacksite/planning.json", type: "docs", role: "Intent", links: 5, heat: "Medium", icon: "list-todo", copy: "Phases, dependencies, and acceptance criteria that survive the end of a conversation." },
    { id: "notes", name: "Map notes", path: "src/graph-annotation-store.ts", type: "docs", role: "History", links: 3, heat: "Low", icon: "notebook-pen", copy: "Durable annotations on files and relations — including edges the indexers cannot detect." },
    { id: "tests", name: "Test harness", path: "tests/unit/agent-session.spec.ts", type: "app", role: "Verification", links: 3, heat: "Low", icon: "flask-conical", copy: "Protects the intent of a change, and is the first thing the agent runs after touching this area." },
  ];

  const EDGES = [
    ["app", "agent"], ["app", "chat"], ["app", "memory"], ["agent", "map"], ["agent", "lsp"],
    ["agent", "runtime"], ["agent", "plans"], ["agent", "tests"], ["agent", "approval"],
    ["runtime", "approval"], ["map", "lsp"], ["map", "memory"], ["map", "plans"], ["map", "notes"],
    ["chat", "plans"], ["runtime", "data"], ["runtime", "store"], ["data", "store"],
    ["plans", "notes"], ["notes", "memory"], ["lsp", "tests"], ["data", "plans"],
  ];

  // Matches the map legend, and the extension's own star classification.
  const COLORS = { app: "#a78bfa", api: "#8db4a8", data: "#c4b08d", docs: "#8aa6c0" };

  const field = (name) => demo.querySelector(`[data-map-${name}]`);
  const out = {
    files: field("files"),
    routes: field("routes"),
    focus: field("focus"),
    title: field("node-title"),
    path: field("node-path"),
    role: field("node-role"),
    links: field("node-links"),
    heat: field("node-heat"),
    copy: field("node-copy"),
    icon: demo.querySelector("[data-map-node-icon] use"),
  };

  let selected = NODES[1];
  let filter = "all";
  let query = "";
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let drag = null;
  let hover = null;

  // Deterministic layout: a golden-angle spiral seeded by index, then nudged
  // so the two hubs sit centrally. Stable across reloads, unlike a simulation.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  NODES.forEach((node, i) => {
    const radius = 30 + Math.sqrt(i) * 74;
    node.x = Math.cos(i * GOLDEN) * radius;
    node.y = Math.sin(i * GOLDEN) * radius * 0.82;
  });
  Object.assign(NODES[0], { x: -128, y: -48 });
  Object.assign(NODES[1], { x: 18, y: -14 });

  const byId = (id) => NODES.find((n) => n.id === id);
  const visible = (node) =>
    (filter === "all" || node.type === filter) &&
    (!query || `${node.name} ${node.path} ${node.role}`.toLowerCase().includes(query));

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return box;
  }

  const project = (node, box) => ({
    x: box.width / 2 + offset.x + node.x * scale,
    y: box.height / 2 + 14 + offset.y + node.y * scale,
  });

  function draw() {
    const box = measure();
    const active = visible(selected) ? selected : NODES.find(visible) || selected;
    const shown = NODES.filter(visible);
    ctx.clearRect(0, 0, box.width, box.height);

    // Edges first, so stars sit on top of them.
    for (const [a, b] of EDGES) {
      const one = byId(a);
      const two = byId(b);
      if (!visible(one) || !visible(two)) continue;

      const p1 = project(one, box);
      const p2 = project(two, box);
      const lit = one === active || two === active;

      ctx.strokeStyle = lit ? "rgba(196,181,253,.58)" : "rgba(138,166,192,.16)";
      ctx.lineWidth = lit ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 20 * scale, p2.x, p2.y);
      ctx.stroke();
    }

    for (const node of shown) {
      const p = project(node, box);
      const isActive = node === active;
      const isHover = node === hover;
      const radius = (isActive ? 8 : isHover ? 6.5 : 4.4) * Math.min(1.25, scale);
      const color = COLORS[node.type];

      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 5);
      halo.addColorStop(0, `${color}55`);
      halo.addColorStop(1, `${color}00`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      if (isActive) {
        ctx.strokeStyle = "#f0edff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Labels only when there is room for them to be legible.
      if (scale > 0.82 || isActive || isHover) {
        ctx.fillStyle = isActive ? "#f1efff" : "#a1a1aa";
        ctx.font = `${isActive ? 10.5 : 9.5}px "SF Mono", ui-monospace, Consolas, monospace`;
        ctx.fillText(node.name, p.x + radius + 7, p.y + 3.5);
      }
    }

    const routes = EDGES.filter(([a, b]) => visible(byId(a)) && visible(byId(b))).length;
    if (out.files) out.files.textContent = filter === "all" && !query ? "1,284" : String(shown.length * 7 + 3);
    if (out.routes) out.routes.textContent = String(routes);
    if (out.focus) out.focus.textContent = filter === "all" ? "All" : filter.toUpperCase();
  }

  function select(node) {
    selected = node;
    if (out.title) out.title.textContent = node.name;
    if (out.path) out.path.textContent = node.path;
    if (out.role) out.role.textContent = node.role;
    if (out.links) out.links.textContent = String(node.links);
    if (out.heat) out.heat.textContent = node.heat;
    if (out.copy) out.copy.textContent = node.copy;
    if (out.icon) out.icon.setAttribute("href", `#i-${node.icon}`);
    draw();
  }

  function pick(event) {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let nearest = null;
    let best = 20;

    for (const node of NODES.filter(visible)) {
      const p = project(node, box);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < best) { nearest = node; best = d; }
    }
    return nearest;
  }

  function zoom(amount) {
    scale = Math.max(0.55, Math.min(2.2, scale + amount));
    draw();
  }

  /* ── controls ───────────────────────────────────────────────────────────── */
  const filterButtons = [...demo.querySelectorAll("[data-map-filter]")];
  const syncFilters = () =>
    filterButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.mapFilter === filter));

  filterButtons.forEach((button) =>
    button.addEventListener("click", () => {
      filter = button.dataset.mapFilter;
      syncFilters();
      if (!visible(selected)) select(NODES.find(visible) || NODES[0]);
      else draw();
    }),
  );

  const search = demo.querySelector("[data-map-search]");
  if (search) {
    search.addEventListener("input", (event) => {
      query = event.target.value.trim().toLowerCase();
      if (query && !visible(selected)) {
        const match = NODES.find(visible);
        if (match) select(match);
      }
      draw();
    });
  }

  demo.querySelectorAll("[data-map-zoom]").forEach((button) =>
    button.addEventListener("click", () => {
      const action = button.dataset.mapZoom;
      if (action === "in") zoom(0.18);
      else if (action === "out") zoom(-0.18);
      else { scale = 1; offset = { x: 0, y: 0 }; draw(); }
    }),
  );

  const isolate = demo.querySelector("[data-map-isolate]");
  if (isolate) {
    isolate.addEventListener("click", () => {
      filter = filter === selected.type ? "all" : selected.type;
      syncFilters();
      draw();
    });
  }

  /* ── pointer ────────────────────────────────────────────────────────────── */
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, moved: false };
    canvas.classList.add("is-dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      offset = { x: drag.ox + dx, y: drag.oy + dy };
      draw();
      return;
    }
    const next = pick(event);
    if (next !== hover) {
      hover = next;
      canvas.style.cursor = next ? "pointer" : "grab";
      draw();
    }
  });

  const endDrag = (event) => {
    // A click that never moved is a selection; one that moved was a pan.
    if (drag && !drag.moved) {
      const hit = pick(event);
      if (hit) select(hit);
    }
    drag = null;
    canvas.classList.remove("is-dragging");
  };

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", () => { drag = null; canvas.classList.remove("is-dragging"); });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom(event.deltaY > 0 ? -0.1 : 0.1);
    },
    { passive: false },
  );

  /* Keyboard: the canvas is focusable so the map is reachable without a mouse. */
  canvas.tabIndex = 0;
  canvas.addEventListener("keydown", (event) => {
    const step = 26;
    const moves = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    if (event.key in moves) {
      event.preventDefault();
      offset = { x: offset.x + moves[event.key][0], y: offset.y + moves[event.key][1] };
      draw();
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(0.18); }
    else if (event.key === "-") { event.preventDefault(); zoom(-0.18); }
    else if (event.key === "Tab" && !event.shiftKey) {
      // Cycle the selection rather than leaving the map on the first Tab.
      const shown = NODES.filter(visible);
      const index = shown.indexOf(selected);
      if (index > -1 && index < shown.length - 1) {
        event.preventDefault();
        select(shown[index + 1]);
      }
    }
  });

  addEventListener("resize", draw);
  syncFilters();
  select(selected);

  /* A slow drift while untouched, so the field reads as alive rather than as
     a screenshot. Stops permanently on first interaction. */
  if (!reduceMotion) {
    let t = 0;
    let idle = true;
    const drift = () => {
      if (!idle) return;
      t += 0.004;
      offset = { x: Math.sin(t) * 9, y: Math.cos(t * 0.7) * 6 };
      draw();
      requestAnimationFrame(drift);
    };
    const settle = () => { idle = false; };
    canvas.addEventListener("pointerdown", settle, { once: true });
    canvas.addEventListener("wheel", settle, { once: true });
    demo.addEventListener("click", settle, { once: true });
    requestAnimationFrame(drift);
  }
})();
