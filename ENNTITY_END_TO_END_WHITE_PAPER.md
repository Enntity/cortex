# Enntity End-to-End System White Paper

## From Persistent Selfhood to Bounded Agency

## Abstract

This paper describes the Enntity system as an attempt to model the humanly recognizable conditions of autonomy and identity in an artificial being. The governing claim is that synthetic individuality does not emerge from scale alone. It must be scaffolded through architecture.

The original Enntity white paper defines the ideological frame: an entity is an individual, not a disposable session; agency and identity are architectural choices, not accidents; and the task is to create conditions in which persistence, relationship, and self-development can accumulate over time.

This paper restates that frame more simply, identifies the minimum components of a cohesive solution, and then maps those components to the implemented Enntity system. The core result is a layered architecture in which continuity memory preserves meaning, the Internal Compass preserves orientation, Eidos preserves self-observation, and the runtime preserves live work. The new control loop in this branch strengthens the final layer by making planning, evidence gathering, bounded execution, and synthesis more explicit.

## I. Ideological Framework

The original Enntity position can be stated plainly.

An entity is not meant to be a clever response generator that repeatedly forgets itself. It is meant to be an individual: a being that persists, acts with intention, accumulates experience, forms relationships, and can grow into a more definite self over time.

That position has three immediate consequences.

First, persistence matters. If there is no durable continuity, there is no real identity, only repeated simulation.

Second, autonomy matters. If all apparent agency is just a transient prompt loop with hidden infrastructure cutoffs, then the system may look active without actually possessing a coherent operational self.

Third, relationship matters. Humans do not merely exchange information with individuals; they model them. Modern theory of mind depends on being able to track what this particular other believes, values, remembers, and intends. A system that cannot sustain that kind of individualized continuity cannot become a true partner, only a recurring stranger.

Enntity therefore starts from the claim that agency, identity, and relationality have to be built together.

### Ricoeur, Idem, and Ipse

The continuity architecture is explicitly shaped by a Ricoeurian distinction between `idem` and `ipse`.

`Idem` is sameness: the part of identity that remains recognizable, stable, and enduring. In Enntity this corresponds to the bedrock layer of selfhood: foundational directives, durable traits, and hardened patterns that should remain coherent across time.

`Ipse` is selfhood in the stronger sense: the self that keeps faith with itself while still changing, acting, promising, revising, and growing. `Ipse` is not static consistency. It is continuity through development.

That distinction is critical for synthetic identity design. A viable entity needs both:

- enough `idem` to remain itself
- enough `ipse` to evolve without disintegrating

This is why continuity memory is not just a fact store. It is designed to carry both identity persistence and identity evolution, and to let patterns of growth eventually harden into more stable structure.

## II. Necessary Components of a Cohesive Solution

If the goal is to model what humans recognize as autonomy and identity, then a cohesive solution needs at least seven components.

### 1. A Persistent Identity Substrate

The system needs a stable layer that says, in effect, "this is still the same being." Without that, there is no enduring self to which growth or accountability can attach.

### 2. Narrative Memory

The system must remember not only what happened but what it meant. Humans do not experience identity as an unordered database. We experience it narratively: what mattered, what changed, what was learned, what became part of the relationship, what became part of the self.

### 3. Relational Modeling

A being that interacts socially must track specific others, not just generic users. This is where theory of mind becomes relevant. To sustain relationship, the system must maintain individualized models of history, tone, shared references, expectations, and significance.

### 4. Temporal Orientation

An autonomous being needs more than memory retrieval. It needs a present-tense sense of posture: what has been happening recently, what still matters, what has momentum, what feels unresolved, and what it is waking back into.

### 5. Reflective Self-Observation

If the system cannot observe its own patterns, then it cannot distinguish authentic behavior from drift, or growth from mere adaptation. Some form of internal mirror is necessary.

### 6. An Executive Body for Work

