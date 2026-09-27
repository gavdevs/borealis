"""Shared, side-effect-free policy for stable and fast prerelease artifacts."""
import re

COMPANION_URL = 'https://borealis.loosewire.dev'
VERSION_PATTERN = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.[1-9][0-9]*)?'


def release_policy(tag, tool):
    match = re.fullmatch('v' + VERSION_PATTERN, tag)
    if not match or tag != f"v{tool['versionName']}":
        raise ValueError('Release tag must exactly match v<versionName>; supported suffixes are alpha.N, beta.N, and rc.N.')
    if tool['id'] != 'com.gav.borealis' or type(tool['versionCode']) is not int or not 1 <= tool['versionCode'] <= 2_100_000_000:
        raise ValueError('Unexpected tool identity or versionCode.')
    prerelease = match.group(1) is not None
    return {
        'prerelease': prerelease,
        'fastPrerelease': prerelease,
        'channel': match.group(1) or 'stable',
        'draft': not prerelease,
        'minified': not prerelease,
        'shrinkResources': not prerelease,
    }


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
        status = ('Fast prerelease for physical-device testing, published only inside the private repository. '
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

An existing dedicated-key installation can update in place without clearing data.
A development-key installation cannot update in place to the dedicated release key;
plan that initial transition before uninstalling anything.

Keep the source archives, SDK patch, dependency manifest, build instructions,
and license notices together with the APK when distributing it. This private
GitHub release does not make source available to recipients outside this repository.
'''
