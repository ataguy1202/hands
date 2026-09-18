# Design write-up

## 1. Architecture

One Node process, three phases, one seam.

- **Surface** (`src/surface`): perception and action. A self-contained walker runs inside every frame and produces a compact accessibility-style tree: role, computed name, the label cell to a field's left, column and row context for grid cells, a structural path, a stable ref per node. Playwright launches the browser and dispatches real input; it does not decide what anything is. Everything else sees the same `Observation`.
- **Discovery** (`src/discovery`): goal spec in, capability out. The model gets the tree plus a screenshot and a closed vocabulary of tools (`click`, `type`, `select`, `press`, `navigate`, `dialog`, `extract`, `wait`, `done`, `escalate`), one call per turn. The loop checks each decision against policy, dispatches it, records what was acted on and what changed; the compiler turns the trace into the artifact.
- **Replay** (`src/replay`): capability plus inputs in, structured result out. No model. Each step resolves its control through a ranked strategy chain, acts, then waits for an explicit checkpoint. Detectors for outcomes, recoveries and escalations run before every step and after every failure.
- **Control plane** (`src/session`): a lease on the live session, interventions as records, a small operator console.

Decisions and trade-offs:

- **Own perception, not Playwright locators or the browser's accessibility tree.** `getByRole` cannot name a field whose only label is the `<td>` to its left, the normal case in server-rendered bank software; Chrome's accessibility tree has the same gap and returns no element handle. The walker is about 200 lines and gives discovery and replay one tree with the ref-to-element mapping needed to act. The cost is owning the name computation; the mitigation is that no target depends on one heuristic.
- **The model is never on the execution path.** It proposes from a closed tool set; code validates and dispatches. Guardrails live in code, and every decision is a typed record the compiler can use.
- **A mock target, not a public site.** I needed session expiry, an interstitial, a permission gate, a native `confirm()`, validation errors, an application error page and an unknown dialog, reproducible on demand. No public demo offers that.
- **Single process, synchronous.** One run is one browser and one lease.
- **Claude Opus 5 for discovery**, with prompt caching on the fixed prompt and tool list and screenshots dropped after two turns. Discovery happens once per capability and replay is free, so the most capable model is the cheap choice. The client is a seam (`src/discovery/llm.ts`) with the Anthropic API and OpenRouter behind it; the recorded runs went through OpenRouter. Lookup took 10 turns and about 96k input tokens (24k cached), the sub-account flow 16 turns and 183k (38k cached): roughly $1.20 for both, then nothing per replay.

## 2. Artifact schema

A capability (`src/schema/capability.ts`) is a contract first and a step list second. Top to bottom: identity and status (`draft` → `verified` → `approved`), `app`, typed `inputs` with patterns, typed `outputs`, then `steps`, `success`, `outcomes`, `recoveries`, `escalations`, `policy`, `provenance`.

- **Targets are not selectors.** A target is an ordered list of strategies, each kept only if it uniquely identified the control at record time, plus a fingerprint (tag, input type, role, and the accessible name for captioned controls). Order is by how much of the app must stay the same for the strategy to hold: role and name; the label anchored to the left; the field's `name` attribute, wired to the backend and rarely changed; exact caption text; for grid cells, column header plus a stable value in the same row (`Current Balance` in the row containing `S01`), never the cell's own value; last, a structural CSS path so a reviewer can still see where it was. The fingerprint is enforced on every strategy: without it, the CSS fallback for the "System Notice" dialog matched a different dialog in the same position during testing.
- **Values are `param`, `literal` or `secret`.** Inputs are never baked in; a literal equal to an input value is converted to a param reference. Secrets are names, filled from the environment at run time.
- **Every step can carry an `expect`**, derived by the compiler from what appeared after the action and was not there before (the first new heading or top-level cell in the frame that changed most, never text containing an input value). The success condition is the model's declared checkpoint text, verified visible at `done`.
- **One `Condition` vocabulary** (`visible`, `text`, `url`, `dialog`, `all_of`, `any_of`, `not`) serves checkpoints, success, outcome detectors, recovery and escalation triggers. One evaluator.
- **Interstitials compile to recoveries, not steps.** A click inside a dialog container the flow did not ask for becomes `{detect: dialog visible, action: click}`: replay clears it if it appears and does not depend on it appearing. A native dialog belongs to the click that raised it (`steps[].dialog`: type, message pattern with input values generalized, response).
- **Provenance points at evidence, never at the transcript.** The artifact has to stand on its own for a reviewer and a calling agent.