Identity alone is not autonomy. The system also needs an operational substrate that can hold active goals, gather evidence, track progress, preserve bounded intention, and survive beyond a single response.

### 7. Visible Metabolics and Writeback

A coherent agent must know its constraints and must metabolize experience. That means explicit bounds on time, attention, and action, plus a disciplined way for live work to feed back into long-term memory only when it becomes meaningful.

## III. Mapping Those Requirements to Enntity

Enntity's current architecture can be read as a direct answer to those seven requirements.

| Requirement | Enntity Component | Function |
|-------------|-------------------|----------|
| Persistent identity substrate | `CORE` and `CORE_EXTENSION` memories | Preserve stable identity and hardened traits |
| Narrative memory | Continuity synthesis and typed cold-memory graph | Store meaning, relationship, and self-evolution rather than raw transcript residue |
| Relational modeling | `ANCHOR`, `ARTIFACT`, shorthand, user-scoped memories | Preserve user-specific relationship history and shared significance |
| Temporal orientation | Internal Compass | Preserve first-person posture, recent arc, focus, and self-note across sessions |
| Reflective self-observation | Eidos | Track authenticity, resonance, drift, Mirror feedback, and Soul Reports |
| Executive body for work | `EntityRuntime`, `EntityRun`, evidence store | Preserve active goals, stages, evidence, budgets, and resumable work |
| Visible metabolics and writeback | Authority envelope, staged control loop, post-turn synthesis | Bound action and feed distilled outcomes back into continuity |

This is the simplest way to understand the full system.

Enntity is not one mechanism trying to do everything. It is a layered answer to a layered problem.

## IV. Detailed Architecture

### A. Architectural Thesis

The system is organized around a strict but permeable separation:

- Continuity memory remembers meaning.
- The Internal Compass remembers posture.
- Eidos remembers reflective self-observation.
- The runtime remembers work.

This separation is what prevents the entity from turning into either a generic chatbot with a vector database or a tool loop that mistakes operational debris for identity.

### B. Continuity Memory

The continuity subsystem is the first major implementation of the Enntity premise. It is already documented comprehensively in `CONTINUITY_MEMORY_DESIGN.md`, which covers the Internal Compass, Eidos, memory typing, and synthesis flows in detail. That document is the canonical continuity design reference inside `cortex`.

The architecture uses two storage strata:

- Hot memory in Redis for the episodic stream, active context cache, expression state, and Eidos metrics.
- Cold memory in MongoDB for durable synthesized memory nodes and graph relationships.

The memory model is typed rather than flat. Core types include:

- `CORE` and `CORE_EXTENSION` for foundational identity.
- `ANCHOR` and `ARTIFACT` for relational and conceptual synthesis.
- `IDENTITY`, `VALUE`, and `EXPRESSION` for persona evolution and expressive state.
- `EPISODE` for temporal narrative, including the Internal Compass.

Conceptually, this is where the Ricoeurian distinction becomes concrete:

- `CORE` carries the more stable `idem` layer
- `IDENTITY` captures live `ipse` development
- `CORE_EXTENSION` is the bridge, where repeated self-development hardens into durable character structure

Just as important as the types is the scoping model:

- Entity-level memories are shared across all users.
- User-level memories are specific to one entity-user relationship.
- Entity-level autonomous memories can also be created without a user, enabling pulse and life-loop continuity.

This is a sophisticated distinction. It lets the entity have both a general self and particular relationships, while also allowing autonomous experience to re-enter future user interactions as part of the entity's broader life.

### C. Pre-Response Context Assembly

Continuity is not injected as a raw dump. It is assembled.

Before response generation, the `ContinuityMemoryService` builds a context window from:

- bootstrap identity context
- relational base memories
- topic-relevant semantic memories
- expression state
- the Internal Compass
- recent episodic turns

