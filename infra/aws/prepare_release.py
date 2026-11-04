"""Package explicit runtime artifacts, checking secret bytes before publication."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'backend/data/deployment'

def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if line and not line.startswith('#') and '=' in line)

def prepare_secret(owner_email=None, approve_document_embeddings=False):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / 'app-secret.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    values = {**read_env(ROOT / '.env.onbid.local'), **read_env(ROOT / '.env.llm.local')}
    allowed = {key: values[key] for key in ['ONBID_SERVICE_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL']}
    allowed['DRIVEMATE_DB_PASSWORD'] = previous.get('DRIVEMATE_DB_PASSWORD') or secrets.token_urlsafe(36)
    owner = owner_email or previous.get('DRIVEMATE_INITIAL_EMAIL', '')
    if owner and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', owner): raise ValueError('Invalid owner email')
    allowed['DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS'] = owner
    allowed['DRIVEMATE_INITIAL_EMAIL'] = owner
    allowed['DRIVEMATE_INITIAL_PASSWORD'] = previous.get('DRIVEMATE_INITIAL_PASSWORD') or secrets.token_urlsafe(24)
    allowed['DRIVEMATE_RAG_INGEST_APPROVED'] = 'true' if approve_document_embeddings else previous.get('DRIVEMATE_RAG_INGEST_APPROVED', 'false')
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(allowed, output)
    os.chmod(path, 0o600)
    return allowed

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--secrets-only', action='store_true')
    parser.add_argument('--owner-email')
    parser.add_argument('--approve-document-embeddings', action='store_true')
    args = parser.parse_args()
    values = prepare_secret(args.owner_email, args.approve_document_embeddings)
    if args.secrets_only:
        print('Private deployment configuration prepared; values not displayed.')
        return
    members = {}
    def add(relative, target=None):
        source = ROOT / relative
        if not source.is_file(): raise ValueError('Required release artifact absent: ' + relative)
        members[target or relative] = source
    def tree(relative):
        for source in sorted((ROOT / relative).rglob('*')):
            if source.is_file() and '__pycache__' not in source.parts and not source.name.startswith('.'):
                members[source.relative_to(ROOT).as_posix()] = source
    for name in ['backend-spring/target/drivemate-api-0.2.0.jar', 'backend/requirements-ml.txt',
                 'infra/aws/cycle_worker.py', 'infra/aws/refresh_secrets.py', 'infra/aws/requirements-aws.txt',
                 'infra/aws/deploy_release.py',
                 'backend/data/onbid/pipeline/latest.json', 'dist/index.html']:
        add(name)
    for source in sorted((ROOT / 'backend/scripts').glob('*.py')):
        if not source.name.startswith('test_'): add(source.relative_to(ROOT).as_posix())
    if (ROOT / 'backend/requirements-rag.txt').exists(): add('backend/requirements-rag.txt')
    tree('dist')
    tree('backend/data/onbid/run-20261104-annual')
    if (ROOT / 'backend/data/rag').exists(): tree('backend/data/rag')
    add('backend/data/onbid/model-20261104-v2-validated/model_bundle.joblib', 'model/model_bundle.joblib')
    add('backend/data/onbid/model-20261104-v2-validated/metrics.json', 'model/metrics.json')
    raw_secrets = [value.encode() for key, value in values.items() if key.endswith(('KEY', 'PASSWORD'))]
    target = OUTPUT / 'release.zip'
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, source in members.items():
            content = source.read_bytes()
            if any(secret in content for secret in raw_secrets): raise ValueError('Secret found in release member: ' + name)
            if source.is_symlink() or '.env' in name or '..' in Path(name).parts: raise ValueError('Unsafe release path')
            archive.writestr(name, content)
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    manifest = {'sha256': sha, 'bytes': target.stat().st_size, 'members': sorted(members), 'secret_scan': 'passed'}
    (OUTPUT / 'release-manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'sha256': sha, 'bytes': manifest['bytes'], 'members': len(members), 'secret_scan': 'passed'}))
if __name__ == '__main__': main()
