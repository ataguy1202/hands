# Design write-up

## 1. Architecture

One Node process, three phases, one seam.

- **Surface** (`src/surface`): how we perceive and act. A self-contained walker runs inside every frame and produces a compact accessibility-style tree: role, computed name, the label cell to a field's left, column and row context for grid cells, a structural path, and a stable ref per node. Playwright launches the browser and dispatches real input; it does not decide what anything is. Every consumer of the surface (the model, the compiler, the replay engine, the operator console) sees the same `Observation`.
- **Discovery** (`src/discovery`): a goal spec goes in, a capability comes out. The model gets the tree (plus a screenshot) and a closed vocabulary of tools: `click`, `type`, `select`, `press`, `navigate`, `dialog`, `extract`, `wait`, `done`, `escalate`. One tool call per turn. The loop checks every decision against policy before dispatching it, records what was acted on and what changed, and the compiler turns that trace into the artifact.
- **Replay** (`src/replay`): a capability plus inputs goes in, a structured result comes out. No model. Steps resolve their control through a ranked strategy chain, act, then wait for an explicit checkpoint. Detectors for outcomes, recoveries and escalations run before every step and after every failure.
- **Control plane** (`src/session`): a lease on the live session, interventions as first-class records, and a small operator console.

Key decisions and their trade-offs:

- **I built my own perception instead of using Playwright locators or the browser's accessibility tree.** Playwright's `getByRole` cannot name a field whose only label is the `<td>` to its left, which is the normal case in server-rendered bank software. Chrome's accessibility tree has the same gap and gives me no element handle back. The walker costs about 200 lines and gives me one tree that both discovery and replay use, with the ref-to-element mapping I need to act. The cost is that I own the name computation and it will have gaps on unusual markup; the mitigation is the strategy chain, which never depends on one heuristic.
- **The model is never on the execution path.** It proposes from a closed tool set; code validates and dispatches. Guardrails therefore live in code, not in prompt wording, and every decision is a typed record I can compile.
- **The target is a mock I built, not a public site.** I needed a session that expires, an interstitial, a permission gate, a native `confirm()`, validation errors, an application error page, and an unknown dialog, all reproducible on demand. No public demo site gives you that and using one for a bank-shaped flow would exercise nothing that matters here.
- **Single process, synchronous.** A run is one browser and one lease. Queues and workers would add nothing to the questions this project is about.
- **Claude Opus 5 for discovery**, with prompt caching on the fixed system prompt and tool list. Discovery happens once per capability and replay is free, so I spend on the most capable model where a wrong path costs a re-record. Older screenshots are dropped from the context after two turns; the tree carries the state, the image helps with layout. The model client is a seam (`src/discovery/llm.ts`) with the Anthropic API and OpenRouter behind it; the recorded runs went through OpenRouter because that is the key I had. The lookup capability took 10 turns and about 96k input tokens (24k from cache), the sub-account one 16 turns and 183k (38k cached): roughly $1.20 of model spend for both, then zero per replay.

## 2. Artifact schema

A capability (`src/schema/capability.ts`) is a contract first and a step list second. Reading top to bottom: identity and status (`draft` → `verified` → `approved`), `app`, typed `inputs` with patterns, typed `outputs`, then `steps`, `success`, `outcomes`, `recoveries`, `escalations`, `policy`, `provenance`.

- **Targets are not selectors.** A target carries an ordered list of strategies, kept only if each uniquely identified the control at record time, plus a fingerprint (tag, input type, role, and the accessible name for captioned controls). Order is by how much of the app has to stay the same for it to hold: role and name; the label anchored to the left; the form field's `name` attribute, which is wired to the backend and rarely changes; exact caption text; for grid cells, column header plus a stable value in the same row (`Current Balance` in the row containing `S01`), never the cell's own value; and last, a structural CSS path, kept so a reviewer can still see where it was. The fingerprint is enforced on every strategy, not just ties. Without it, the CSS fallback for the "System Notice" dialog matched a different dialog in the same position during testing, which is exactly the false positive a structural fallback invites.
- **Values are `param`, `literal` or `secret`.** Inputs are never baked in; the compiler also converts a literal that happens to equal an input value into a param reference. Secrets are names; the runtime fills them from the environment and the artifact never holds a credential.
- **Every step can carry an `expect`**, a checkpoint that proves it took effect. The compiler derives it from what appeared after the action and was not there before: the first new heading or top-level cell in the frame that changed most, skipping anything that contains an input value. The success condition is the model's declared checkpoint text, verified visible at `done`.
- **One `Condition` vocabulary** (`visible`, `text`, `url`, `dialog`, `all_of`, `any_of`, `not`) serves checkpoints, the success condition, outcome detectors, recovery triggers and escalation triggers. One evaluator, one place to reason about it.
- **Interstitials compile to recoveries, not steps.** A click inside a dialog container that the flow did not ask for becomes `{detect: dialog visible, action: click}`, so the replay clears it if it appears and does not depend on it appearing.
- **A native dialog belongs to the click that raised it.** `steps[].dialog` records the type, a message pattern with input values generalized, and the response.
- **Provenance points at evidence**, never at the transcript. What the model said is in `evidence/<run>/transcript.json`, redacted; the artifact has to stand on its own for a reviewer and for a calling agent.