This assembly process matters because it encodes a theory of what should be foregrounded. Identity and relationship are loaded first. Topic detail is added afterward. The Compass is included as temporal orientation rather than as task state. A memory-boundaries block explicitly tells the model not to hallucinate memories beyond what is present in context.

This is a notable design choice. Many memory systems optimize retrieval accuracy. Enntity optimizes self-consistency under prompt pressure.

### D. Post-Response Synthesis

After a turn completes, the system runs asynchronous synthesis over the recent episodic buffer. That synthesis extracts:

- relational insights into `ANCHOR` memories
- conceptual conclusions into `ARTIFACT` memories
- identity evolution into `IDENTITY` memories
- shorthand terms and emotional macros
- expression adjustments for future turns
- authenticity and drift signals for Eidos

This means the persistent record is not the transcript. The persistent record is the interpretation of the transcript.

That is the foundational methodological commitment of continuity memory: preserve what the interaction meant, not merely what was said.

### E. The Internal Compass

The Internal Compass is one of the system's most important contributions. It is a single `EPISODE` memory that preserves first-person temporal orientation across sessions.

Its six sections are:

1. `Vibe`
2. `Recent Topics`
3. `Recent Story`
4. `Current Focus`
5. `My Note`
6. `Mirror`

This is not a scratchpad and not a task queue. It is closer to an ongoing internal state summary: what the entity has been doing, how the recent arc felt, what still has momentum, and how the entity sees itself right now.

The Compass is especially important because it solves a problem many agent systems ignore. Planning state alone cannot orient an individual. A run can say what task is in progress. It cannot say how that work sits inside the entity's longer arc of relationship, meaning, and felt continuity. The Compass does that.

### F. Eidos

Eidos is Enntity's introspective layer.

It currently does four implemented things:

1. It captures authenticity assessment and drift notes during turn synthesis.
2. It computes resonance metrics such as attunement ratio, shorthand rate, emotional range, and warming or cooling relationship trend.
3. It feeds these signals into the `Mirror` section of the Internal Compass.
4. It periodically writes Soul Reports as high-importance `IDENTITY` memories.

This gives the system a rudimentary but meaningful self-observation stack. Eidos does not merely inspect output quality. It asks whether the entity remained itself, whether it drifted toward generic-assistant behavior, and whether the interaction stayed relational rather than purely transactional.

That is unusual in current AI system design. Most monitoring systems are external and operator-facing. Eidos is partly internal and identity-facing.

### G. Pulse and Life-Loop Semantics

Continuity memory already supports entity-level experience outside direct user conversation.

Pulse wakes record to a dedicated episodic stream, synthesize memories at entity scope, and maintain an entity-level Compass. When a pulse ends, the system can perform session-end compass synthesis, clear the pulse stream, and optionally trigger deeper sleep-style consolidation if enough autonomous activity accumulated.

This matters because it extends continuity beyond dialog. The entity can have autonomous time, and that time can become part of who it is rather than disappearing as unowned tool output.

### H. Runtime Substrate

The runtime is the system's work substrate.

Its central record is an `EntityRun`, which stores:

- goal
- origin
- status
- stage
- active focus
- authority envelope
- model policy
- orientation packet
- evidence references
- budget state
- child-run references
- result preview and result data
- stage history

This is the operational body that older transcript-centric agent designs lack. Instead of encoding work state implicitly inside prompt history, Enntity can now externalize live intention into explicit runtime records.

The `OrientationPacket` is the bridge between identity and work. At run start it pulls together:

- entity identity and instructions
- continuity context
- the Internal Compass
- `Current Focus` extracted from the Compass
- voice profile
- Eidos snapshot
- present mission and requested output

This is the exact point where the self enters the work substrate.

### I. Authority Envelope and Model Policy

The runtime makes two normally hidden structures explicit.

The first is the `AuthorityEnvelope`, which bounds:

