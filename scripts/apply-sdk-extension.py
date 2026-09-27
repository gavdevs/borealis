#!/usr/bin/env python3
"""Add Borealis's isolated Kotlin extension to a fresh, patched Light SDK."""

import argparse
from pathlib import Path


EXTENSION_ROOT = Path(__file__).resolve().parent.parent / 'sdk-extension'
SOURCE_TREES = (
    Path('client/src/main/kotlin'),
    Path('client/src/test/kotlin'),
)
MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024


def reject_symlinks(path):
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError(f'Symlinks are not allowed: {component}')


def apply_extension(extension, sdk):
    extension = Path(extension).absolute()
    sdk = Path(sdk).absolute()
    reject_symlinks(extension)
    reject_symlinks(sdk)
    if not extension.is_dir() or not (sdk / 'sdk/client').is_dir():
        raise ValueError('Expected an extension directory and an existing SDK client module.')
    extension = extension.resolve()
    sdk = sdk.resolve()
    if extension.is_relative_to(sdk) or sdk.is_relative_to(extension):
        raise ValueError('Extension and SDK directories must not overlap.')

    plans = []
    total_bytes = 0
    for source in sorted(extension.rglob('*')):
        reject_symlinks(source)
        relative = source.relative_to(extension)
        if source.is_dir():
            if not any(relative.is_relative_to(tree) or tree.is_relative_to(relative)
                       for tree in SOURCE_TREES):
                raise ValueError(f'Unsupported extension directory: {relative}')
            continue
        if (not source.is_file() or source.suffix != '.kt' or
                not any(relative.is_relative_to(tree) for tree in SOURCE_TREES)):
            raise ValueError(f'Only Kotlin files in the approved source trees are allowed: {relative}')
        if len(plans) >= MAX_FILES:
            raise ValueError('Too many extension files.')
        with source.open('rb') as stream:
            contents = stream.read(MAX_FILE_BYTES + 1)
        if len(contents) > MAX_FILE_BYTES:
            raise ValueError(f'Extension file is too large: {relative}')
        total_bytes += len(contents)
        if total_bytes > MAX_TOTAL_BYTES:
            raise ValueError('Extension exceeds the total size limit.')

        target = sdk / 'sdk' / relative
        reject_symlinks(target)
        if not target.resolve().is_relative_to(sdk / 'sdk/client'):
            raise ValueError(f'Extension target escapes the SDK client module: {relative}')
        if target.exists():
            raise ValueError(f'Refusing to overwrite an existing SDK path: {target}')
        for parent in target.parents:
            if parent.exists() and not parent.is_dir():
                raise ValueError(f'Extension target parent is not a directory: {parent}')
            if parent == sdk:
                break
        plans.append((target, contents))

    if not plans:
        raise ValueError('No Kotlin extension files found.')
    for target, contents in plans:
        reject_symlinks(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        reject_symlinks(target)
        with target.open('xb') as stream:
            stream.write(contents)
    return [target.relative_to(sdk) for target, _ in plans]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sdk', type=Path, help='Fresh SDK checkout after applying the Borealis patch')
    args = parser.parse_args()
    try:
        copied = apply_extension(EXTENSION_ROOT, args.sdk)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Cannot apply SDK extension: {error}\n')
    print(f'Applied {len(copied)} Kotlin extension files to the SDK client module.')


if __name__ == '__main__':
    main()
