#!/usr/bin/env python3
"""Verify a release APK and create source, checksum, and provenance assets.

Only committed Borealis/SDK source is archived. No .env, signing key, local
database, Gradle cache, or dirty local file can enter the source archives.
"""
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tomllib
from urllib.request import urlopen
from release_policy import (
    COMPANION_URL, release_notes, release_policy, validate_apk_badging, validate_build_metadata,
)

ROOT = Path(__file__).resolve().parent.parent
SDK_REVISION = '52fbc5a8aedbd3c4c88037580709e53540086229'
GPLAY_REVISION = '18ec2bd74995d30e500b756359a4de3e37976f03'
output = ROOT / 'release-output'
output.mkdir(exist_ok=True)
sdk = ROOT / '.ci/light-sdk'
tool = tomllib.loads((ROOT / 'app/lighttool.toml').read_text())['tool']
catalog = tomllib.loads((ROOT / 'gradle/libs.versions.toml').read_text())
if catalog['versions']['gplayapi'] != '3.6.4':
    raise SystemExit('Update and verify the GPlayAPI source pin when changing its dependency version.')
if catalog['versions']['tink'] != '1.20.0':
    raise SystemExit('Update the Tink policy, license notices, and provenance pin together.')


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


if git(sdk, 'rev-parse', 'HEAD') != SDK_REVISION:
    raise SystemExit('Unexpected SDK revision.')
extension_files = sorted((ROOT / 'sdk-extension/client').rglob('*.kt'))
if not extension_files:
    raise SystemExit('SDK extension sources are missing.')
for source in extension_files:
    built_source = sdk / 'sdk' / source.relative_to(ROOT / 'sdk-extension')
    if not built_source.is_file() or sha256(source) != sha256(built_source):
        raise SystemExit('Built SDK extension differs from the corresponding source.')
commit = git(ROOT, 'rev-parse', 'HEAD')
tag = f"v{tool['versionName']}"
if os.environ.get('RELEASE_TAG') != tag:
    raise SystemExit('Tag and APK version do not match.')
try:
    policy = release_policy(tag, tool)
    build = validate_build_metadata(
        json.loads((ROOT / 'app/build/reports/release-build.json').read_text()), policy, tool,
    )
except ValueError as error:
    raise SystemExit(str(error)) from error
apk_dir = ROOT / 'app/build/outputs/apk/release'
apk_metadata = json.loads((apk_dir / 'output-metadata.json').read_text())
elements = apk_metadata['elements']
if apk_metadata['applicationId'] != tool['id'] or len(elements) != 1:
    raise SystemExit('Expected exactly one Borealis release APK.')
element = elements[0]
if element['versionCode'] != tool['versionCode'] or element['versionName'] != tool['versionName']:
    raise SystemExit('APK metadata does not match lighttool.toml.')
apk = (apk_dir / element['outputFile']).resolve()
apk.relative_to(apk_dir.resolve())
build_tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0'
badging = subprocess.check_output([str(build_tools / 'aapt2'), 'dump', 'badging', str(apk)], text=True)
try:
    validate_apk_badging(badging, tool)
except ValueError as error:
    raise SystemExit(str(error)) from error
signer = build_tools / 'apksigner'
verification = subprocess.check_output(
    [str(signer), 'verify', '--verbose', '--print-certs', '--min-sdk-version', '34', str(apk)], text=True,
)
fingerprints = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$', verification, re.MULTILINE)
expected = os.environ['BOREALIS_RELEASE_CERT_SHA256'].replace(':', '').lower()
if not re.fullmatch(r'[0-9a-f]{64}', expected) or [fingerprint.lower() for fingerprint in fingerprints] != [expected]:
    raise SystemExit('APK signing certificate does not match the dedicated release identity.')
apk_name = f"borealis-{tag}-vc{tool['versionCode']}.apk"
shutil.copyfile(apk, output / apk_name)
(output / 'apk-signature.txt').write_text(verification)
(output / 'release-build.json').write_text(json.dumps(build, indent=2) + '\n')

subprocess.run(['git', 'archive', '--format=tar.gz', '--prefix=borealis/', f'--output={output / "borealis-source.tar.gz"}', commit], cwd=ROOT, check=True)
subprocess.run(['git', 'archive', '--format=tar.gz', '--prefix=light-sdk/', f'--output={output / "light-sdk-base-source.tar.gz"}', SDK_REVISION], cwd=sdk, check=True)
shutil.copyfile(ROOT / 'patches/light-sdk-borealis.patch', output / 'light-sdk-borealis.patch')
shutil.copyfile(ROOT / 'patches/LICENSE.light-sdk', output / 'LICENSE.light-sdk')
shutil.copyfile(ROOT / 'licenses/LICENSE.tink', output / 'LICENSE.tink')
shutil.copyfile(ROOT / 'LICENSE', output / 'LICENSE')
shutil.copyfile(ROOT / 'THIRD_PARTY_NOTICES.md', output / 'THIRD_PARTY_NOTICES.md')
shutil.copyfile(ROOT / 'docs/releases.md', output / 'BUILD-INSTRUCTIONS.md')