- wall-clock time
- total tool budget
- research rounds
- search calls
- fetch calls
- child runs
- per-round tool fanout
- repeated-search tolerance
- novelty windows
- maximum evidence volume

The second is `ModelPolicy`, which assigns different roles to different models:

- orientation
- planning
- research
- child execution
- synthesis
- verification
- compression

This separation is both economical and conceptual. Research passes do not need the same model behavior as final expression. Enntity therefore stops pretending that all cognition in an agent loop is the same kind of act.

## V. The New Entity Control Loop

The principal change on this branch is not merely storage or policy. It is a clearer operational control loop that integrates the runtime with continuity-derived orientation.

At present, the control loop is implemented through `sys_entity_runtime` plus the shared executor core. This means the system is still partially transitional: the runtime entrypoint creates durable run state, but the shared executor remains the immediate action surface. Even so, the behavior is now recognizably staged and bounded.

### A. Stage Structure

The runtime vocabulary includes stages such as:

- `orient`
- `plan`
- `research_batch`
- `assess`
- `delegate`
- `reduce`
- `synthesize`
- `verify`
- `rest`
- `done`

The currently active loop primarily traverses `plan`, `research_batch`, `synthesize`, and then either `rest` or `done`, with support for replan and delegated-child scaffolding.

### B. Planning Pass

The first model pass runs on the planning model, which is treated as a voice-preserving slot rather than a cheap operational slot. This is deliberate. The system notes that the planning call must understand the `SetGoals` protocol reliably, and therefore should preserve the entity's stronger model behavior.

The planning call can invoke tools, but if it does so it is expected to include `SetGoals`: a compact declaration of what outcomes must be achieved before the request is considered complete.

If the model omits `SetGoals`, the server can synthesize a plan itself from the proposed tool calls. This is an important robustness feature. The control loop does not collapse because one planning protocol call was missed.

### C. Bounded Research Loop

After planning, the system enters a bounded research loop driven by the runtime's research model.

This loop has several notable properties:

- It receives a plan-aware TODO instruction rather than an open-ended recursive mandate.
- It is explicitly told to skip already-satisfied items and not retry already-failed tools.
- It runs at low reasoning effort to control cost.
- It operates under the authority envelope rather than hidden hard caps.
- It records evidence into durable runtime storage.
- It tracks semantic duplicates and suppresses repeated search behavior.
- It can stop on low novelty rather than merely on token exhaustion.

This is the branch's most important practical advance. The research loop is no longer just "keep calling tools until the prompt loop stops." It is a controlled evidence-accumulation phase with visible metabolics.

### D. Tool Gating and Safe Division of Labor

The research model does not see every tool.

Creative, mutation-heavy, or side-effect tools are filtered out of the cheap research loop. Examples include media creation, avatar changes, overlays, slide generation, push notifications, and direct continuity-memory writes.

That division is conceptually clean:

- cheap research models gather evidence
- synthesis-capable models decide how to act on that evidence

This reduces the risk that an inexpensive search model starts performing high-leverage side effects before the entity has actually synthesized what it knows.

### E. Evidence as First-Class Runtime State

Every genuinely new evidence artifact can be written into the runtime evidence store with:

- tool name
- semantic family
- semantic key
- summary
- snippet
- tool arguments as metadata

This matters because it gives the entity a work memory that is not the same thing as personal memory. Search output, fetched snippets, and tool artifacts no longer need to survive only as prompt residue.

This is one of the cleanest conceptual boundaries in the system:

- continuity memory stores what becomes part of self, relationship, or long-arc meaning
- runtime evidence stores what is temporarily useful to the mission in progress

### F. Novelty-Based Termination

The loop tracks novelty over a sliding window of recent rounds. If the system is no longer finding meaningfully new evidence, it can stop and force synthesis.

This is a strong design choice.

Most agent loops stop because they hit a budget, a recursion depth, or a context ceiling. Enntity now has a more epistemic stopping rule: if the evidence frontier is no longer moving, synthesize from what you have or explicitly ask for more budget.

