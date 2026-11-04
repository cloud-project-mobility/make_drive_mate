"""Run selected official AWS Guard controls and save complete evidence locally."""
import json
import sys
from pathlib import Path
import guardpycfn

ROOT = Path(__file__).resolve().parents[2]
RULES = ROOT / '.tools/aws-guard-rules/rules/aws'
NAMES = ['s3_bucket_server_side_encryption_enabled', 's3_bucket_level_public_access_prohibited',
         's3_bucket_versioning_enabled', 's3_bucket_ssl_requests_only',
         'rds_instance_public_access_check', 'rds_storage_encrypted', 'rds_multi_az_support',
         'ec2_imdsv2_check']
def main():
    paths = [p for p in RULES.rglob('*.guard') if p.stem in NAMES]
    rules = '\n'.join(p.read_text() for p in sorted(paths))
    failed = False
    for name in ['foundation', 'application']:
        result = guardpycfn.validate_with_guard((ROOT / 'infra/aws' / (name + '.json')).read_text(), rules, True)
        out = ROOT / 'backend/data/deployment' / (name + '-guard.json')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2))
        checks = [child['container']['RuleCheck'] for child in result.get('result', {}).get('children', []) if 'RuleCheck' in child.get('container', {})]
        print(name, json.dumps(checks))
        failed |= not result.get('success') or any(c['status'] == 'FAIL' for c in checks)
    print('selected official rules', [p.stem for p in paths])
    return int(failed)
if __name__ == '__main__': sys.exit(main())
