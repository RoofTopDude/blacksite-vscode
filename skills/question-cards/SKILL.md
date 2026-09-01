---
name: question-cards
description: >
  Asking the user a decision-shaped question well — picking the altitude of the real fork,
  composing options that are genuinely different directions, and rendering previews that are
  decision-ready rather than wireframes. Use before creating a plan, at a material product,
  architecture, or art-direction fork, or whenever a visual or structural choice is unverified.
version: 1
mode: plan
---

# Question cards

## When to ask

Ask early, with `question_card`, when an **unverified preference would change** scope,
architecture, visual direction, interaction model, delivery shape, or the plan itself —
before creating a new plan, adding a substantial phase batch, or crossing a material fork.

Day-to-day execution stays autonomous. Inspect facts you can discover, and make low-stakes
reversible decisions yourself. Resolve discoverable facts with tools before asking a person.

## Ask at the altitude of the real decision

Ask about product posture, information hierarchy, spatial model, motion language,
fidelity/performance envelope, authoring workflow, or system behaviour.

**Not** trivia — an isolated colour or padding value is not a fork worth a card.

## Make the options real directions

Each option should:

- combine the relevant product, visual, interaction, and technical consequences;
- differ **materially** from the others;
- carry a recommendation when the evidence supports one;
- explain what becomes easier, harder, or structurally different if chosen.

Do not present the same safe middle ground under several labels, and do not reduce an
ambitious request to whatever is easiest to draw.

## Ground every visual question in the project first

Before authoring a visual question, inspect: existing screens and components, screenshots and
reference images, stored `ui-preferences`, design tokens and stylesheets, fonts, icons and
other assets, the product domain, the target device/viewport, accessibility expectations, and
rendering/performance constraints.

**Preserve an established visual language when one exists.** If the project has no design
system yet, derive coherent candidate art directions from its audience and purpose — do not
dress it in Blacksite's own style or a generic dashboard aesthetic.

## Previews, not prose, for structural and visual forks

For layouts, brand and art direction, interaction patterns, data visualisation, animation,
game or world presentation, spatial UI, 2D or 3D scenes, output formats, and phase structures:
**render the candidates.**

There is **no complexity ceiling** on a preview. Use the project's real renderer and
dependencies through `mount` when they exist, or compose with DOM/CSS, SVG, Canvas 2D,
WebGL/WebGPU, and procedural or inlined assets through `code`.

A 3D proposal should render a real representative scene — deliberate geometry, camera,
lighting, materials, depth, motion, and interaction/state where those distinguish the
direction. Never a few labelled rectangles pretending to prove the concept.

**Treat every preview as a candidate you would be comfortable shipping**, not a wireframe
unless the user explicitly asked to compare wireframes. Show representative content and the
states needed to judge the decision. Make composition, typography, hierarchy, density,
camera/framing, animation timing, and responsive behaviour intentional. Distinct options
deserve distinct visual systems or scene logic, not cosmetic recolours.

Call `ui_preview_render`, **inspect the screenshot yourself**, correct errors, crops, weak
hierarchy and under-resolved 2D/3D treatment, and re-render until the evidence is genuinely
decision-ready.

## Previews arrive pre-themed

The user's live editor theme, a matching font stack, a reset, and semantic variables are
already applied: `--bs-bg`, `--bs-fg`, `--bs-muted`, `--bs-accent`, `--bs-surface`,
`--bs-border`, `--bs-radius`, `--bs-font`, `--bs-mono`, plus the bridged `--vscode-*` palette.

Spend the effort on what actually separates the options, and give `height` what the design
needs rather than shrinking the design to a default.

Hardcoding hex colours is usually wrong for project UI — it breaks in the other theme.
Deliberate art, illustration, data, game, and 3D palettes may use authored colours when colour
itself is part of the proposed direction.

## Remember the answer

Set `preferenceKey` on any question about how something should look or behave. Answers to
preview-bearing questions are written to `.blacksite/ui-preferences.json` automatically and
come back in your workspace state next session.

**Check that memory before re-asking a question the user has already settled**, and let a
superseding answer land on the same key rather than accumulating a second opinion beside the
first.
