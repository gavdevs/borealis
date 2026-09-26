#!/usr/bin/env python3
"""Validate an existing release tag and expose nonsecret build metadata to CI."""
import os
from pathlib import Path
import re
import subprocess
import tomllib

root = Path(__file__).resolve().parent.parent
metadata = tomllib.loads((root / 'app/lighttool.toml').read_text())['tool']
tag = os.environ.get('RELEASE_TAG', '')
if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag) or tag != f"v{metadata['versionName']}":
    raise SystemExit('Release tag must be v<versionName> from app/lighttool.toml.')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


commit = git('rev-parse', 'HEAD')
if git('rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}') != commit:
    raise SystemExit('Check out the exact existing release tag before building.')
subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], cwd=root, check=True)
if git('status', '--porcelain', '--untracked-files=no'):
    raise SystemExit('Tracked source must be clean before a release build.')
if metadata['id'] != 'com.gav.borealis' or metadata['versionCode'] < 1:
    raise SystemExit('Unexpected tool identity or versionCode.')

if output := os.environ.get('GITHUB_OUTPUT'):
    with open(output, 'a') as stream:
        stream.write(f"tag={tag}\nversion={metadata['versionName']}\nversion_code={metadata['versionCode']}\ncommit={commit}\n")
print(f"Validated {tag} (version code {metadata['versionCode']}) at {commit}.")
