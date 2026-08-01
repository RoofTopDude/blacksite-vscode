import * as vscode from "vscode";
import * as path from "path";
import { LocalRuntime, type CommandPolicy } from "@blacksite/local-runtime";
import { ChatProvider } from "./chat-provider.js";
import { ChromiumRunner } from "./chromium-runner.js";
import { SecretStore } from "./secret-store.js";
import { SessionStore } from "./session-store.js";
import { MemoryStore } from "./memory-store.js";
import { ReferenceStore } from "./reference-store.js";
import { loadCheckpoint, hasCheckpoint } from "./checkpoint.js";
import { registerFileWatcher, getSelectionContext, getFileContext, getDiagnosticContext } from "./workspace-context.js";
import { BlacksiteCodeActionProvider } from "./code-actions.js";
import { DiagnosticsPublisher } from "./diagnostics-publisher.js";
import { McpPanel } from "./mcp-panel.js";
import { BaseContextStore } from "./base-context-store.js";
import { PlanningStore } from "./planning-store.js";
import { TicketStore, isOpenStatus, ticketHeatWeights } from "./ticket-store.js";
import { TicketProvider } from "./ticket-provider.js";
import { TicketBoardPanel } from "./ticket-board-panel.js";
import { TicketSweepRunner } from "./ticket-sweep-runner.js";
import { BaseContextProvider } from "./base-context-provider.js";
import { PlanningProvider } from "./planning-provider.js";
import { createDataWorkbench, DataProvider } from "./data-provider.js";
import { ExtensionUpdater } from "./update-service.js";
import { GraphIndexer } from "./graph/graph-indexer.js";
import { GraphProvider, readGraphConfig } from "./graph-provider.js";
import { NotesTimelineProvider } from "./notes-timeline-provider.js";
import { AgentActivityBus } from "./agent-activity-bus.js";
import { GraphAnnotationStore } from "./graph-annotation-store.js";
import { LoopStore } from "./loops/loop-store.js";
import { LoopSupervisor } from "./loops/loop-supervisor.js";
import { LoopProvider } from "./loops/loop-view.js";
import { registerLoopCommands } from "./loops/loop-commands.js";
import { SubagentLoopDispatcher } from "./loops/loop-dispatcher.js";
import { TicketStoreLoopGateway } from "./loops/loop-ticket-gateway.js";
import { LoopToolService } from "./loops/loop-tool-provider.js";
import { reviewLoopApproval } from "./continuation/approval-review.js";
import { PlanRecoveryService, describeRecovery } from "./plans/plan-recovery-service.js";
import { PlanContinuationService } from "./plans/plan-continuation-service.js";
import { GraphAgentGateway } from "./graph-agent-gateway.js";
import { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import { StructuralSnapshot } from "./graph/structural-snapshot.js";
import { SymbolIndexer } from "./graph/symbol-indexer.js";
import { buildWorkspaceRoots, toNodeId } from "./graph/workspace-roots.js";
import { resolvePrimaryWorkspaceRoot } from "./workspace-paths.js";
import { RunStore } from "./runs/run-store.js";
import { VideoRetentionManager, type VideoRetentionPolicy } from "./runs/video-retention.js";
import { SequenceService } from "./sequences/sequence-service.js";
import { RunProvider } from "./run-provider.js";
import { RunTheaterPanel } from "./run-theater-panel.js";
import { RunFocusCoordinator } from "./runs/run-focus-coordinator.js";
import { WindowsDesktopCaptureService } from "./sequences/windows-desktop-capture.js";

let chatProvider: ChatProvider | undefined;

/** Build the runtime command-permission policy from the user's `blacksite.permissions.*` settings. */
function readCommandPolicy(): CommandPolicy {
  const cfg = vscode.workspace.getConfiguration("blacksite.permissions");
  const list = (key: string): string[] => {
    const value = cfg.get<unknown>(key, []);
    return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
  };
  return {
    allowedCommands: list("allowedCommands"),
    deniedCommands: list("deniedCommands"),
    autoApprove: list("autoApprove"),
    allowEvalFlags: cfg.get<boolean>("allowEvalFlags", false),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = resolvePrimaryWorkspaceRoot(
    vscode.workspace.getConfiguration("blacksite").get<string>("workspaceRoot"),
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
    process.cwd(),
  );

  /* The Codebase Map indexes every open workspace folder (not just the
     first), so it needs the live folder list rather than the single root
     the rest of the extension uses. Recomputed on each call so it stays
     current if folders are added/removed. */
  const getGraphRoots = () => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return buildWorkspaceRoots(folders.map((f) => ({ name: f.name, path: f.uri.fsPath })));
    }
    return buildWorkspaceRoots([{ name: "workspace", path: workspaceRoot }]);
  };

  const runtime     = new LocalRuntime(workspaceRoot, readCommandPolicy());
  // Keep the runtime's command-permission policy in sync with user settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blacksite.permissions")) runtime.setPolicy(readCommandPolicy());
    }),
  );
  const secrets     = new SecretStore(context.secrets);
  const sessionStore = new SessionStore(context);
  const memory      = new MemoryStore(workspaceRoot);
  const baseContext = new BaseContextStore(workspaceRoot);
  const planning    = new PlanningStore(workspaceRoot);
  const reference   = new ReferenceStore(workspaceRoot);
  /* Tickets derive their status from the plan executing them, and resolve their declared
     territory against the live Codebase Map index — both read lazily so the store stays
     independently constructible (and unit-testable) without either. */
  const tickets = new TicketStore(
    workspaceRoot,
    () => planning.read().plans.map((plan) => ({
      id: plan.id,
      status: plan.status,
      executionApproved: plan.executionApproved,
      phases: plan.phases.map((phase) => ({ id: phase.id, status: phase.status })),
    })),
    () => vscode.workspace.getConfiguration("blacksite.tickets").get<boolean>("agentMayClose", false),
    () => graphIndexer.indexedFiles(),
    () => vscode.workspace.getConfiguration("blacksite.tickets").get<string>("idPrefix", "BLK") || "BLK",
  );
  // Non-fatal: these write to workspaceRoot which may be unwritable (e.g. system
  // cwd when no folder is open). The extension still activates without storage.
  try { memory.ensureInitialized(); } catch { /* ok — memory runs read-only */ }
  try { baseContext.ensureInitialized(); } catch { /* ok */ }
  try { planning.ensureInitialized(); } catch { /* ok */ }
  try { tickets.ensureInitialized(); } catch { /* ok — the queue runs read-only */ }
  try { reference.ensureInitialized(); } catch { /* ok — reference attachments run read-only */ }
  context.subscriptions.push(baseContext, planning, tickets);

  const diagnostics = new DiagnosticsPublisher(workspaceRoot);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  // Embedded database substrate. Bootstrapping is non-fatal: if no SQLite binding is
  // present the workbench reports an unavailable status and everything else still runs.
  const dataWorkbench = createDataWorkbench(context, workspaceRoot);
  context.subscriptions.push({ dispose: () => dataWorkbench.dispose() });

  const activityBus = new AgentActivityBus();
  const graphAnnotations = new GraphAnnotationStore(getGraphRoots);
  try { graphAnnotations.ensureInitialized(); } catch { /* ok — map annotations run read-only */ }
  const graphIndexer = new GraphIndexer(getGraphRoots, () => readGraphConfig());
  /* Validate note endpoints against the full *indexed* set, not just the
     rendered stars — on a large workspace a real .cs file can be indexed but
     beyond the render cap, and a relationship note on it must still persist. */
  graphAnnotations.setNodeLookup(() => {
    const files = graphIndexer.indexedFiles();
    return files.length > 0 ? new Set(files) : null;
  });
  /* One shared relationship snapshot feeds both the map webview (Services lens)
     and the agent's map_relationships tool, so the expensive scan runs once per
     index generation regardless of who asks. */
  const relationshipSnapshot = new RelationshipSnapshot(getGraphRoots, graphIndexer, () => readGraphConfig());
  /* Cross-project cycles + per-neighborhood cul-de-sacs (orphans/pockets) — cheap
     graph algorithms over data the indexer already has, recomputed per generation
     like the relationship snapshot above, never persisted to the render cache. */
  const structuralSnapshot = new StructuralSnapshot(graphIndexer);
  /* Opt-in background symbol sweep (call/reference/supertype edges over the whole
     corpus). Off by default; re-pointed at the corpus after each rebuild and
     paused while the user edits. */
  const symbolIndexer = new SymbolIndexer(getGraphRoots, () => readGraphConfig().backgroundSymbols);
  graphIndexer.onDidChange(() => symbolIndexer.update(graphIndexer.corpusFiles()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => symbolIndexer.pause()),
    vscode.window.onDidChangeActiveTextEditor(() => symbolIndexer.pause()),
  );
  /* Gateway lets agent-session dispatch every graph.* op to one object: notes go
     to the durable store, map_overview/map_relationships to the live index + snapshot. */
  const graphGateway = new GraphAgentGateway(graphAnnotations, graphIndexer, relationshipSnapshot, getGraphRoots, () => symbolIndexer.edges(), structuralSnapshot);
  const ticketSweep = new TicketSweepRunner(getGraphRoots, () => graphIndexer.indexedFiles(), () => tickets.read().tickets);
  tickets.setSweepProvider(ticketSweep);
  context.subscriptions.push(activityBus, graphAnnotations, symbolIndexer);

  const chromium = new ChromiumRunner();
  const runFocus = new RunFocusCoordinator();
  const desktopCapture = new WindowsDesktopCaptureService(context.workspaceState, workspaceRoot);
  let runStore: RunStore | undefined;
  let sequences: SequenceService | undefined;
  try {
    runStore = new RunStore(workspaceRoot).open();
    const readVideoPolicy = (): VideoRetentionPolicy => {
      const cfg = vscode.workspace.getConfiguration("blacksite.runs.video");
      const degradeAfterDays = Math.max(0, cfg.get<number>("degradeAfterDays", 1));
      return {
        enabled: cfg.get<boolean>("enabled", false),
        maxDiskMb: Math.max(64, cfg.get<number>("maxDiskMb", 512)),
        degradeAfterDays,
        deleteAfterDays: Math.max(degradeAfterDays + 1, cfg.get<number>("deleteAfterDays", 3)),
        keyframeIntervalMs: Math.min(5_000, Math.max(250, cfg.get<number>("keyframeIntervalMs", 500))),
      };
    };
    const videoRetention = new VideoRetentionManager(runStore, readVideoPolicy);
    sequences = new SequenceService({
      workspaceRoot,
      runStore,
      runtime,
      browser: chromium,
      planning,
      tickets,
      commandPolicy: readCommandPolicy,
      focus: runFocus,
      desktop: desktopCapture,
      videoPolicy: readVideoPolicy,
      videoRetentionSweep: () => videoRetention.sweep(),
    });
    const pruneRuns = () => {
      const cfg = vscode.workspace.getConfiguration("blacksite.runs");
      const daysAgo = (days: number) => new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
      const protectedRunIds = new Set<string>();
      for (const plan of planning.read().plans) {
        if (plan.status === "archived" || plan.status === "completed" || plan.status === "cancelled") continue;
        for (const phase of plan.phases) {
          for (const runId of phase.runEvidence?.runIds ?? []) protectedRunIds.add(runId);
          if (phase.runEvidence?.baselineRunId) protectedRunIds.add(phase.runEvidence.baselineRunId);
        }
      }
      for (const ticket of tickets.read().tickets) {
        if (!isOpenStatus(ticket.status)) continue;
        for (const runId of ticket.runIds) protectedRunIds.add(runId);
      }
      runStore?.pruneRuns({
        temporaryOlderThan: daysAgo(cfg.get<number>("temporaryRetentionDays", 7)),
        standardOlderThan: daysAgo(cfg.get<number>("standardRetentionDays", 30)),
        maxRuns: Math.max(25, cfg.get<number>("maxRuns", 500)),
        protectedRunIds: [...protectedRunIds],
      });
    };
    pruneRuns();
    void videoRetention.sweep();
    const pruneTimer = setInterval(pruneRuns, 24 * 60 * 60 * 1_000);
    const videoRetentionTimer = setInterval(() => { void videoRetention.sweep(); }, 24 * 60 * 60 * 1_000);
    pruneTimer.unref();
    videoRetentionTimer.unref();
    context.subscriptions.push(runStore, { dispose: () => {
      clearInterval(pruneTimer);
      clearInterval(videoRetentionTimer);
    } });
  } catch (error) {
    console.warn("[Blacksite] Execution Runs storage unavailable:", error instanceof Error ? error.message : String(error));
  }

  chatProvider = new ChatProvider(
    context,
    runtime,
    secrets,
    sessionStore,
    workspaceRoot,
    memory,
    diagnostics,
    planning,
    dataWorkbench.surface ?? undefined,
    dataWorkbench.manager,
    reference,
    activityBus,
    graphGateway,
    tickets,
    sequences,
    chromium,
  );
  const baseContextProvider = new BaseContextProvider(context, workspaceRoot, baseContext);
  const planningProvider = new PlanningProvider(context, planning, workspaceRoot, getGraphRoots);
  /* The plan vocabulary the ticket surfaces link against. Titles come along so the picker
     offers "Retire the legacy gateway" rather than an opaque id the user has to recognize. */
  const linkablePlans = (): Array<{ id: string; title: string; status?: string }> =>
    planning.read().plans.map((plan) => ({ id: plan.id, title: plan.title, status: plan.status }));
  const ticketProvider = new TicketProvider(context, tickets, workspaceRoot, getGraphRoots, () => graphIndexer.indexedFiles(), linkablePlans);
  const dataProvider = new DataProvider(context, workspaceRoot, dataWorkbench);
  const updater = new ExtensionUpdater(context);
  const graphProvider = new GraphProvider(
    context, getGraphRoots, graphIndexer, relationshipSnapshot, structuralSnapshot, activityBus, graphAnnotations,
    () => symbolIndexer.edges(),
    () => {
      const document = tickets.read();
      const indexed = graphIndexer.indexedFiles();
      return {
        ...ticketHeatWeights(document.tickets, indexed),
        tickets: document.tickets
          .filter((ticket) => isOpenStatus(ticket.status))
          .map((ticket) => ({
            id: ticket.id,
            title: ticket.title,
            status: ticket.status,
            priority: ticket.priority,
            files: tickets.resolveTerritoryFor(ticket).files,
            blockedBy: ticket.blockedBy,
          })),
      };
    },
    sequences,
  );
  const runProvider = runStore && sequences
    ? new RunProvider(context, runStore, sequences, {
        openOnMap: (target) => graphProvider.revealRun(
          target.runId,
          sequences.elapsedMsAtSequence(target.runId, target.sequenceNumber),
        ),
      })
    : undefined;
  /* One run at a time, in an editor tab: watch it happen, then scrub back through it. Separate
     from the sidebar because it follows a single run and appends, where the sidebar browses every
     run and replaces its state wholesale. */
  const runTheater = runStore && sequences
    ? new RunTheaterPanel(context, runStore, sequences, {
        askAgent: ({ text, label }) => chatProvider?.injectContext(text, label),
        focus: runFocus,
        openMap: ({ runId, sequenceNumber }) => graphProvider.revealRun(
          runId,
          sequences?.elapsedMsAtSequence(runId, sequenceNumber) ?? 0,
        ),
      })
    : undefined;
  if (runTheater) context.subscriptions.push(runTheater);
  context.subscriptions.push(vscode.commands.registerCommand("blacksite.runs.authorizeExternalApplication", async () => {
    if (!desktopCapture.available()) {
      void vscode.window.showInformationMessage("External application capture is currently available on Windows only.");
      return;
    }
    const candidates = await desktopCapture.enumerateForUser();
    const selected = await vscode.window.showQuickPick(candidates.map((candidate) => ({
      label: candidate.title,
      description: path.basename(candidate.executablePath),
      detail: candidate.executablePath,
      candidate,
    })), { title: "Approve a window for read-only capture", placeHolder: "Only the selected window can be captured" });
    if (!selected) return;
    const label = await vscode.window.showInputBox({
      title: "Name this external application binding",
      prompt: "The agent sees this label and an opaque binding ID, never unrelated window titles.",
      value: selected.label,
      validateInput: (value) => value.trim() ? undefined : "A label is required.",
    });
    if (!label) return;
    await desktopCapture.authorize(selected.candidate, label);
    void vscode.window.showInformationMessage(`Approved “${label}” for read-only window capture.`);
  }));
  /* Ticket heat is a Map lens over ticket state, so a ticket mutation has to reach the Map
     the same way an annotation change does. */
  context.subscriptions.push(tickets.onDidChange(() => graphProvider.notifyTicketsChanged()));
  if (runStore) context.subscriptions.push(runStore.onDidChange(() => graphProvider.notifyRunsChanged()));
  context.subscriptions.push(symbolIndexer.onDidChange(() => graphProvider.notifySymbolEdgesChanged()));
  /* Notes timeline (editor tab): scrollable history of map notes with per-file
     git history + commit diffs. Cross-wired after construction so "Show on
     map" and the Map's "Notes timeline" button can reach each other. */
  const notesTimeline = new NotesTimelineProvider(context, getGraphRoots, graphAnnotations, (nodeId) => graphProvider.revealNote(nodeId));
  graphProvider.setNotesTimelineOpener(() => notesTimeline.open());
  /* A plan phase's declared map territory is only useful if it's navigable —
     let the Plans panel fly the Map to any file the phase claims. */
  planningProvider.setMapRevealer((nodeId) => graphProvider.revealNote(nodeId));
  /* Same for a ticket's declared territory — a queue you can't navigate from is a list. */
  ticketProvider.setMapRevealer((nodeId) => graphProvider.revealNote(nodeId));
  /* The board is the same data at board density: sidebar for the focused queue, editor tab
     for the whole field. Both read the one store, so an edit in either lands in the other. */
  const ticketBoard = new TicketBoardPanel(context, tickets, workspaceRoot, getGraphRoots, () => graphIndexer.indexedFiles(), linkablePlans);
  ticketBoard.setMapRevealer((nodeId) => graphProvider.revealNote(nodeId));
  /* A ticket linked to a plan takes its status from that plan, so a plan mutation has to
     re-push both queues — otherwise they show a stale status until the next ticket edit. */
  context.subscriptions.push(planning.onDidChange(() => {
    ticketProvider.notifyPlansChanged();
    ticketBoard.notifyPlansChanged();
  }));
  /* Both surfaces can turn what they know into work: a map note that records something still
     to be done, and a plan phase that turns up work it shouldn't absorb. Filing is the
     alternative to scope creep in both cases. */
  const fileTicketFromSurface = (input: Record<string, unknown>) => {
    /* Map notes stay in place after promotion. Avoid turning a double-click or
       the same note shown in two surfaces into duplicate ticket outcomes. */
    const originRef = typeof input.originRef === "string" ? input.originRef : "";
    if (input.origin === "map_note" && originRef) {
      const existing = tickets.read().tickets.find((ticket) => ticket.origin === "map_note"
        && ticket.originRef === originRef && isOpenStatus(ticket.status));
      if (existing) return { ok: true, ticketId: existing.id, existing: true };
    }
    return tickets.fileTicket(input, { sessionId: "webview" });
  };
  notesTimeline.setTicketFiler(fileTicketFromSurface);
  planningProvider.setTicketFiler(fileTicketFromSurface);
  graphProvider.setTicketFiler(fileTicketFromSurface);
  const fileRunAnomaly = async ({ run, event, observation }: {
    run: import("./runs/run-model.js").ExecutionRun;
    event?: import("./runs/run-model.js").RunEvent;
    observation?: import("./runs/run-model.js").ObservationBundle;
  }) => {
    const refs = [...(event?.entityRefs ?? []), ...(observation?.entityRefs ?? [])];
    const files = [...new Set(refs
      .map((ref) => ref.workspacePath)
      .filter((value): value is string => Boolean(value)))];
    const evidenceRefs = [
      `Execution run: ${run.id}`,
      event ? `Event: ${event.id} (${event.type})` : "",
      observation ? `Observation: ${observation.id}` : "",
    ].filter(Boolean);
    const result = tickets.fileTicket({
      title: `Investigate ${event?.type ?? "execution run anomaly"}`,
      description: evidenceRefs.join("\n"),
      priority: event?.severity === "fatal" || event?.severity === "error" ? "high" : "normal",
      labels: ["execution-run", ...(event ? [event.type] : [])],
      files,
      runIds: [run.id],
      origin: "diagnostic",
      originRef: event?.id ?? observation?.id ?? run.id,
    }, { sessionId: "webview" });
    if (result["ok"] !== true) {
      throw new Error(String(result["error"] ?? "Could not file the anomaly ticket."));
    }
    await vscode.commands.executeCommand("blacksite.tickets.focus");
  };
  runProvider?.setAnomalyTicketFiler(fileRunAnomaly);
  runTheater?.setAnomalyTicketFiler(fileRunAnomaly);
  context.subscriptions.push(notesTimeline, ticketBoard);
  graphIndexer.start();
  context.subscriptions.push(baseContextProvider, planningProvider, ticketProvider, dataProvider, graphIndexer, graphProvider);
  if (runProvider) context.subscriptions.push(runProvider);

  // The database assistant reuses the chat provider's configured model + secrets.
  if (dataWorkbench.surface) {
    dataProvider.setAssistant(chatProvider.createDataAssistant(dataWorkbench.surface));
  }
  // The Data workbench's vector search reuses the unified embedding-model setting.
  dataProvider.setEmbedder(chatProvider.createEmbedder());

  // ── Webview panel ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.plans", planningProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.tickets", ticketProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.baseContext", baseContextProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.data", dataProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.map", graphProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  if (runProvider) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("blacksite.runs", runProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  }

  // ── Ticket loops ───────────────────────────────────────────
  /* A loop drains a ticket queue into a review pile, unattended, for as long as it takes.
     Everything that decides what one does lives in src/loops and is unit-tested against fakes;
     this block only supplies the real ticket store, the real delegation path, and the surface. */
  const loops = new LoopStore(workspaceRoot);
  try { loops.ensureInitialized(); } catch { /* ok — loops run read-only */ }
  // Local binding: the module-level `chatProvider` is nullable by declaration, and a loop
  // dispatching hours from now must not re-check that on every lane.
  const chat = chatProvider;
  const loopViewRef: { current: LoopProvider | undefined } = { current: undefined };
  const loopSupervisor = new LoopSupervisor(
    loops,
    new TicketStoreLoopGateway(tickets, () => graphIndexer.indexedFiles()),
    new SubagentLoopDispatcher({
      providerFor: (policy) => chat.createHeadlessSubagentProvider(policy),
      estimateUsageCostUsd: (usage) => chat.estimateSubagentUsageCostUsd(usage),
      reviewApproval: ({ loopId, ticket, tier, toolName, description }) => reviewLoopApproval(
        chat.createContinuationModel(),
        {
          loopId,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          ...(ticket.description ? { ticketDescription: ticket.description } : {}),
          acceptanceCriteria: ticket.acceptanceCriteria,
          territory: [...ticket.territory.files, ...ticket.territory.areas],
          userPrompts: chat.userPromptsThisSession(),
          tier,
          toolName,
          description,
        },
      ),
      sessionId: () => chat.currentSessionId() ?? "loop",
    }),
    {
      notify: (_loopId, message) => loopViewRef.current?.notify(message),
      onError: (loopId, error) => console.warn(`[Blacksite] loop ${loopId} error:`, error),
    },
  );
  const loopView = new LoopProvider(
    context,
    loops,
    loopSupervisor,
    tickets,
    () => graphIndexer.indexedFiles(),
    {
      openTicket: (ticketId) => ticketProvider.reveal(ticketId),
      askAgent: async (message, label) => {
        chat.injectContext(message, label);
        await vscode.commands.executeCommand("blacksite.chat.focus");
      },
    },
  );
  loopViewRef.current = loopView;
  context.subscriptions.push(
    loops,
    loopView,
    vscode.window.registerWebviewViewProvider("blacksite.loops", loopView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  chat.setLoopToolProvider(new LoopToolService(
    loops,
    loopSupervisor,
    () => tickets.read().tickets,
    () => graphIndexer.indexedFiles(),
    () => loopView.refresh(),
  ));
  /* Any loop left `running` when the host died is reconciled to paused with its in-flight
     lanes marked abandoned. Resuming a paid unattended run after a crash is the user's call. */
  const restoredLoops = loopSupervisor.restore();
  if (restoredLoops.length) {
    loopView.notify(
      `Blacksite: ${restoredLoops.length} ticket loop(s) were interrupted by a restart and are paused. `
      + "Their in-flight lanes were marked abandoned; resume them from the Loops view when ready.",
      "error",
    );
  }
  registerLoopCommands(context, loopView);

  // ── Plan continuation ──────────────────────────────────────
  /* The conductor: when an approved plan's turn ends without finishing it, a fresh agent
     holding the user's original prompts decides whether to continue, escalate, or halt. Off by
     default — it spends model calls and agent turns with nobody watching. */
  const planContinuation = new PlanContinuationService(
    planning,
    () => chat.createContinuationModel(),
    () => chat.userPromptsThisSession(),
    () => {
      const cfg = vscode.workspace.getConfiguration("blacksite.planContinuation");
      return {
        enabled: cfg.get<boolean>("enabled", false),
        maxConsecutive: Math.max(1, Math.min(20, cfg.get<number>("maxConsecutive", 5))),
      };
    },
    {
      continueWith: (message, rationale) => chat.continuePlanTurn(message, rationale),
      report: (kind, message) => {
        if (kind === "halt") void vscode.window.showWarningMessage(`Blacksite: ${message}`);
        else void vscode.window.showInformationMessage(`Blacksite: ${message}`);
        chat.reportPlanContinuation(kind, message);
      },
      trace: (message) => chat.reportPlanContinuation("trace", message),
    },
  );
  chat.setPlanContinuation(planContinuation);

  // ── Plan recovery ──────────────────────────────────────────
  /* Runs once, here, before any agent session exists — which is what makes it sound. At this
     instant every step still marked in_progress is provably stranded, because no session
     survives a host restart. See src/plans/plan-recovery.ts. */
  void new PlanRecoveryService(planning).recover().then((outcome) => {
    const summary = describeRecovery(outcome);
    // Silent when there was nothing to recover: a message every launch would train people to
    // ignore the one launch where it mattered.
    if (summary) console.log(`[Blacksite] plan recovery: ${summary}`);
    if (outcome.failed.length) {
      void vscode.window.showWarningMessage(
        `Blacksite: ${outcome.failed.length} plan step(s) still read as in progress after an interrupted `
        + "session and could not be reset. Check the Plans panel before continuing them.",
      );
    }
  });

  // ── Ticket commands ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openRuns", () => {
      void vscode.commands.executeCommand("blacksite.runs.focus");
    }),
    vscode.commands.registerCommand("blacksite.openRunTheater", (runId?: string) => {
      if (!runTheater) {
        void vscode.window.showInformationMessage("Execution runs are unavailable in this workspace.");
        return;
      }
      runTheater.open(typeof runId === "string" && runId ? runId : undefined);
    }),
    vscode.commands.registerCommand("blacksite.openTickets", () => {
      void vscode.commands.executeCommand("blacksite.tickets.focus");
    }),
    vscode.commands.registerCommand("blacksite.openBoard", (ticketId?: string) => {
      ticketBoard.open(typeof ticketId === "string" && ticketId ? ticketId : undefined);
    }),
    vscode.commands.registerCommand("blacksite.fileTicket", async (uri?: vscode.Uri) => {
      const title = await vscode.window.showInputBox({
        title: "Blacksite: File a ticket",
        prompt: "State the outcome, not the activity",
        placeHolder: "Retry backoff drifts from gateway TTL",
      });
      if (!title?.trim()) return;
      /* Invoked from an editor or explorer context menu, the file in hand is almost always
         what the ticket is about — seed the territory rather than making them type it. */
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const files: string[] = [];
      if (target) {
        const nodeId = toNodeId(getGraphRoots(), target.fsPath);
        if (nodeId) files.push(nodeId);
      }
      const result = tickets.fileTicket({ title, origin: "user", status: "backlog", files }, { sessionId: "webview" });
      if ((result as { ok?: boolean }).ok) {
        void vscode.commands.executeCommand("blacksite.tickets.focus");
      }
    }),
    vscode.commands.registerCommand("blacksite.sweepForTickets", async () => {
      const controller = new AbortController();
      let result;
      try {
        result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "Blacksite: scanning for ticket proposals",
            cancellable: true,
          },
          async (_progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            return ticketSweep.run({}, controller.signal);
          },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        void vscode.window.showErrorMessage(`Blacksite: ticket sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (result.proposals.length === 0) {
        void vscode.window.showInformationMessage("Blacksite: no new diagnostic or TODO/FIXME ticket proposals found.");
        return;
      }
      const picks = await vscode.window.showQuickPick(
        result.proposals.map((proposal) => ({
          label: proposal.title,
          description: `${proposal.priority} · ${proposal.file}${proposal.line ? `:${proposal.line}` : ""}`,
          detail: `${proposal.source}${proposal.detail ? ` · ${proposal.detail}` : ""}`,
          proposal,
        })),
        {
          title: "Blacksite: propose triage tickets",
          placeHolder: "Select the proposals to file into triage (nothing is accepted automatically)",
          canPickMany: true,
        },
      );
      if (!picks?.length) return;
      let filed = 0;
      for (const pick of picks) {
        const proposal = pick.proposal;
        const saved = tickets.fileTicket({
          title: proposal.title,
          description: `${proposal.source === "diagnostic" ? "Published diagnostic" : "Marker"}${proposal.detail ? `: ${proposal.detail}` : ""}`,
          files: [proposal.file],
          priority: proposal.priority,
          origin: "diagnostic",
          originRef: `sweep:${proposal.key}`,
          status: "triage",
        }, { sessionId: "webview" });
        if ((saved as { ok?: boolean }).ok) filed += 1;
      }
      if (filed > 0) {
        void vscode.window.showInformationMessage(`Blacksite: filed ${filed} triage ticket${filed === 1 ? "" : "s"}.`);
        void vscode.commands.executeCommand("blacksite.tickets.focus");
      }
    }),
  );

  // ── Codebase Map commands ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openMap", () => {
      void vscode.commands.executeCommand("blacksite.map.focus");
    }),
    vscode.commands.registerCommand("blacksite.openMapInEditor", () => {
      graphProvider.openFullPage();
    }),
    vscode.commands.registerCommand("blacksite.rebuildMap", () => {
      graphProvider.refresh();
    }),
    vscode.commands.registerCommand("blacksite.openMapNotes", () => {
      notesTimeline.open();
    }),
  );

  // ── Data workbench commands ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openData", () => {
      void vscode.commands.executeCommand("blacksite.data.focus");
    }),
    vscode.commands.registerCommand("blacksite.refreshData", () => {
      dataProvider.refresh();
    }),
    vscode.commands.registerCommand("blacksite.runQuery", async () => {
      const sql = await vscode.window.showInputBox({
        title: "Blacksite: Run Database Query",
        prompt: "Enter SQL to load into the Data workbench Query tab",
        placeHolder: "SELECT * FROM v_recent_agent_activity LIMIT 50",
      });
      if (!sql) return;
      await vscode.commands.executeCommand("blacksite.data.focus");
      dataProvider.loadQueryIntoEditor(sql);
    }),
    vscode.commands.registerCommand("blacksite.openSavedQuery", async () => {
      const surface = dataWorkbench.surface;
      if (!surface) {
        vscode.window.showWarningMessage("Blacksite: The database engine is unavailable.");
        return;
      }
      const saved = surface.listSavedQueries();
      if (saved.length === 0) {
        vscode.window.showInformationMessage("Blacksite: No saved queries yet.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        saved.map((q) => ({ label: q.name, description: q.sql.slice(0, 80), id: q.id })),
        { title: "Open Saved Query", placeHolder: "Select a saved query" },
      );
      if (!pick) return;
      const query = surface.getSavedQuery(pick.id);
      if (query) {
        await vscode.commands.executeCommand("blacksite.data.focus");
        dataProvider.loadQueryIntoEditor(query.sql);
      }
    }),
  );

  // ── Code action provider (Fix/Explain in the editor gutter) ─
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new BlacksiteCodeActionProvider(),
      { providedCodeActionKinds: BlacksiteCodeActionProvider.providedCodeActionKinds },
    ),
  );

  // ── Commands ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openChat", () => {
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.clearChat", () => {
      chatProvider?.clearMessages();
    }),
  );

  /* Chat reads best on the right, opposite the file tree — but VS Code has no contribution
     point for the secondary side bar: `viewsContainers` accepts only `activitybar` and
     `panel`, and moving a view there is a user gesture. So this focuses the view and drives
     the workbench's own move command, falling back to telling the user how to drag it if
     that command isn't present in their VS Code build. */
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.moveChatToRightPanel", async () => {
      await vscode.commands.executeCommand("blacksite.chat.focus");
      const available = new Set(await vscode.commands.getCommands(true));
      const mover = ["workbench.action.moveFocusedViewToSecondarySideBar", "workbench.action.moveFocusedViewToRightSideBar"]
        .find((command) => available.has(command));
      if (!mover) {
        void vscode.window.showInformationMessage(
          "Blacksite: your VS Code build has no command for this. Drag the Blacksite Chat icon from the Activity Bar onto the right-hand edge of the window to dock chat there.",
        );
        return;
      }
      try {
        await vscode.commands.executeCommand(mover);
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      } catch {
        void vscode.window.showInformationMessage(
          "Blacksite: couldn't move the view automatically. Drag the Blacksite Chat icon onto the right-hand edge of the window instead.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.cancelRun", () => {
      chatProvider?.cancelCurrentRun();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "anthropic", value: "anthropic" },
          { label: "openrouter", value: "openrouter" },
          { label: "openai", value: "openai" },
          { label: "bedrock", value: "bedrock", description: "AWS region + access/secret keys" },
          { label: "github", value: "github" },
          { label: "gitlab", value: "gitlab" },
          { label: "jira", value: "jira" },
          { label: "confluence", value: "confluence" },
          { label: "salesforce", value: "salesforce" },
        ],
        { placeHolder: "Select provider", title: "Blacksite: Set API Key / Credentials" },
      );
      if (!provider) return;
      await secrets.promptForApiKey(provider.value);
    }),
  );

  // Explain the current editor selection in chat
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.explainSelection", () => {
      const ctx = getSelectionContext();
      if (!ctx) {
        vscode.window.showWarningMessage("Blacksite: Select some code first.");
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  // Ask about a file — triggered from editor or explorer context menu
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.askAboutFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage("Blacksite: No file selected.");
        return;
      }
      const ctx = getFileContext(target);
      if (!ctx) {
        vscode.window.showWarningMessage(`Blacksite: Could not read ${path.basename(target.fsPath)}.`);
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  // Fix a specific diagnostic — called from code action, not command palette
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "blacksite.fixDiagnostic",
      async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        const base = getDiagnosticContext(uri, diagnostic);
        let ctx = base;
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const startLine = Math.max(0, diagnostic.range.start.line - 3);
          const endLine   = Math.min(doc.lineCount - 1, diagnostic.range.end.line + 3);
          const snippet   = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
          ctx = { ...base, text: `${base.text}\n\n\`\`\`${doc.languageId}\n${snippet}\n\`\`\`` };
        } catch { /* use base ctx */ }
        chatProvider?.injectContext(ctx.text, ctx.label);
        void vscode.commands.executeCommand("blacksite.chat.focus");
      },
    ),
  );

  // MCP server management panel
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.manageMcp", () => {
      McpPanel.show(context);
    }),
  );

  // Clear any problems Blacksite has surfaced into the Problems panel
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.clearProblems", () => {
      diagnostics.clear();
    }),
  );

  // Close the Chromium browser window (the runner re-opens it on next use)
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.closeBrowser", async () => {
      await chatProvider?.closeBrowser();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.showLogs", () => {
      chatProvider?.showLogs();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.compactConversation", async () => {
      await chatProvider?.compactConversation();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.addFileToBaseContext", async (uri?: vscode.Uri) => {
      await baseContextProvider.promptAndAddFile(uri);
    }),
  );

  // Attach a file to the current chat conversation — triggered from editor or explorer context menu
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.attachFileToChat", async (uri?: vscode.Uri) => {
      await vscode.commands.executeCommand("blacksite.chat.focus");
      await chatProvider?.attachFileFromCommand(uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.checkForUpdates", async () => {
      await updater.checkForUpdates({ manual: true });
    }),
  );

  // ── File watcher (live workspace context refresh) ──────────
  const watcher = registerFileWatcher(workspaceRoot, () => {
    // Context is re-gathered on each send() call — watcher is a hook for future caching
  });
  context.subscriptions.push(watcher);

  // ── Checkpoint resume ──────────────────────────────────────
  if (hasCheckpoint(context)) {
    const cp = loadCheckpoint(context);
    if (cp) {
      // Defer until after activation so the webview has time to mount
      setTimeout(() => {
        // This runs outside VS Code's command/request promise chain. Contain a
        // failure here so a bad persisted checkpoint cannot crash the host.
        void chatProvider?.offerCheckpointResume(cp).catch((error) => {
          console.error("Blacksite: checkpoint resume prompt failed", error);
        });
      }, 1500);
    }
  }

  setTimeout(() => {
    // Startup maintenance must never turn into an unhandled rejection.
    void updater.maybeCheckForUpdates().catch((error) => {
      console.error("Blacksite: startup update check failed", error);
    });
  }, 2500);

  // …and keep checking, so a window that stays open for days still sees a release.
  context.subscriptions.push(updater.scheduleUpdateChecks());
}

export function deactivate(): void {
  chatProvider = undefined;
}
