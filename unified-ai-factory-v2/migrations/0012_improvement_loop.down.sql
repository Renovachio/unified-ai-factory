DROP TABLE IF EXISTS product_artifacts, experiment_ledger, improvement_proposals, improvement_signals, capability_qualifications, eval_comparisons, benchmarks CASCADE;
DROP FUNCTION IF EXISTS product_artifacts_guard();
DROP FUNCTION IF EXISTS improvement_proposals_guard();
DROP FUNCTION IF EXISTS qualification_guard();
-- factory_evaluator is cluster-wide and intentionally not dropped.
