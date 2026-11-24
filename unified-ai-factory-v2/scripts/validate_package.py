#!/usr/bin/env python3
"""Validate implementation-package structure and policy declarations, not runtime security."""
from pathlib import Path
import json,re,sys
ROOT=Path(__file__).resolve().parents[1]
errors=[]
for name in ('README.md','AGENTS.md','MASTER_PLAN.md','ARCHITECTURE.md','SECURITY.md','TESTS.md','PROGRESS.md','docs/BLUEPRINT_V1_1.md'):
 if not (ROOT/name).is_file():errors.append('Missing '+name)
tasks=sorted((ROOT/'TASKS').glob('*.md'))
if len(tasks)!=25:errors.append(f'Expected 25 tasks, got {len(tasks)}')
names={p.stem for p in tasks};deps={}
for p in tasks:
 s=p.read_text();m=re.search(r'\*\*Dependencies:\*\* (.+)',s)
 if not m:errors.append(f'No dependencies in {p.name}');continue
 deps[p.stem]=[d.strip() for d in m.group(1).split(',') if d.strip()!='—']
 for d in deps[p.stem]:
  if d not in names:errors.append(f'{p.stem}: missing dependency {d}')
 for heading in ('## Scope and concrete deliverables','## Procedure','## Verification and acceptance','## Stop and escalation conditions','## Evidence template'):
  if heading not in s:errors.append(f'{p.stem}: missing {heading}')
def visit(t,path):
 if t in path:errors.append('Dependency cycle: '+' -> '.join(path+[t]));return
 for d in deps.get(t,[]):visit(d,path+[t])
for t in deps:visit(t,[])
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
print(f'PASS: {len(tasks)} tasks, dependency DAG, structural task gates, JSON contracts and safe policy configuration')
