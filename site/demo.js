/* The interactive extension demo on the homepage.
 *
 * Two things happen here:
 *
 *   1. A surface switcher swaps between the five views the extension actually
 *      contributes to the activity bar (Chat, Plans, Base Context, Data,
 *      Notes). The non-chat surfaces are static markup in the page; this only
 *      shows and hides them.
 *
 *   2. The Chat surface plays a scripted agent run — user turn, thinking,
 *      tool calls streaming in one at a time, an approval gate, then the
 *      answer. There is one script per request profile, and switching profile
 *      switches both the script and the accent colour, exactly the way the
 *      real panel shifts as one state.
 *
 * Nothing here talks to a model. It is a re-enactment, built from the same
 * markup and tokens as the product so it reads as the product rather than as
 * an illustration of it.
 */
(() => {
  "use strict";

  const demo = document.querySelector("[data-demo]");
  if (!demo) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const panel = demo.querySelector("[data-demo-panel]");
  const transcript = demo.querySelector("[data-transcript]");
  const dockText = demo.querySelector("[data-dock-text]");
  const progressBar = demo.querySelector("[data-demo-progress]");
  const statusModel = demo.querySelector("[data-status-model]");
  const statusTokens = demo.querySelector("[data-status-tokens]");
  const statusState = demo.querySelector("[data-status-state]");
  const replayBtn = demo.querySelector("[data-replay]");

  const svg = (name) => `<svg class="bs-icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /* ── surface switching ─────────────────────────────────────────────────── */
  const surfaceBtns = [...demo.querySelectorAll("[data-surface-btn]")];
  const surfaces = [...demo.querySelectorAll("[data-surface]")];

  function showSurface(name) {
    surfaceBtns.forEach((b) => {
      const on = b.dataset.surfaceBtn === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    surfaces.forEach((s) => s.classList.toggle("is-shown", s.dataset.surface === name));
    demo.dataset.activeSurface = name;

    const meta = SURFACE_META[name];
    if (meta) {
      if (statusModel) statusModel.textContent = meta.model;
      if (statusTokens) statusTokens.textContent = meta.tokens;
      if (statusState) statusState.textContent = meta.state;
    }

    // Only the Chat surface has a run to play.
    if (replayBtn) replayBtn.hidden = name !== "chat";
    if (name !== "chat") stop();
    else if (!played) play();
  }

  const SURFACE_META = {
    chat: { model: "claude-sonnet-4-6", tokens: "18.4k / 200k context", state: "Ready" },
    plans: { model: ".blacksite/planning.json", tokens: "3 phases · 1 active", state: "Saved" },
    context: { model: ".blacksite/base-context.json", tokens: "4 topics · 3 enabled", state: "Riding along" },
    data: { model: ".blacksite/data.sqlite", tokens: "3 tables · 1 collection", state: "Local only" },
    notes: { model: "map notes", tokens: "12 notes · 4 categories", state: "Indexed" },
  };

  surfaceBtns.forEach((b) => b.addEventListener("click", () => showSurface(b.dataset.surfaceBtn)));

  /* ── the scripts ────────────────────────────────────────────────────────
     Each profile gets a run that shows what that profile actually changes:
     Plan stays read-only and produces phases, Review reports findings without
     editing, Debug forms hypotheses before touching anything, Auto does the
     ordinary thing. */
  const SCRIPTS = {
    general: [
      { kind: "user", text: "Checkout sessions intermittently drop their retry state. Find the smallest safe fix." },
      { kind: "thinking", text: "Considering where retry state is owned" },
      {
        kind: "tools",
        rows: [
          { icon: "map", tone: "map", label: "map_impact", target: "src/agent-session.ts · depth 3", meta: "14 dependents" },
          { icon: "file-text", tone: "read", label: "file_read", target: "src/agent-session.ts", meta: "2,104 lines" },
          { icon: "waypoints", tone: "map", label: "map_path", target: "session → provider client", meta: "3 hops" },
          { icon: "brain", tone: "read", label: "code_navigate", target: "resetRetryState → 6 references", meta: "lsp" },
        ],
      },
      {
        kind: "approval",
        file: "src/agent-session.ts",
        lines: [
          ["ctx", "  async #retryTurn(turn: Turn) {"],
          ["del", "-   this.#retry.reset();"],
          ["add", "+   // Reset only after the turn is durably committed — an early"],
          ["add", "+   // reset loses the attempt count across a reconnect."],
          ["ctx", "    const result = await this.#send(turn);"],
          ["add", "+   this.#retry.reset();"],
        ],
      },
      {
        kind: "tools",
        rows: [
          { icon: "circle-check-big", tone: "ok", label: "code_diagnostics", target: "0 errors, 0 warnings", meta: "post-edit" },
          { icon: "flask-conical", tone: "ok", label: "test_run", target: "agent-session.spec.ts", meta: "41 passed" },
        ],
      },
      {
        kind: "agent",
        html:
          "Found the failure boundary. Retry state was reset one layer too early — before the turn was durably committed — so a reconnect mid-turn lost the attempt count and the request replayed as if it were the first.<br><br>" +
          "The fix is one file. <code>map_impact</code> confirmed 14 dependents, none of which read the retry counter directly, so no provider contract changes. Tests pass and diagnostics are clean.",
      },
    ],

    plan: [
      { kind: "user", text: "Plan the migration from the legacy session store to the checkpointed one. Don't implement it." },
      { kind: "thinking", text: "Read-only. Establishing the planning contract first" },
      {
        kind: "tools",
        rows: [
          { icon: "map", tone: "map", label: "map_overview", target: "4 projects · 7 dependency hubs", meta: "index 98%" },
          { icon: "folder-tree", tone: "map", label: "map_find", target: "area: src/session · sortBy degree", meta: "23 files" },
          { icon: "list-todo", tone: "plan", label: "plan_list", target: "no existing migration plan", meta: "checked" },
          { icon: "git-branch", tone: "shell", label: "git_op", target: "log --since=90d src/session", meta: "62 commits" },
        ],
      },
      {
        kind: "question",
        q: "Do consumers need to read legacy checkpoints after the cutover?",
        options: [
          { label: "Dual-read for one release", meta: "Recommended", picked: true },
          { label: "Hard cutover with a migration script", meta: "Faster" },
          { label: "Keep both indefinitely", meta: "Costly" },
        ],
      },
      {
        kind: "tools",
        rows: [
          { icon: "list-todo", tone: "plan", label: "plan_create", target: "Checkpointed session migration", meta: "3 phases" },
          { icon: "file-pen", tone: "plan", label: "plan_doc_write", target: "decision: dual-read window", meta: "phase 2" },
        ],
      },
      {
        kind: "agent",
        html:
          "Plan created — three phases, execution not started.<br><br>" +
          "<strong>1.</strong> Introduce the checkpoint writer behind a flag, dual-writing to both stores.<br>" +
          "<strong>2.</strong> Move readers over with a one-release dual-read window (your call, recorded as a decision doc).<br>" +
          "<strong>3.</strong> Remove the legacy store and its migration shim.<br><br>" +
          "The risk worth flagging: phase 1 doubles write volume on the session path, which the git history shows is already the hottest area in <code>src/session</code>. Phase 1's acceptance criteria include a write-latency check for that reason.",
      },
    ],

    review: [
      { kind: "user", text: "Review the working diff on this branch before I open the PR." },
      { kind: "thinking", text: "Read-only. Reading repository instructions before judging style" },
      {
        kind: "tools",
        rows: [
          { icon: "git-branch", tone: "shell", label: "git_op", target: "diff main...HEAD", meta: "9 files, +412 −118" },
          { icon: "file-text", tone: "read", label: "file_read", target: "AGENTS.md", meta: "project conventions" },
          { icon: "map", tone: "map", label: "map_relationships", target: "src/data/query-service.ts", meta: "11 inbound" },
          { icon: "brain", tone: "read", label: "code_hierarchy", target: "QueryService.run → 4 callers", meta: "lsp" },
        ],
      },
      {
        kind: "tools",
        rows: [
          { icon: "eye", tone: "read", label: "code_diagnostics", target: "2 warnings in changed files", meta: "verified" },
          { icon: "triangle-alert", tone: "edit", label: "report_problems", target: "2 findings published", meta: "problems panel" },
        ],
      },
      {
        kind: "agent",
        html:
          "Two findings, ordered by severity.<br><br>" +
          "<strong>High —</strong> <code>query-service.ts:214</code>. The row cap is applied after the result set is materialised, so a query returning a million rows still allocates them all before being truncated. Reproduces with any unbounded <code>SELECT</code>. Apply the limit in the statement.<br><br>" +
          "<strong>Low —</strong> <code>grid.tsx:88</code>. The paging effect re-runs on every render because its dependency array holds a fresh object literal. Visible as a duplicate fetch on first paint.<br><br>" +
          "No defects found in the other seven files. I did not exercise the pgvector path — the sidecar isn't running here, so that branch is unproven rather than clean.",
      },
    ],

    debug: [
      { kind: "user", text: "The map goes blank on large monorepos after about a minute. No errors in the console." },
      { kind: "thinking", text: "Separating observed from expected. Forming a ranked hypothesis set" },
      {
        kind: "tools",
        rows: [
          { icon: "file-text", tone: "read", label: "file_read", target: "src/graph/renderer.ts", meta: "1,840 lines" },
          { icon: "terminal", tone: "shell", label: "shell_run", target: "node --expose-gc bench/graph-soak.mjs", meta: "running" },
          { icon: "gauge", tone: "plan", label: "process_read_output", target: "heap 512MB → 3.9GB over 58s", meta: "reproduced" },
          { icon: "brain", tone: "read", label: "code_navigate", target: "addChild → 3 call sites", meta: "lsp" },
        ],
      },
      {
        kind: "approval",
        file: "src/graph/renderer.ts",
        lines: [
          ["ctx", "  #onIndexUpdate(delta: GraphDelta) {"],
          ["add", "+   // Destroy the previous batch before rebuilding. Without this the"],
          ["add", "+   // old sprites stay parented and the scene grows without bound."],
          ["add", "+   this.#batch?.destroy({ children: true });"],
          ["ctx", "    this.#batch = this.#buildBatch(delta);"],
        ],
      },
      {
        kind: "tools",
        rows: [
          { icon: "flask-conical", tone: "ok", label: "test_run", target: "graph-soak regression added", meta: "heap stable 540MB" },
          { icon: "circle-check-big", tone: "ok", label: "code_diagnostics", target: "0 errors", meta: "post-edit" },
        ],
      },
      {
        kind: "agent",
        html:
          "Root cause: the renderer rebuilt its sprite batch on every index delta without destroying the previous one. The old batches stayed parented to the scene, so the graph grew without bound — the blank screen is the GPU giving up, which is why nothing reached the console.<br><br>" +
          "Reproduced it in a soak harness first: heap climbed 512MB → 3.9GB over 58 seconds, matching your \"about a minute\". After the fix it holds at 540MB across the same run, and I added that soak as a regression test.",
      },
    ],
  };

  const PROFILE_LABEL = { general: "Auto", plan: "Planning", review: "Review", debug: "Debug" };

  /* ── run engine ─────────────────────────────────────────────────────────
     One token per run. Switching profile or leaving the Chat surface bumps
     the token, so an in-flight run's pending timers all become no-ops rather
     than interleaving with the new one. */
  let runToken = 0;
  let profile = "general";
  let played = false;

  const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : ms));

  function stop() {
    runToken++;
    demo.classList.remove("is-running");
  }

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function scrollTranscript() {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function renderUser(step) {
    const turn = el("div", "bs-turn bs-turn-user");
    turn.append(
      el("div", "bs-turn-label", `${svg("user")}You`),
      el("div", "bs-bubble", step.text),
    );
    transcript.append(turn);
  }

  function renderThinking(step) {
    const node = el("div", "bs-thinking", `${svg("brain")}<span>${step.text}<span class="bs-caret"></span></span>`);
    transcript.append(node);
    return node;
  }

  function renderToolLog() {
    const log = el("div", "bs-toollog");
    transcript.append(log);
    return log;
  }

  function renderToolRow(log, row) {
    log.append(
      el(
        "div",
        "bs-toolrow",
        `<span class="bs-tool-${row.tone}">${svg(row.icon)}</span>` +
          `<b>${row.label}</b><code>${row.target}</code><small>${row.meta}</small>`,
      ),
    );
  }

  function renderApproval(step) {
    const card = el("div", "bs-approval");
    card.append(
      el(
        "div",
        "bs-approval-head",
        `${svg("file-pen")}<span>Approve edit</span><code>${step.file}</code>`,
      ),
    );

    const diff = el("div", "bs-diff");
    for (const [tone, text] of step.lines) {
      diff.append(el("div", `bs-${tone}`, text.replace(/</g, "&lt;")));
    }
    card.append(diff);
    card.append(
      el(
        "div",
        "bs-approval-acts",
        "<span>Apply</span><span>Reject</span><span>Open diff</span>",
      ),
    );
    transcript.append(card);
  }

  function renderQuestion(step) {
    const card = el("div", "bs-qcard");
    card.append(el("p", null, step.q));
    const opts = el("div", "bs-qcard-opts");
    for (const opt of step.options) {
      opts.append(
        el(
          "span",
          opt.picked ? "is-picked" : "",
          `${opt.label}<em>${opt.meta}</em>`,
        ),
      );
    }
    card.append(opts);
    transcript.append(card);
  }

  /* Streams the answer in, chunk by chunk, without ever splitting an HTML tag
     or an entity — hence walking the markup rather than the raw string. */
  async function renderAgent(step, token) {
    const turn = el("div", "bs-turn bs-turn-agent");
    turn.append(el("div", "bs-turn-label", `${svg("sparkles")}Blacksite`));
    const bubble = el("div", "bs-bubble");
    turn.append(bubble);
    transcript.append(turn);

    if (reduceMotion) {
      bubble.innerHTML = step.html;
      scrollTranscript();
      return;
    }

    const source = el("div", null, step.html);
    const target = bubble;
    const caret = el("span", "bs-caret");
    target.append(caret);

    // Walk the source tree, mirroring nodes into the target and typing text.
    const mirror = async (from, to) => {
      for (const node of [...from.childNodes]) {
        if (token !== runToken) return;

        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          const slot = document.createTextNode("");
          to.insertBefore(slot, caret.parentNode === to ? caret : null);
          for (let i = 0; i < text.length; i += 3) {
            if (token !== runToken) return;
            slot.textContent = text.slice(0, i + 3);
            scrollTranscript();
            await wait(9);
          }
          slot.textContent = text;
        } else {
          const clone = node.cloneNode(false);
          to.insertBefore(clone, caret.parentNode === to ? caret : null);
          await mirror(node, clone);
        }
      }
    };

    await mirror(source, target);
    caret.remove();
    scrollTranscript();
  }

  async function play() {
    const token = ++runToken;
    played = true;
    transcript.replaceChildren();
    demo.classList.add("is-running");
    if (statusState) statusState.textContent = "Running";
    if (replayBtn) replayBtn.disabled = true;

    const script = SCRIPTS[profile];
    const total = script.length;

    for (let i = 0; i < total; i++) {
      if (token !== runToken) return;
      const step = script[i];

      if (progressBar) progressBar.style.width = `${((i + 1) / total) * 100}%`;

      switch (step.kind) {
        case "user":
          renderUser(step);
          if (dockText) dockText.textContent = "Ask anything about your codebase…";
          scrollTranscript();
          await wait(520);
          break;

        case "thinking": {
          const node = renderThinking(step);
          scrollTranscript();
          await wait(900);
          if (token !== runToken) return;
          node.remove();
          break;
        }

        case "tools": {
          const log = renderToolLog();
          for (const row of step.rows) {
            if (token !== runToken) return;
            renderToolRow(log, row);
            scrollTranscript();
            await wait(380);
          }
          await wait(160);
          break;
        }

        case "approval":
          renderApproval(step);
          scrollTranscript();
          await wait(1150);
          break;

        case "question":
          renderQuestion(step);
          scrollTranscript();
          await wait(1150);
          break;

        case "agent":
          await renderAgent(step, token);
          break;
      }
    }

    if (token !== runToken) return;
    demo.classList.remove("is-running");
    if (statusState) statusState.textContent = "Done";
    if (replayBtn) replayBtn.disabled = false;
  }

  /* ── profile switching ─────────────────────────────────────────────────── */
  demo.querySelectorAll("[data-profile-btn]").forEach((button) => {
    button.addEventListener("click", () => {
      profile = button.dataset.profileBtn;
      demo.querySelectorAll("[data-profile-btn]").forEach((b) => {
        b.classList.toggle("is-active", b === button);
        b.setAttribute("aria-pressed", String(b === button));
      });

      // The accent lives on the panel, so every child that reads var(--mode)
      // — bubble, chip, caret, send button, focus ring — moves together.
      panel.dataset.profile = profile;
      const chip = demo.querySelector("[data-mode-chip-label]");
      if (chip) chip.textContent = PROFILE_LABEL[profile];
      const chipIcon = demo.querySelector("[data-mode-chip-icon] use");
      if (chipIcon) {
        chipIcon.setAttribute(
          "href",
          `#i-${{ general: "sparkles", plan: "git-branch-plus", review: "scan-search", debug: "bug" }[profile]}`,
        );
      }

      showSurface("chat");
      play();
    });
  });

  if (replayBtn) replayBtn.addEventListener("click", () => play());

  /* ── start when it comes into view ─────────────────────────────────────── */
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.disconnect();
          play();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(demo);
  } else {
    play();
  }
})();
