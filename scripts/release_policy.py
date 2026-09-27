"""Shared, side-effect-free policy for stable and fast prerelease artifacts."""
import re

COMPANION_URL = 'https://borealis.loosewire.dev'
VERSION_PATTERN = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.[1-9][0-9]*)?'


def release_policy(tag, tool):
    match = re.fullmatch('v' + VERSION_PATTERN, tag)
    if not match or tag != f"v{tool['versionName']}":
        raise ValueError('Release tag must exactly match v<versionName>; supported suffixes are alpha.N, beta.N, and rc.N.')
    if tool['id'] != 'com.loosewire.borealis' or type(tool['versionCode']) is not int or not 1 <= tool['versionCode'] <= 2_100_000_000:
        raise ValueError('Unexpected tool identity or versionCode.')
    prerelease = match.group(1) is not None
    return {
        'prerelease': prerelease,
        'fastPrerelease': prerelease,
        'channel': match.group(1) or 'stable',
        'minified': not prerelease,
        'shrinkResources': not prerelease,
    }


def publication_flags(repository, is_private, prerelease):
    """Choose GitHub flags independently from APK optimization/build policy.

    Stable builds and every build of a public repository require an explicit
    publication decision. Only private testing prereleases publish automatically.
    """
    if repository != 'gavdevs/borealis':
        raise ValueError('Only the trusted gavdevs/borealis repository may create releases.')
    if type(is_private) is not bool or type(prerelease) is not bool:
        raise ValueError('Repository visibility and prerelease channel must be explicit booleans.')
    flags = []
    if not is_private or not prerelease:
        flags.append('--draft')
    if prerelease:
        flags.extend(['--prerelease', '--latest=false'])
    return flags


def validate_build_metadata(build, policy, tool):
    expected = {
        'schemaVersion': 1,
        'variant': 'release',
        'versionName': tool['versionName'],
        'versionCode': tool['versionCode'],
        'companionUrl': COMPANION_URL,
        'fastPrerelease': policy['fastPrerelease'],
        'minified': policy['minified'],
        'shrinkResources': policy['shrinkResources'],
        'debuggable': False,
    }
    if build != expected or any(type(build.get(key)) is not type(value) for key, value in expected.items()):
        raise ValueError('Release build flags do not match the tagged release policy.')
    return expected


def validate_apk_badging(badging, tool):
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.MULTILINE)
    if not package or package.groups() != (tool['id'], str(tool['versionCode']), tool['versionName']):
        raise ValueError('Packaged APK identity does not match lighttool.toml.')
    if re.search(r'^application-debuggable(?:\s|$)', badging, re.MULTILINE):
        raise ValueError('A distributable Borealis APK must not be debuggable.')


def release_notes(tag, tool, commit, certificate, policy):
    if policy['prerelease']:
        status = ('Fast prerelease for physical-device testing. Automatic publication is permitted only '
                  'inside the private repository; builds of a public repository remain drafts for review. '
                  'Not a stable release; compilation and tests still run. Code/resource shrinking is disabled; '
                  'the APK remains non-debuggable and uses the normal release signing identity. '
                  'Hardware behavior is not established by build success.')
    else:
        status = 'Review the APK on physical hardware before publishing this stable-release draft.'
    return f'''# Borealis {tag}

Experimental, sideload-only Light Phone III build. Not an approved Light tool.

- Companion: {COMPANION_URL}
- Source revision: `{commit}`
- Android version code: `{tool['versionCode']}`
- Signing certificate SHA-256: `{certificate}`
- Channel: `{policy['channel']}`

{status}

An existing `com.loosewire.borealis` installation signed with the dedicated release
key can update in place without clearing data. Older `com.gav.borealis` builds are
a different Android app: this release installs separately and requires pairing
and Google sign-in again. Do not uninstall the old app merely to install this one.
A development-key installation of the same package cannot update in place to the
dedicated release key; plan that transition before uninstalling anything.

Keep the source archives, SDK patch, dependency manifest, build instructions,
and license notices together with the APK when distributing it. While this repository
is private, its source links are not accessible to recipients outside the repository.
Making a public draft does not publish its APK; public distribution is a separate,
explicit maintainer decision after hardware and source-package review.
'''