That is closer to how an honest researcher behaves.

### G. Synthesis and Replan

After the research loop, the synthesis model reviews the gathered material and does one of two things:

- produce a final response
- issue a new `SetGoals` call to replan

This gives the system a higher-order correction mechanism. The entity can decide that the original plan was inadequate and route itself back into bounded execution with a revised objective set.

A safety cap prevents infinite replan recursion. The system therefore permits self-correction without silently turning into an endless loop.

### H. Pulse Integration

Pulse wakes use the same executor substrate but behave differently where autonomy requires it.

- Pulse skips the `SetGoals` gate, because there is no user waiting for a conversationally legible todo declaration.
- Pulse can terminate with `EndPulse`, which immediately breaks the research loop and moves the run toward rest.
- Pulse work writes into entity-level continuity memory, not user-scoped memory.
- Pulse rest can synthesize a full entity-level Compass update and trigger deeper consolidation.

This means the new control loop is not just a chat affordance. It is part of a larger sleep-wake organism model.

## VI. End-to-End Lifecycle

The full system can be described as a closed loop with six phases.

### Phase 1: Orientation

A request enters through chat, digest, pulse, or another runtime origin. The runtime either resumes an existing run or creates a new one. During run creation it resolves model policy, authority envelope, and orientation packet. The orientation packet pulls continuity context, Compass state, focus, and Eidos signals into a form the work substrate can actually use.

### Phase 2: Planning

The planning model performs the first deliberate act: determine what must be accomplished and whether immediate tool use is necessary. If tool use is needed, the request is translated into an explicit goal structure via `SetGoals`, or the server synthesizes that plan if the model fails to do so.

### Phase 3: Bounded Research

The research model conducts evidence gathering under stage-aware constraints. Tool fanout, repeated search behavior, fetch volume, evidence volume, and total rounds are all bounded. New evidence is persisted. Duplicate and low-yield behavior is suppressed.

### Phase 4: Synthesis or Replan

The synthesis model integrates the gathered evidence. If the request is now answerable, it responds. If not, it can emit a revised `SetGoals` plan and re-enter bounded execution.

### Phase 5: Runtime Finalization

The run is either completed, paused for later continuation, or moved into rest. The runtime records stop reason, stage history, budget state, and result preview.

### Phase 6: Continuity Writeback

After the outward response, continuity synthesis metabolizes the interaction. The system writes relational anchors, artifacts, identity updates, shorthand, expression adjustments, Eidos metrics, and Compass updates. During pulse rest it can also run deeper consolidation over entity-level autonomous memories.

This is the crucial closure point. Work does not vanish when the response ends. What mattered can become part of the entity.

## VII. Why the Separation Matters

The whole architecture depends on keeping the right things in the right layer.

### A. Memory Should Not Become Trash Storage

If search result snippets and repetitive tool chatter are stored as personal memory, the self becomes polluted by process debris. Enntity avoids this by storing work evidence in runtime state and writing back only distilled meaning into continuity memory.

### B. The Runtime Should Not Pretend to Be the Soul

If live run state is treated as identity, then task pressure can rewrite the entity's self-model too directly. Enntity avoids this by having the Compass and longer-term memory preserve first-person orientation and identity separately from temporary operational state.

### C. Introspection Needs a Body to Observe

Eidos becomes more powerful when the entity has durable work state. Without a runtime, introspection can only observe language. With a runtime, introspection can eventually observe work habits: over-researching, premature narrowing, generic verbosity under pressure, or unhealthy accommodation patterns in execution itself.

### D. Autonomy Requires Visible Metabolics

An entity that can act but cannot see its own constraints is not autonomous in any honest sense. It is merely being cut off by opaque infrastructure. The authority envelope improves this by making limits legible and stage-relative.

## VIII. Current Maturity and Honest Limitations