The goal spec (`src/discovery/goal.ts`) is the other half: the person who knows the app declares the contract, the secrets the runtime may use, and the outcomes and runtime conditions a single happy-path run cannot observe. The model may propose outcomes; they are merged only when they do not overlap a declared one.

## 3. Determinism & error handling

Replay never calls a model and never sleeps for a fixed time. After each action the surface waits for navigations and for the DOM to go quiet (mutation observer, bounded), then polls the step's checkpoint until it holds or its budget runs out. The wait ends early when any detector fires, so a business outcome or an interstitial is handled in a quarter second rather than after a timeout.

The result contract (`src/schema/result.ts`) has four terminal states, kept apart on purpose:

- **`outcome`**: an expected business result (`MEMBER_NOT_FOUND`, `DEPOSIT_BELOW_MINIMUM`). A code and a description, no outputs, and nothing in the log says "error".
- **Recoveries** are not terminal: a known interstitial is dismissed; a lost session or an application error page restarts from step one, which is safe because step one is the entry point and restart is refused once an irreversible step has run. Budgets are per recovery per step, so a loop at one spot is bounded while a legitimate second occurrence after a restart is not.
- **`failed`** with a class from a closed set (`invalid_input`, `policy_blocked`, `target_not_found`, `target_ambiguous`, `checkpoint_failed`, `unexpected_dialog`, `app_error`, `session_lost`, `timeout`, `recovery_exhausted`, `escalation_failed`), the step, what was expected, what was observed, and a screenshot plus the perceived tree at that moment. Invalid input fails before the UI is touched.
- **`aborted`**: a person declined to continue.

Detector order is deliberate: outcomes first, because a business answer trumps everything; then declared escalations; then any dialog container no recovery knows, which escalates rather than guessing; then recoveries. Native dialogs a step did not expect are cancelled and reported. On a retry after a recovery or a handoff, a step whose checkpoint already holds is not run again: the difference between re-clicking Search and re-posting a transaction. Drift is secondary here but visible: when a fallback strategy resolves a control, the result records the primary and the strategy used, so a capability can be re-recorded before it breaks.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is the `Surface` interface: `observe()` returns an `Observation`, `act()` takes an action against a ref, `resolve()` matches a `Target` against an observation. Nothing above that line knows about the DOM. A legacy web app is the same surface with a harder walker (framesets are handled; every node carries a frame path). A desktop app is a second implementation building the same `NodeInfo` list from the OS accessibility API (UIA, AXUIElement) and dispatching input through the OS: role and name, label anchor and field name exist there too; the CSS path becomes an accessibility path. A screenshot-and-coordinates surface for the truly opaque case would build nodes from OCR and layout and lean on anchor and text strategies with a visual fingerprint. The artifact and the engine do not change.

**Multi-tenant reuse.** A capability is recorded against a vendor product (`app.id`), not a tenant. What varies across tenants on the same product is branding, labels, a version's layout, and which interstitials appear. Strategy chains absorb label and layout variance already, and drift reporting shows which tenants are living on fallbacks. `app.variant` marks a specialisation: a base artifact plus a per-variant overlay of overrides keyed by step id (a label, an extra recovery, a changed checkpoint), applied at load time, with the base as the reviewed source of truth; a tenant that needs a new step is a new version, not an overlay. Replay stats and drift counts per tenant show a variant degrading before it fails; when a base changes, `verify` runs per variant and a failing variant keeps its last good version. I did not build the overlay loader; the artifact has the fields and the engine has one load point for it.

