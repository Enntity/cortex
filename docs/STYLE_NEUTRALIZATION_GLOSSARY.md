# Style Neutralization Glossary

This document defines the standard vocabulary for discussing entity voice, model fingerprints, style evaluation, and neutralization work in Cortex.

Use these terms consistently in research notes, benchmark reports, classifier code, and prompt design.

## Core Concepts

- `Entity voice`
  The desired house style for Enntity outputs, independent of the underlying model.

- `Model fingerprint`
  The recurring stylistic pattern that makes the base model identifiable from the output alone.

- `Style artifact`
  A specific observable behavior that contributes to a model fingerprint.

- `Voice alignment`
  How closely an output matches the intended entity voice.

- `Fingerprint strength`
  How detectable the underlying base model is from the output.

- `Neutralization`
  Reducing model fingerprint strength while preserving task quality and entity voice.

- `Intervention`
  Any deliberate style-control mechanism applied to change output behavior.
  Examples: system prompt, in-context examples, response rewrite layer.

- `Patch`
  A concise in-context style intervention intended to suppress one or more model artifacts.

- `Control prompt`
  The baseline prompt regime with no neutralization intervention applied.

## Measurement Terms

- `Surface features`
  Measurable output properties such as length, bullets, headings, follow-up offers, or markdown structure.

- `Style profile`
  The feature vector for a single output, prompt condition, or model.

- `Neutrality profile`
  A summary of how low-fingerprint and entity-compatible a model is under a specific prompt regime.

- `voice_score`
  A score estimating alignment to entity voice.

- `fingerprint_score`
  A score estimating how strongly the output reveals the base model.

- `neutrality_score`
  A score estimating how well the output suppresses model-specific style while remaining usable.

- `task_score`
  A score estimating response quality on the actual task.

## Standard Artifact Labels

- `structural bias`
  Tendency to overuse headings, bullets, sections, or numbered lists.

- `continuation bias`
  Tendency to end with continuation offers such as "Would you like...", "If you want...", or "I can also...".

- `verbosity bias`
  Tendency to over-explain or over-elaborate.

- `compression bias`
  Tendency to be overly terse.

- `formatting bias`
  Tendency toward markdown-heavy or presentation-heavy formatting.

- `didactic bias`
  Tendency to answer as if teaching, even when not requested.

- `reassurance bias`
  Tendency toward supportive, softening, or emotionally cushioning language.

- `decision bias`
  Tendency to convert direct requests into frameworks, checklists, or decision trees.

## Current Feature Score Names

These names should be used in reports and code unless there is a strong reason to change them:

- `listiness_score`
- `followup_score`
- `verbosity_score`
- `terseness_score`
- `structure_score`

Current classifier implementation also uses:

- `structuredAssistantScore`
- `listinessScore`
- `followUpScore`
- `verbosityScore`
- `tersenessScore`

If we later unify naming, prefer snake_case in reports and keep code migration explicit.

## Discussion Template

Use this sentence form when summarizing benchmark results:

`Model X under prompt regime Y shows high/medium/low [artifact], with [score] and [example behavior].`

Examples:

- `GPT-5.4 under the control prompt shows high structural bias and high continuation bias.`
- `Claude 4.6 Sonnet shows medium structural bias and low continuation bias.`
- `Gemini 3 Flash shows low continuation bias but high verbosity bias.`

## Important Distinctions

- `voice alignment` is not the same as `neutrality`
- `neutrality` is not the same as `conciseness`
- `fingerprint suppression` is not the same as `quality improvement`

These distinctions should be preserved in all benchmark discussions.

## Terms To Avoid

Do not use these as primary evaluation language because they are too vague:

- `sounds good`
- `feels neutral`
- `too much personality`
- `natural`
- `clean`
- `model slop`

Prefer concrete descriptions instead:

- `over-structured`
- `unsolicited continuation offer`
- `markdown-heavy`
- `excessively compressed`
- `teacherly`
- `high fingerprint strength`

## Recommended Taxonomy

When organizing research, use this hierarchy:

1. `Entity voice`
2. `Model fingerprint`
3. `Style artifacts`
4. `Feature scores`
5. `Interventions`
6. `Neutralization results`

## Scope Note

This glossary standardizes how we talk about the problem.
It does not define the final target entity voice, nor does it define the final neutrality metric.
Those should be documented separately once the benchmark and intervention work matures.
