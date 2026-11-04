"""Package canonical code plus explicitly selected private runtime artifacts.

Normal packaging only reads private key files for the secret scan. It never
creates or updates credentials. Use --secrets-only explicitly for that separate
operation. Example (paths with private data must stay outside public Git):

    python infra/aws/prepare_release.py --private-root /private/FE-test \
        --model-dir backend/data/onbid/model-20261104-v2-validated \
        --raw-run-dir backend/data/onbid/run-20261104-annual \
        --output-dir /private/releases/reviewed-version

Relative input paths resolve under --private-root; JAR, dist and scripts always
come from this checkout. A chosen output directory must not already exist.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = 'backend/data/onbid/model-20261104-v2-validated'
DEFAULT_RUN = 'backend/data/onbid/run-20261104-annual'
DEFAULT_REPORT = 'backend/data/onbid/pipeline/latest.json'
DEFAULT_RAG = 'backend/data/rag'
CODE_FILES = (
    'backend-spring/target/drivemate-api-0.2.0.jar',
    'backend/requirements-ml.txt', 'backend/requirements-rag.txt',
    'infra/aws/cycle_worker.py', 'infra/aws/refresh_secrets.py',
    'infra/aws/requirements-aws.txt', 'infra/aws/deploy_release.py',
    'backend/scripts/onbid_worker.py', 'backend/scripts/document_rag.py',
    'dist/index.html',
)

def read_env(path):
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        key, separator, raw = line.partition('=')
        key = key.strip()
        if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError('Invalid private environment file: ' + path.name)
        parts = shlex.split(raw, comments=True)
        if len(parts) > 1 or key in values:
            raise ValueError('Invalid private environment value: ' + path.name)
        values[key] = parts[0] if parts else ''
    return values

def prepare_secret(owner_email=None, approve_document_embeddings=False, private_root=None):
    private_root = Path(private_root or ROOT)
    output = private_root / 'backend/data/deployment'
    output.mkdir(parents=True, exist_ok=True)
    path = output / 'app-secret.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    values = {**read_env(private_root / '.env.onbid.local'), **read_env(private_root / '.env.llm.local')}
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

def scan_sources(private_root):
    sources = [read_env(private_root / '.env.onbid.local'), read_env(private_root / '.env.llm.local')]
    for filename in ('.env.kakao.local', '.env.hyundai.local'):
        path = private_root / filename
        if path.is_file():
            sources.append(read_env(path))
    values = {key: value for source in sources for key, value in source.items()}
    for key in ('ONBID_SERVICE_KEY', 'OPENAI_API_KEY'):
        if not values.get(key):
            raise ValueError('Required private scan key is absent: ' + key)
    secret_path = private_root / 'backend/data/deployment/app-secret.json'
    if secret_path.exists():
        previous = json.loads(secret_path.read_text(encoding='utf-8'))
        if not isinstance(previous, dict):
            raise ValueError('Private deployment configuration must be an object')
        sources.append({key: value for key, value in previous.items()
                        if isinstance(key, str) and isinstance(value, str)})
    return sources


def scan_values(private_root):
    return tuple({value.encode() for source in scan_sources(private_root) for key, value in source.items()
                  if key.endswith(('KEY', 'PASSWORD', 'TOKEN', 'SECRET', 'CLIENT_ID')) and value})


def public_kakao_values(private_root):
    # The browser SDK's JavaScript key is intentionally public. REST/native/admin
    # keys and OAuth credentials remain private, including when values overlap.
    key_name = 'DRIVEMATE_KAKAO_JAVASCRIPT_KEY'
    sources = scan_sources(private_root)
    values = {source[key_name] for source in sources if source.get(key_name)}
    if len(values) != 1:
        raise ValueError('Exactly one configured Kakao JavaScript key is required')
    value = next(iter(values))
    if any(other_value == value and key != key_name for source in sources for key, other_value in source.items()):
        raise ValueError('Public browser key overlaps private credentials')
    return (value.encode(),)


def selected_path(private_root, value, default):
    path = Path(value or default)
    return path if path.is_absolute() else private_root / path


def check_source(path):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('Release input must not use symlinks: ' + path.name)
    if not path.is_file():
        raise ValueError('Required release artifact absent: ' + str(path))
    if any(part in ('.git', 'app-secret.json', 'credentials.json') or part.startswith('.env')
           for part in path.parts):
        raise ValueError('Private configuration cannot be a release input')


def scan_content(content, name, secret_values, public_browser_values=()):
    permitted = public_browser_values if name.startswith('dist/_expo/static/js/web/') and name.endswith('.js') else ()
    if any(secret in content and secret not in permitted for secret in secret_values):
        raise ValueError('Secret found in release member: ' + name)
    if re.search(rb'sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}', content):
        raise ValueError('Secret-like token found in release member: ' + name)
    # A compressed JAR can hide a literal key from a byte scan of its outer file.
    if name.endswith('.jar'):
        with zipfile.ZipFile(io.BytesIO(content)) as jar:
            if sum(entry.file_size for entry in jar.infolist()) > 512 * 1024**2:
                raise ValueError('JAR exceeds release scan limit')
            for entry in jar.infolist():
                if not entry.is_dir():
                    scan_content(jar.read(entry), name + '!/' + entry.filename, secret_values)


def package(source_root, private_root, output_dir=None, *, model_dir=None,
            raw_run_dir=None, analytics_report=None, rag_dir=None, public_kakao_map=False):
    source_root, private_root = Path(source_root), Path(private_root)
    model = selected_path(private_root, model_dir, DEFAULT_MODEL)
    raw_run = selected_path(private_root, raw_run_dir, DEFAULT_RUN)
    report = selected_path(private_root, analytics_report, DEFAULT_REPORT)
    rag = selected_path(private_root, rag_dir, DEFAULT_RAG)
    output = Path(output_dir) if output_dir else source_root / 'backend/data/deployment/releases' / (
        datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4))
    if output.exists():
        raise ValueError('Release output already exists; choose a new directory')
    for directory in (model, raw_run, rag, source_root / 'dist'):
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('Required release directory absent or unsafe: ' + str(directory))
        if output.resolve().is_relative_to(directory.resolve()):
            raise ValueError('Release output must be outside selected input directories')

    members = {}

    def add(source, target):
        check_source(source)
        if target.startswith('/') or '..' in Path(target).parts or '\\' in target:
            raise ValueError('Unsafe release member path')
        if target in members and members[target] != source:
            raise ValueError('Duplicate release member: ' + target)
        members[target] = source

    def tree(directory, target):
        found = False
        for source in sorted(directory.rglob('*')):
            if source.is_symlink():
                raise ValueError('Release tree must not contain symlinks')
            if source.is_file():
                relative = source.relative_to(directory)
                if any(part.startswith('.') or part == '__pycache__' for part in relative.parts):
                    continue
                add(source, target + '/' + relative.as_posix())
                found = True
        if not found:
            raise ValueError('Required release directory is empty: ' + str(directory))

    for name in CODE_FILES:
        add(source_root / name, name)
    for source in sorted((source_root / 'backend/scripts').glob('*.py')):
        if not source.name.startswith('test_'):
            add(source, source.relative_to(source_root).as_posix())
    tree(source_root / 'dist', 'dist')
    tree(raw_run, 'backend/data/onbid/seed-run')
    add(report, 'backend/data/onbid/pipeline/latest.json')
    add(model / 'model_bundle.joblib', 'model/model_bundle.joblib')
    add(model / 'metrics.json', 'model/metrics.json')
    pointer_path = rag / 'local_collection.json'
    check_source(pointer_path)
    pointer = json.loads(pointer_path.read_text(encoding='utf-8'))
    if not isinstance(pointer, dict):
        raise ValueError('Prepared RAG collection pointer must be an object')
    relative = pointer.get('index_relative_path', '')
    index = Path(relative)
    if not relative or index.is_absolute() or '\\' in relative or '..' in index.parts or index.parts[0] != 'collections' or index.suffix != '.json':
        raise ValueError('Prepared RAG collection pointer is invalid')
    # Runtime import only needs this pointer and its verified pre-embedded corpus.
    add(pointer_path, 'backend/data/rag/local_collection.json')
    add(rag / index, 'backend/data/rag/' + index.as_posix())
    secret_values = scan_values(private_root)
    public_browser_values = public_kakao_values(private_root) if public_kakao_map else ()

    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    target = output / 'release.zip'
    manifest_path = output / 'release-manifest.json'
    try:
        file_hashes = {}
        with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            os.chmod(target, 0o600)
            for name, source in sorted(members.items()):
                check_source(source)
                content = source.read_bytes()
                scan_content(content, name, secret_values, public_browser_values)
                file_hashes[name] = hashlib.sha256(content).hexdigest()
                archive.writestr(name, content)
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        manifest = {'sha256': sha, 'bytes': target.stat().st_size, 'members': sorted(members),
                    'secret_scan': 'passed', 'public_kakao_map': public_kakao_map, 'file_sha256': file_hashes,
                    'inputs': {'model_dir': str(model), 'raw_run_dir': str(raw_run),
                               'analytics_report': str(report), 'rag_dir': str(rag)},
                    'raw_run_member_root': 'backend/data/onbid/seed-run'}
        descriptor = os.open(manifest_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    except Exception:
        target.unlink(missing_ok=True)
        manifest_path.unlink(missing_ok=True)
        output.rmdir()
        raise
    return {key: manifest[key] for key in ('sha256', 'bytes', 'secret_scan')} | {
        'members': len(members), 'output_dir': str(output)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-root', type=Path, help='Required for packaging; approved private artifact root')
    parser.add_argument('--model-dir', type=Path, help='Model bundle and metrics directory, relative to private root or absolute')
    parser.add_argument('--raw-run-dir', type=Path, help='Selected raw run directory, relative to private root or absolute')
    parser.add_argument('--analytics-report', type=Path, help='Selected aggregate latest.json, relative to private root or absolute')
    parser.add_argument('--rag-dir', type=Path, help='Directory with local_collection.json and its prepared corpus')
    parser.add_argument('--output-dir', type=Path, help='New private output directory; never overwrite an existing release')
    parser.add_argument('--secrets-only', action='store_true', help='Explicitly create/update private credential configuration instead of packaging')
    parser.add_argument('--public-kakao-map', action='store_true', help='Allow only the configured public Kakao JavaScript key in web JS bundles')
    parser.add_argument('--owner-email')
    parser.add_argument('--approve-document-embeddings', action='store_true')
    args = parser.parse_args(argv)
    if args.secrets_only:
        if any((args.model_dir, args.raw_run_dir, args.analytics_report, args.rag_dir, args.output_dir, args.public_kakao_map)):
            parser.error('Artifact options cannot be used with --secrets-only')
        prepare_secret(args.owner_email, args.approve_document_embeddings, args.private_root)
        print('Private deployment configuration prepared; values not displayed.')
        return
    if args.private_root is None:
        parser.error('--private-root is required for packaging; credentials will not be created')
    if args.owner_email or args.approve_document_embeddings:
        parser.error('Credential changes require explicit --secrets-only')
    result = package(ROOT, args.private_root, args.output_dir, model_dir=args.model_dir,
                     raw_run_dir=args.raw_run_dir, analytics_report=args.analytics_report, rag_dir=args.rag_dir,
                     public_kakao_map=args.public_kakao_map)
    print(json.dumps(result))

if __name__ == '__main__': main()