## 5. Escalation & handoff

**Detecting stuck.** In discovery the model has an `escalate` tool; the loop also stops on repeated policy blocks and the step budget. In replay three things escalate: a declared escalation condition (permission denied, supervisor required), a dialog container no recovery knows, and a native dialog the step did not expect. Target-not-found does not escalate; it fails with evidence, because a person cannot fix a locator from a console and pretending otherwise hides a defect.

**Control transfer.** The session has one controller at a time, `automation` or `human`, held by the `ControlPlane`. Automation raises an intervention and blocks on it. An intervention is a record with the reason, the step, the URL, the perceived tree and a screenshot, persisted under `evidence/<run>/interventions/`. Two kinds:

- **takeover**: the person takes control; automation cannot act (`assertAutomation()` throws). They work the same browser, in the headed window or through the console's remote-hands panel, which acts on the live session through the same surface. An injected listener records their actions redacted: what they clicked, that a field changed and the value's length, never the value. They hand back with a decision about the interrupted step: `retry_step`, `skip_step` (verified against the step's checkpoint) or `abort`.
- **approval**: nobody takes control; the person approves or denies an irreversible step.

The console (`src/session/console.ts`) is small on purpose: a list, a detail page with the live screenshot and the buttons, and a JSON API under `/api`. `scripts/operator.ts` is a scripted operator on that API; the tests and the recorded evidence use it for the compliance-dialog takeover and the supervisor override (`evidence/replay-*-escalation-*`, `evidence/replay-*-supervisor-*`). Mocked: the UI is minimal and single-operator, no queue, assignment or auth. Real: the lease, pause and resume on the same session, the capture, and the evidence across the seam.

## 6. Safety

Policy is a file (`policies/meridian-coresuite.json`) enforced at the surface boundary for discovery and replay alike: allowed origins, a path allowlist and denylist (the fault endpoint and sign-off are denied), allowed action kinds, and an irreversible class defined by button captions and dialog wording. Link destinations are checked before a click; `javascript:` URLs are refused.

Irreversible actions run in one of three modes: `block`, `confirm` (an approval intervention, the default) or `allow` with a flag in evidence. Confirm is the default because a bank will want a person on the first runs of any mutating capability; the approval state on the artifact is how that is relaxed later. Approving a click also covers the `confirm()` it raises; asking twice teaches operators to click through.

Redaction: secrets are referenced by name; the redactor scrubs their values, any input marked sensitive, and pattern matches (SSN, card numbers) from prompts, logs, artifacts and the console. Password fields are never read. Limits: redaction is pattern and value based, so an undeclared sensitive value on screen would reach the model and the logs; screenshots are not masked (production would mask regions from the tree's bounding boxes or keep screenshots out of long-term evidence); the allowlist is path based and does not inspect form contents; there is no rate limiting on replay.

## 7. Cuts

Left out on purpose: the variant overlay loader (fields exist); a desktop surface; visual fingerprints and screenshot masking; a multi-operator console with auth and assignment; learning outcomes from failed replays (today the analyst declares them in the goal spec, and a failure's evidence shows exactly which text to declare); assisted recovery with a bounded model call on replay failure.

Next, in order: the variant overlay with per-tenant drift stats, because that is where the economics of record-once live; screenshot masking from bounding boxes; a `learn` command that promotes a `checkpoint_failed` observation into an outcome or recovery after review; then the desktop surface.

Stretch goals included: the agent-facing catalog (`bin/hands catalog --tools`, `bin/hands agent`), where a model chooses a capability from typed tool definitions and the call is a deterministic replay; and the draft → verified → approved gate with replay stats and `bin/hands stability`.