The goal spec (`src/discovery/goal.ts`) is the other half of the design: the person who knows the app declares the contract, the secrets the runtime may use, and the outcomes and runtime conditions a single happy-path run cannot observe. The model may propose outcomes it has reason to believe exist; they are merged, not trusted blindly.

## 3. Determinism & error handling

Replay never calls a model and never sleeps for a fixed time. After each action the surface waits for navigations to finish and for the DOM to go quiet (mutation observer, bounded), then polls the step's checkpoint until it holds or the budget runs out. The wait ends early if any detector fires, so a business outcome or an interstitial is handled in a quarter second, not after a timeout.

The result contract (`src/schema/result.ts`) has four terminal states and keeps them apart:

- **`outcome`**: an expected business result. `MEMBER_NOT_FOUND`, `DEPOSIT_BELOW_MINIMUM`. The caller gets a code and a description, no outputs, and nothing in the log says "error".
- **Recoveries** are not terminal. A known interstitial is dismissed; a lost session or an application error page restarts the flow from step one, which is safe because the artifact's first step is the entry point and restart is refused once an irreversible step has run. Budgets are per recovery per step, so a loop at one spot is bounded while a legitimate second occurrence after a restart is not.
- **`failed`** with a class from a closed set: `invalid_input` (rejected before the UI is touched), `policy_blocked`, `target_not_found`, `target_ambiguous`, `checkpoint_failed`, `unexpected_dialog`, `app_error`, `session_lost`, `timeout`, `recovery_exhausted`, `escalation_failed`. Each carries the step, what was expected, what was observed (the landmark on screen), and evidence: a screenshot and the perceived tree at that moment.
- **`aborted`**: a person declined to continue.

Detector order matters and is deliberate: outcomes first, because a business answer trumps everything; then declared escalations; then any dialog container no recovery knows, which escalates rather than guessing; then recoveries. Native dialogs a step does not expect are cancelled, which is the safe answer, and reported.

On a retry after a recovery or a handoff, a step whose checkpoint already holds is not run again. That is the difference between re-clicking Search and re-posting a transaction.

Drift is secondary here but visible: when a fallback strategy resolves a control, the run records `drift` with the primary and the strategy used, so a capability can be re-recorded before it breaks rather than after.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is the `Surface` interface: `observe()` returns an `Observation`, `act()` takes a `SurfaceAction` against a ref, `resolve()` matches a `Target` against an observation. Nothing above that line knows about the DOM. A legacy web app is the same surface with a harder walker (framesets are already handled; the tree carries a frame path per node). A desktop app is a second implementation that builds the same `NodeInfo` list from the OS accessibility API (UIA, AXUIElement) and dispatches input through the OS. The strategies map directly: role and name, label anchor and field name exist there too; the CSS path becomes an accessibility path; the grid strategy maps to table and cell patterns. Screenshot-and-coordinates is a third surface for the truly opaque case, where the walker would produce nodes from OCR and layout analysis and targets would lean on anchor and text strategies with a visual fingerprint. The artifact and the engine do not change.

**Multi-tenant reuse.** A capability is recorded against a vendor product (`app.id`), not a tenant. What varies between tenants running the same product is branding, field labels, a version's layout, and which interstitials appear. Each of those has a place in the design:

