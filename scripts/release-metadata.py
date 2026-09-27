#!/usr/bin/env python3
"""Validate an existing release tag and expose nonsecret build metadata to CI."""
import os
from pathlib import Path
import subprocess
import tomllib
from release_policy import release_policy


def validate_source(root, tag):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

    commit = git('rev-parse', 'HEAD')
    if git('rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}') != commit:
        raise ValueError('Check out the exact existing release tag before building.')
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], cwd=root, check=True)
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Tracked source must be clean before a release build.')
    return commit


def main():
    root = Path(__file__).resolve().parent.parent
    metadata = tomllib.loads((root / 'app/lighttool.toml').read_text())['tool']
    tag = os.environ.get('RELEASE_TAG', '')
    try:
        policy = release_policy(tag, metadata)
        commit = validate_source(root, tag)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a') as stream:
            stream.write(f"tag={tag}\nversion={metadata['versionName']}\nversion_code={metadata['versionCode']}\ncommit={commit}\n")
            stream.write(f"prerelease={str(policy['prerelease']).lower()}\nfast_prerelease={str(policy['fastPrerelease']).lower()}\n")
    print(f"Validated {tag} ({policy['channel']}, version code {metadata['versionCode']}) at {commit}.")


if __name__ == '__main__':
    main()