source_url = f'https://gitlab.com/AuroraOSS/gplayapi/-/archive/{GPLAY_REVISION}/gplayapi-{GPLAY_REVISION}.tar.gz'
gplay_archive = output / 'gplayapi-3.6.4-source.tar.gz'
with urlopen(source_url, timeout=60) as response, gplay_archive.open('wb') as target:
    shutil.copyfileobj(response, target)
with tarfile.open(gplay_archive, 'r:gz') as archive:
    prefix = f'gplayapi-{GPLAY_REVISION}/'
    build_file = archive.extractfile(prefix + 'lib/build.gradle.kts')
    if build_file is None or 'val libVersion = "3.6.4"' not in build_file.read().decode():
        raise SystemExit('Downloaded GPlayAPI source does not match the pinned release.')
    if archive.getmember(prefix + 'LICENSES/GPL-3.0-or-later.txt').size == 0:
        raise SystemExit('GPlayAPI source archive is missing its license.')

dependencies = output / 'runtime-dependencies.tsv'
if not dependencies.is_file():
    raise SystemExit('Resolved release dependency provenance is missing.')
with dependencies.open() as stream:
    manifest = csv.DictReader(stream, delimiter='\t')
    if manifest.fieldnames != ['coordinate', 'artifact', 'sha256']:
        raise SystemExit('Unexpected dependency provenance format.')
    dependency_rows = list(manifest)
required_coordinates = {
    'com.auroraoss:gplayapi:3.6.4',
    'com.google.crypto.tink:tink:1.20.0',
    'project:light-sdk:sdk:client',
    'project:light-sdk:sdk:shared',
    'project:light-sdk:sdk:ui',
}
if not required_coordinates <= {row['coordinate'] for row in dependency_rows}:
    raise SystemExit('Dependency provenance is missing required Play client, Tink, or Light SDK artifacts.')
if not all(row['artifact'] and re.fullmatch(r'[0-9a-f]{64}', row['sha256'] or '') for row in dependency_rows):
    raise SystemExit('Dependency provenance contains an invalid artifact hash.')
provenance = {
    'schemaVersion': 2,
    'lane': 'experimental-sideloaded',
    'repository': 'https://github.com/gavdevs/borealis',
    'commit': commit,
    'tag': tag,
    'channel': policy['channel'],
    'prerelease': policy['prerelease'],
    'build': build,
    'applicationId': tool['id'],
    'versionCode': tool['versionCode'],
    'companionUrl': COMPANION_URL,
    'apk': apk_name,
    'signingCertificateSha256': expected,
    'sdk': {'repository': 'https://github.com/gavdevs/light-sdk', 'commit': SDK_REVISION,
            'patchSha256': sha256(output / 'light-sdk-borealis.patch'),
            'extensionInstallerSha256': sha256(ROOT / 'scripts/apply-sdk-extension.py'),
            'extensionFiles': {
                str(path.relative_to(ROOT)): sha256(path)
                for path in extension_files
            }},
    'gplayapi': {'coordinate': 'com.auroraoss:gplayapi:3.6.4', 'commit': GPLAY_REVISION,
                 'sourceUrl': source_url, 'sourceSha256': sha256(gplay_archive)},
    'tink': {'coordinate': 'com.google.crypto.tink:tink:1.20.0', 'license': 'Apache-2.0',
             'sourceUrl': 'https://github.com/tink-crypto/tink-java/tree/v1.20.0'},
    'toolchain': {'java': 'Temurin 17', 'gradle': '9.0.0', 'androidCompileSdk': 36, 'apkVerificationBuildTools': '36.0.0'},
    'workflowRun': f"https://github.com/{os.environ.get('GITHUB_REPOSITORY', 'gavdevs/borealis')}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}",
}
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
(output / 'RELEASE-NOTES.md').write_text(release_notes(tag, tool, commit, expected, policy))
assets = sorted(path for path in output.iterdir() if path.is_file() and path.name != 'SHA256SUMS')
(output / 'SHA256SUMS').write_text(''.join(f'{sha256(path)}  {path.name}\n' for path in assets))
print(f'Packaged {apk_name} with source, signature verification, and {len(assets)} checksummed assets.')