- Strategy chains absorb label and layout variance already; drift reporting tells you which tenants are using which fallback.
- `app.variant` marks a specialisation. The intended shape is a base artifact plus a per-variant overlay of overrides keyed by step id (a different label, an extra recovery, a changed checkpoint), applied at load time, with the base still the reviewed source of truth. A tenant that needs a new step is a new version, not an overlay.
- Version drift is detected, not guessed: replay stats (`stats.replays`, `stats.succeeded`, drift counts) per tenant show a variant degrading before it fails. When a base changes, `verify` runs per variant and a failing variant keeps its last good version.

I did not build the overlay mechanism. The artifact has the fields to carry it and the engine has one load point for it.

## 5. Escalation & handoff

**Detecting stuck.** During discovery the model has an `escalate` tool and the loop also stops on policy blocks, stale controls, and the step budget. During replay, three things escalate: a declared escalation condition (permission denied, supervisor required), a dialog container no recovery knows, and a native dialog the step did not expect. Target-not-found does not escalate; it fails with evidence, because a person cannot fix a locator from the console and pretending otherwise hides a real defect.

**Control transfer.** The session has one controller at a time, `automation` or `human`, held in the `ControlPlane`. Automation raises an intervention and blocks on it. An intervention is a record with the reason, the step, the URL, the perceived tree and a screenshot, persisted to `evidence/<run>/interventions/`. Two kinds:

- **takeover**: the person takes control. Automation cannot act (`assertAutomation()` throws). They work the same browser, either the headed window or the console's remote-hands panel, which acts on the live session through the same surface. Their actions are captured by an injected listener and recorded redacted: what they clicked, that a field changed and how long the value was, never the value. They hand back with a decision about the interrupted step: `retry_step`, `skip_step` (verified against the step's checkpoint), or `abort`.
- **approval**: nobody takes control. The person approves or denies an irreversible step and automation continues or stops.

The console (`src/session/console.ts`) is small on purpose: a list, a detail page with the live screenshot and the buttons, a JSON API under `/api` that a real console or a scripted operator would use. `scripts/operator.ts` is such an operator; the tests and the recorded evidence drive takeovers end to end through that API, including a supervisor entering an override in the live session and handing back, and a compliance attestation being cleared mid-replay (`evidence/replay-*-escalation-*`, `evidence/replay-*-supervisor-*`).

What is mocked: the console UI is minimal and single-operator; there is no queue, assignment, or auth. What is real: the lease, the pause and resume on the same session, the capture, and the evidence across the seam.

## 6. Safety

Policy is a file (`policies/meridian-coresuite.json`) enforced at the surface boundary for discovery and replay alike: allowed origins, path allowlist and denylist (the fault endpoint and sign-off are denied), allowed action kinds, and an irreversible class defined by button captions and dialog wording. Link destinations are checked before a click, not after. `javascript:` URLs are refused.

Irreversible actions run in one of three modes: `block`, `confirm` (an approval intervention; the default), or `allow` with a flag in evidence. I chose confirm as the default because a bank will want a person on the first runs of any mutating capability and the approval state on the artifact is the way to relax that later. During discovery, approving a click also covers the `confirm()` it raises; asking twice teaches operators to click through.

Redaction: secrets are referenced by name and filled from the environment; the redactor scrubs their values, any input marked sensitive, and pattern matches (SSN, card numbers) from prompts, logs, artifacts, screenshots' captions and the console. Password fields are never read. The evidence for the sub-account flow contains no nickname or deposit value beyond the parameter names.

Limits: redaction is pattern and value based, so a value that appears on screen without a known pattern or without being declared sensitive would reach the model and the logs. Screenshots are images and are not redacted; a production deployment would either mask regions from the tree's bounding boxes or keep screenshots out of long-term evidence. The allowlist is path based and does not inspect form contents. There is no rate limiting on replay.

## 7. Cuts

Left out on purpose: the variant overlay mechanism (fields exist, loader does not); a desktop surface; visual fingerprints; screenshot masking; multi-operator console with auth and assignment; outcome learning from failed replays (today the analyst declares outcomes in the goal spec, and a failure's evidence shows exactly which text to declare); assisted recovery with a bounded model call on replay failure.

What I would build next, in order: the variant overlay with per-tenant drift stats, because that is where the economics of record-once live; screenshot masking from bounding boxes; a `learn` command that promotes a `checkpoint_failed` observation into an outcome or recovery after review; then the desktop surface.

Stretch goals included: the agent-facing catalog (`bin/hands catalog --tools`, `bin/hands agent`), where a model picks a capability from typed tool definitions and the call is a deterministic replay; the draft → verified → approved gate with replay stats and `bin/hands stability`.
