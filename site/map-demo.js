/* The interactive Codebase Map on the homepage.
 *
 * A hand-rolled canvas stand-in for the real thing, which renders through
 * pixi.js/WebGL against a live workspace index. The interaction model is the
 * same — drag to pan, scroll to zoom, click a star, filter by role, search —
 * so the demo teaches the controls even though the graph is fixed.
 *
 * Like the extension, star colour comes from a stable hash of folder territory;
 * functional role is a separate filter, and edges carry relationship colours.
 */
(() => {
  "use strict";

  const demo = document.querySelector("[data-map-demo]");
  const canvas = demo?.querySelector("[data-map-canvas]");
  if (!demo || !canvas) return;

  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const NODES = [
    { id: "app", name: "App shell", path: "src/webview/react/App.tsx", territory: "webview", fileRole: "entry", role: "Entry point", links: 8, heat: "High", icon: "panel-left", copy: "The webview entry point. Composes the panel shell and routes user intent into the session." },
    { id: "agent", name: "Agent session", path: "src/agent-session.ts", territory: "core", fileRole: "source", role: "Source", links: 11, heat: "High", icon: "sparkles", copy: "Coordinates the turn: tool calls, approvals, compaction, and the durable working context." },
    { id: "map", name: "Graph provider", path: "src/graph-provider.ts", territory: "graph", fileRole: "source", role: "Source", links: 9, heat: "Medium", icon: "map", copy: "Owns the map view, live index updates, and the bridge between the extension host and the WebGL scene." },
    { id: "chat", name: "Chat input", path: "src/webview/react/components/chat/InputDock.tsx", territory: "webview", fileRole: "source", role: "Source", links: 6, heat: "Medium", icon: "message-square", copy: "The request-profile controls, attachments, mentions, commands, and input that begin a run." },
    { id: "lsp", name: "Language service", path: "src/lsp-service.ts", territory: "core", fileRole: "source", role: "Source", links: 7, heat: "Medium", icon: "brain", copy: "Symbols, navigation, hierarchies, diagnostics, and rename, answered by the installed language servers." },
    { id: "runtime", name: "Local runtime", path: "packages/local-runtime/src/runtime.ts", territory: "packages", fileRole: "source", role: "Source", links: 10, heat: "High", icon: "terminal", copy: "Executes agent tools in a controlled local environment and returns grounded results." },
    { id: "approval", name: "Approval gate", path: "src/approval-gate.ts", territory: "core", fileRole: "source", role: "Source", links: 5, heat: "Low", icon: "shield-check", copy: "The gap between what the model asks for and what actually runs. Sensitive actions pass through here." },
    { id: "data", name: "Data query service", path: "src/data/query-service.ts", territory: "data", fileRole: "source", role: "Source", links: 6, heat: "Low", icon: "database", copy: "Catalog discovery, read-only query execution, and write classification through one local layer." },
    { id: "schema", name: "Data schema", path: "src/data/schema/v2.sql", territory: "data", fileRole: "data", role: "Data", links: 3, heat: "Low", icon: "table", copy: "The persisted shape of the local workbench database." },
    { id: "store", name: "Vector store", path: "src/vector-store.ts", territory: "core", fileRole: "source", role: "Source", links: 4, heat: "Low", icon: "layers", copy: "Local semantic retrieval over workspace content and attached reference material." },
    { id: "memory", name: "Memory store", path: "src/memory-store.ts", territory: "core", fileRole: "source", role: "Source", links: 4, heat: "Low", icon: "brain", copy: "Persists project knowledge so a later session can start with what earlier work learned." },
    { id: "plans", name: "Planning store", path: "src/planning-store.ts", territory: "core", fileRole: "source", role: "Source", links: 5, heat: "Medium", icon: "list-todo", copy: "Stores phases, dependencies, acceptance criteria, and plan documents across sessions." },
    { id: "notes", name: "Map notes", path: "src/graph-annotation-store.ts", territory: "graph", fileRole: "source", role: "Source", links: 3, heat: "Low", icon: "notebook-pen", copy: "Durable annotations on files and relations — including edges static analysis cannot detect." },
    { id: "tests", name: "Long-horizon tests", path: "tests/unit/agent-session.long-horizon.spec.ts", territory: "tests", fileRole: "test", role: "Test", links: 3, heat: "Low", icon: "flask-conical", copy: "Protects session behavior that only becomes visible across long, tool-heavy runs." },
    { id: "config", name: "Extension manifest", path: "package.json", territory: "project", fileRole: "config", role: "Config", links: 4, heat: "Medium", icon: "settings", copy: "Declares the six contributed views, commands, settings, and packaged extension metadata." },
    { id: "guide", name: "Getting started", path: "docs/guide/getting-started.md", territory: "docs", fileRole: "docs", role: "Docs", links: 2, heat: "Low", icon: "book-open", copy: "The public path from installation to a first useful request." },
  ];

  const EDGES = [
    { from: "app", to: "agent", kind: "import" }, { from: "app", to: "chat", kind: "import" },
    { from: "app", to: "config", kind: "config" }, { from: "agent", to: "map", kind: "import" },
    { from: "agent", to: "lsp", kind: "import" }, { from: "agent", to: "runtime", kind: "api" },
    { from: "agent", to: "plans", kind: "import" }, { from: "agent", to: "tests", kind: "import" },
    { from: "agent", to: "approval", kind: "import" }, { from: "runtime", to: "approval", kind: "import" },
    { from: "map", to: "lsp", kind: "import" }, { from: "map", to: "memory", kind: "note" },
    { from: "map", to: "plans", kind: "import" }, { from: "map", to: "notes", kind: "note" },
    { from: "chat", to: "plans", kind: "import" }, { from: "runtime", to: "data", kind: "api" },
    { from: "runtime", to: "store", kind: "import" }, { from: "data", to: "store", kind: "data" },
    { from: "data", to: "schema", kind: "data" }, { from: "plans", to: "notes", kind: "note" },
    { from: "notes", to: "memory", kind: "note" }, { from: "lsp", to: "tests", kind: "import" },
    { from: "data", to: "plans", kind: "data" }, { from: "guide", to: "config", kind: "note" },
  ];

  // Representative outputs of the same stable territory-colour system used
  // by the renderer. Colour says "where"; fileRole says "what job".
  const TERRITORY_COLORS = {
    webview: "#a78bfa", core: "#6aa7e8", graph: "#57cbbb", data: "#c4b08d",
    packages: "#8db4a8", tests: "#c78b94", project: "#93c5fd", docs: "#d6c08f",
  };
  const EDGE_COLORS = {
    import: "#8fa9d6", api: "#5eead4", data: "#a78bfa", config: "#93c5fd", note: "#ffd66b",
  };

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
    (filter === "all" || node.fileRole === filter) &&
    (!query || `${node.name} ${node.path} ${node.role} ${node.territory}`.toLowerCase().includes(query));

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
    for (const edge of EDGES) {
      const one = byId(edge.from);
      const two = byId(edge.to);
      if (!visible(one) || !visible(two)) continue;

      const p1 = project(one, box);
      const p2 = project(two, box);
      const lit = one === active || two === active;
      const color = EDGE_COLORS[edge.kind] ?? EDGE_COLORS.import;

      ctx.strokeStyle = `${color}${lit ? "a6" : "2c"}`;
      ctx.lineWidth = lit ? 1.4 : 1;
      ctx.setLineDash(edge.kind === "note" ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 20 * scale, p2.x, p2.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const node of shown) {
      const p = project(node, box);
      const isActive = node === active;
      const isHover = node === hover;
      const radius = (isActive ? 8 : isHover ? 6.5 : 4.4) * Math.min(1.25, scale);
      const color = TERRITORY_COLORS[node.territory] ?? "#8fa9d6";

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

    const routes = EDGES.filter((edge) => visible(byId(edge.from)) && visible(byId(edge.to))).length;
    if (out.files) out.files.textContent = filter === "all" && !query ? "1,284" : String(shown.length * 7 + 3);
    if (out.routes) out.routes.textContent = String(routes);
    if (out.focus) out.focus.textContent = filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1);
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
      filter = filter === selected.fileRole ? "all" : selected.fileRole;
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
