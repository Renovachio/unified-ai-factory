# Retrieval, Memory Quality and Cost Evaluation

## Scientific evaluation design
Establish a frozen replayable corpus of real **permission-cleared** tasks (PM decisions, document drafting, coding fix, regression diagnosis, contradictory meeting notes, stale facts, deletion, multi-project boundaries). Split development and hidden holdout sets; include adversarial examples. Pin retrieval config/model version, prompts, source snapshots, tokenizer and hardware profile.

## Comparison arms
A = existing v2.4 context assembly/full-history baseline; B = memory-based retrieved pack; C = minimal no-history baseline for determining incremental benefit. Randomize order, control tool usage, model and worker state, evaluate blind where possible. Report per-task and aggregate outcome. Do not report percentage gains before measurement.

## Metrics
- Quality: accepted task outcomes, test pass rate, groundedness, citation precision, contradiction detection, stale-decision error, authorization violations, answer completeness, reviewer time.
- Efficiency: total input tokens **including embeddings/extraction/summarization**, output tokens, cache traffic, wall-clock latency, CPU/RAM, disk/index growth, subscription quota pressure, and any directly measured spend.
- Retrieval: recall@k for labeled gold relevant sources, precision@k, MRR/nDCG where suitable, unsupported claim rate, over-budget fail rate.
- Operations: index freshness delay, deletion propagation, crash recovery, cache invalidation, tenant isolation.

## Release thresholds (proposed, revise only with evidence)
- Zero critical security/privacy leakage and zero unauthorized approval-status promotion.
- No critical stale-decision or provenance substitution in the predefined hard-case suite.
- Non-inferior end-to-end quality vs A (pre-register margin and confidence interval before trials), and fewer median input tokens for eligible tasks.
- Target >=30% median eligible input-token reduction, with lower 95% confidence bound above 0. This is aspirational, not a guaranteed benefit.
- Target >=98% citation precision where citation is measurable.
- If costs increase or quality drops materially, block activation; do not compensate by selectively removing hard test cases.

## Feedback quality
Use task outcome checks and human reviewer corrections; never treat unverified thumbs-up as sufficient evidence of factual correctness. Train no model weights. SAI-11 may propose retrieval configuration changes but cannot self-promote them.

## Evidence record
For each experiment: git revision, data snapshot digests, authorization scope, evaluator identity, benchmark version, prompt/config hashes, runtime qualification, input/output token counts or explicit unknown, quality measurements, CI/test commands, security results, and decision/approver.