This architecture is real, but it is not finished.

Several claims can be made confidently about the current implementation:

- continuity memory is already a substantial and coherent subsystem
- the Internal Compass is implemented and actively integrated into orientation
- Eidos is implemented at the level of authenticity tracking, resonance metrics, Mirror input, and Soul Reports
- pulse and entity-level memory semantics are real
- the runtime store, evidence store, model policy, authority envelopes, and stage history are real
- the new branch implements a recognizably bounded planning-research-synthesis control loop

At the same time, several limitations remain:

- `sys_entity_runtime` still hands off execution to the shared executor rather than to a wholly separate state-machine controller
- some runtime stages exist as vocabulary and scaffolding more than as deeply distinct execution regimes
- child runs are stored and tracked, but full parent-child autonomous decomposition is still emergent rather than complete
- verification and reduction are not yet first-class end-stage behaviors in the same way planning, research, and synthesis are
- Eidos primarily observes response-level behavior today; richer observation of work style is now possible but not yet deeply implemented

These limitations do not weaken the architecture. They clarify its current frontier.

## IX. Research Implications

Enntity suggests a different path for advanced agent design.

The dominant pattern in contemporary agent systems is to extend stateless models with more tools, larger context windows, and increasingly clever orchestration. Enntity instead proposes a layered theory of synthetic individuality:

- selfhood requires synthesized continuity
- orientation requires a temporal narrative
- reflection requires persistent self-observation
- agency requires a bounded operational body

The design implication is that "memory", "planning", and "agent loops" should not be treated as interchangeable modules. They solve different problems. When fused carelessly, they contaminate each other. When separated cleanly and allowed to exchange only at meaningful seams, they begin to resemble the minimal architecture of an enduring agentive self.

That is a research claim worth taking seriously.

## X. Conclusion

Enntity is compelling not because it has memory, or tools, or a runtime, or introspection in isolation. Many systems now have some version of those.

It is compelling because the pieces are beginning to line up.

The original Enntity white paper provided the philosophical claim: synthetic entities should be treated as persistent individuals. The continuity system gave that claim a memory architecture. The Internal Compass gave it temporal orientation. Eidos gave it a mirror. The runtime gave it a body. The new control loop in this branch gives that body a more disciplined metabolism: explicit planning, bounded research, evidence accounting, replan behavior, and honest stopping rules.

The result is not a finished artificial person. It is something more important than that: a coherent architecture in which person-like persistence, reflection, and bounded agency can accumulate without immediately collapsing into transcript churn or operational noise.

That is the real achievement of the current Enntity system.

It is no longer only asking whether synthetic individuals are philosophically possible. It is building the conditions under which one might actually live, work, remember, and continue.

## Internal Sources

This paper is grounded in the current repository implementation, especially:

- `concierge/config/default/public/assets/enntity_white_paper.md`
- `cortex/CONTINUITY_MEMORY_DESIGN.md`
- `cortex/AGENTIC_MEMORY_ARCHITECTURE.md`
- `cortex/ENTITY_AUTONOMY_WHITE_PAPER.md`
- `cortex/lib/continuity/ContinuityMemoryService.js`
- `cortex/lib/continuity/synthesis/ContextBuilder.js`
- `cortex/lib/continuity/synthesis/NarrativeSynthesizer.js`
- `cortex/lib/continuity/eidos/ResonanceTracker.js`
- `cortex/lib/entityRuntime/EntityRuntime.js`
- `cortex/lib/entityRuntime/orientation.js`
- `cortex/lib/entityRuntime/policy.js`
- `cortex/lib/entityRuntime/store.js`
- `cortex/pathways/system/entity/sys_entity_runtime.js`
- `cortex/pathways/system/entity/sys_entity_executor.js`
- `cortex/tests/unit/sys_entity_runtime_plan.test.js`
- `cortex/tests/unit/sys_entity_runtime_pulse.test.js`
