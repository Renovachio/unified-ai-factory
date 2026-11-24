#!/usr/bin/env python3
"""Validate implementation-package structure and policy declarations, not runtime security."""
from pathlib import Path
import json,re,sys
ROOT=Path(__file__).resolve().parents[1]
errors=[]
for name in ('README.md','AGENTS.md','ARCHITECTURE.md','SECURITY.md','docs/BLUEPRINT_V1_1.md'):
 if not (ROOT/name).is_file():errors.append('Missing '+name)
for p in (ROOT/'CONTRACTS').glob('*.json'):
 try:json.loads(p.read_text())
 except Exception as e:errors.append(f'Invalid JSON in {p.name}: {e}')
try:
 policy=json.loads((ROOT/'config/inference-policy.json').read_text())
 if policy.get('allowedInferenceModes')!=['subscription_cli','local_model']:errors.append('Allowed inference modes unexpectedly changed')
 for k,v in [('modelApiBillingEnabled',False),('autoMergeHighRisk',False),('pilotHumanApproval',True)]:
  if policy.get(k) is not v:errors.append('Unsafe policy: '+k)
except Exception as e:errors.append(f'Invalid policy: {e}')
if errors:
 print('FAIL ('+str(len(errors))+')');print('\n'.join(errors));sys.exit(1)
print('PASS: required documents, JSON contracts and safe policy configuration')
