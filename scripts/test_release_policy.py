import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from release_policy import (
    COMPANION_URL, publication_flags, release_notes, release_policy, validate_apk_badging, validate_build_metadata,
)

SPEC = importlib.util.spec_from_file_location('release_metadata', Path(__file__).with_name('release-metadata.py'))
METADATA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METADATA)


def tool(version='0.1.6-alpha.1'):
    return {'id': 'com.loosewire.borealis', 'versionName': version, 'versionCode': 7}


def build_metadata(version='0.1.6-alpha.1'):
    metadata = tool(version)
    policy = release_policy('v' + version, metadata)
    return {
        'schemaVersion': 1, 'variant': 'release', 'versionName': version,
        'versionCode': 7, 'companionUrl': COMPANION_URL,
        'fastPrerelease': policy['fastPrerelease'], 'minified': policy['minified'],
        'shrinkResources': policy['shrinkResources'], 'debuggable': False,
    }


class ReleasePolicyTest(unittest.TestCase):
    def test_stable_is_minified(self):
        policy = release_policy('v0.1.6', tool('0.1.6'))
        self.assertEqual(policy, {
            'prerelease': False, 'fastPrerelease': False, 'channel': 'stable',
            'minified': True, 'shrinkResources': True,
        })

    def test_numbered_prerelease_channels_build_fast(self):
        for channel in ('alpha', 'beta', 'rc'):
            with self.subTest(channel=channel):
                version = f'0.1.6-{channel}.12'
                self.assertEqual(release_policy('v' + version, tool(version)), {
                    'prerelease': True, 'fastPrerelease': True, 'channel': channel,
                    'minified': False, 'shrinkResources': False,
                })

    def test_stable_is_always_a_draft_regardless_of_visibility(self):
        for is_private in (True, False):
            with self.subTest(is_private=is_private):
                self.assertEqual(publication_flags('gavdevs/borealis', is_private, False), ['--draft'])

    def test_private_prereleases_keep_automatic_testing_publication(self):
        self.assertEqual(publication_flags('gavdevs/borealis', True, True), ['--prerelease', '--latest=false'])

    def test_public_prereleases_are_never_automatically_published(self):
        self.assertEqual(publication_flags('gavdevs/borealis', False, True), ['--draft', '--prerelease', '--latest=false'])

    def test_publication_flags_fail_closed_for_other_repositories_and_ambiguous_inputs(self):
        for repository in ('other/borealis', 'gavdevs/other', '', None):
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                publication_flags(repository, True, True)
        for value in ('true', 'false', 0, 1, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                publication_flags('gavdevs/borealis', value, True)
            with self.subTest(value=value), self.assertRaises(ValueError):
                publication_flags('gavdevs/borealis', True, value)

    def test_workflow_calls_the_shared_publication_policy(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/release.yml').read_text()
        self.assertIn("if: github.repository == 'gavdevs/borealis'", workflow)
        self.assertIn('from release_policy import publication_flags', workflow)
        self.assertIn("publication_flags(repository['nameWithOwner'], repository['isPrivate'], channel == 'true')", workflow)
        self.assertIn('--json nameWithOwner,isPrivate', workflow)
        self.assertIn('"${release_flags[@]}"', workflow)

    def test_invalid_versions_fail_closed(self):
        for version in ('0.1.6-alpha', '0.1.6-alpha.0', '0.1.6-alpha.01', '0.1.6-BETA.1',
                        '0.1.6-dev.1', '0.1.6-rc.1+build', '0.1.6+build', '00.1.6',
                        '0.01.6', '0.1.06', '0.1.6-alpha.１', '0.1.٦-alpha.1',
                        '0.1.6\n', '0.1.6-alpha.1/evil', ' 0.1.6'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                release_policy('v' + version, tool(version))

    def test_tag_requires_v_prefix_and_exact_metadata(self):
        for tag in ('0.1.6-alpha.1', 'v0.1.6-alpha.2', 'v0.1.6'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release_policy(tag, tool())

    def test_tool_identity_and_version_code_guard(self):
        for changes in ({'id': 'com.example.other'}, {'versionCode': 0}, {'versionCode': True},
                        {'versionCode': '7'}, {'versionCode': 2_100_000_001}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                release_policy('v0.1.6-alpha.1', tool() | changes)

    def test_previous_package_identity_is_rejected_for_future_releases(self):
        for version in ('0.1.6', '0.1.6-alpha.1'):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, 'Unexpected tool identity'):
                release_policy('v' + version, tool(version) | {'id': 'com.gav.borealis'})

    def test_valid_stable_and_fast_build_metadata(self):
        for version in ('0.1.6', '0.1.6-alpha.1'):
            with self.subTest(version=version):
                expected = build_metadata(version)
                self.assertEqual(validate_build_metadata(
                    expected, release_policy('v' + version, tool(version)), tool(version),
                ), expected)

    def test_rejects_mislabeled_or_unsafe_build_flags(self):
        for changes in ({'debuggable': True}, {'variant': 'debug'}, {'minified': True},
                        {'shrinkResources': True}, {'fastPrerelease': False},
                        {'companionUrl': 'http://10.0.2.2:8787'}, {'versionCode': 6},
                        {'versionName': '0.1.6'}, {'schemaVersion': 2},
                        {'debuggable': 0}, {'unreviewedFlag': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_build_metadata(build_metadata() | changes,
                                        release_policy('v0.1.6-alpha.1', tool()), tool())

    def test_stable_cannot_package_unminified_apk(self):
        build = build_metadata('0.1.6') | {'minified': False, 'shrinkResources': False}
        with self.assertRaises(ValueError):
            validate_build_metadata(build, release_policy('v0.1.6', tool('0.1.6')), tool('0.1.6'))

    def test_missing_build_flag_fails(self):
        build = build_metadata()
        del build['debuggable']
        with self.assertRaises(ValueError):
            validate_build_metadata(build, release_policy('v0.1.6-alpha.1', tool()), tool())

    def test_packaged_apk_identity_is_checked_independently(self):
        validate_apk_badging("package: name='com.loosewire.borealis' versionCode='7' versionName='0.1.6-alpha.1' platformBuildVersionName='16'\n", tool())
        for badging in ('', "package: name='com.loosewire.borealis' versionCode='6' versionName='0.1.6-alpha.1'",
                        "package: name='com.gav.borealis' versionCode='7' versionName='0.1.6-alpha.1'",
                        "package: name='com.example.other' versionCode='7' versionName='0.1.6-alpha.1'",
                        "package: name='com.loosewire.borealis' versionCode='7' versionName='0.1.6'"):
            with self.subTest(badging=badging), self.assertRaises(ValueError):
                validate_apk_badging(badging, tool())

    def test_debuggable_packaged_apk_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_apk_badging("package: name='com.loosewire.borealis' versionCode='7' versionName='0.1.6-alpha.1'\napplication-debuggable\n", tool())

    def test_notes_explain_package_migration_without_requiring_uninstall(self):
        note = release_notes('v0.1.6', tool('0.1.6'), 'abc123', 'abc456',
                             release_policy('v0.1.6', tool('0.1.6')))
        self.assertIn('`com.loosewire.borealis` installation signed with the dedicated release', note)
        self.assertIn('Older `com.gav.borealis` builds are', note)
        self.assertIn('installs separately and requires pairing', note)
        self.assertIn('Google sign-in again', note)
        self.assertIn('Do not uninstall the old app merely to install this one.', note)

    def test_notes_distinguish_prerelease_and_draft(self):
        for version, required, excluded in (
            ('0.1.6-alpha.1', 'Fast prerelease', 'before publishing this stable-release draft'),
            ('0.1.6', 'before publishing this stable-release draft', 'Code/resource shrinking is disabled'),
        ):
            with self.subTest(version=version):
                note = release_notes('v' + version, tool(version), 'abc123', 'abc456',
                                     release_policy('v' + version, tool(version)))
                self.assertIn(required, note)
                self.assertNotIn(excluded, note)
                self.assertIn('license notices', note)
                self.assertIn('private', note)


class ReleaseSourceGuardTest(unittest.TestCase):
    @patch.object(METADATA.subprocess, 'run')
    @patch.object(METADATA.subprocess, 'check_output')
    def test_exact_tag_clean_source_main_ancestry(self, output, run):
        output.side_effect = ['abc123\n', 'abc123\n', '']
        self.assertEqual(METADATA.validate_source(Path('/repo'), 'v0.1.6-alpha.1'), 'abc123')
        run.assert_called_once_with(['git', 'merge-base', '--is-ancestor', 'abc123', 'origin/main'],
                                    cwd=Path('/repo'), check=True)

    @patch.object(METADATA.subprocess, 'run')
    @patch.object(METADATA.subprocess, 'check_output')
    def test_tag_cannot_point_at_different_commit(self, output, run):
        output.side_effect = ['abc123', 'def456']
        with self.assertRaisesRegex(ValueError, 'exact existing release tag'):
            METADATA.validate_source(Path('/repo'), 'v0.1.6-alpha.1')
        run.assert_not_called()

    @patch.object(METADATA.subprocess, 'run')
    @patch.object(METADATA.subprocess, 'check_output')
    def test_dirty_tracked_source_is_rejected(self, output, run):
        output.side_effect = ['abc123', 'abc123', ' M app/lighttool.toml']
        with self.assertRaisesRegex(ValueError, 'Tracked source must be clean'):
            METADATA.validate_source(Path('/repo'), 'v0.1.6-alpha.1')

    @patch.object(METADATA.subprocess, 'run')
    @patch.object(METADATA.subprocess, 'check_output')
    def test_non_main_commit_is_rejected(self, output, run):
        output.side_effect = ['abc123', 'abc123']
        run.side_effect = subprocess.CalledProcessError(1, ['git', 'merge-base'])
        with self.assertRaises(subprocess.CalledProcessError):
            METADATA.validate_source(Path('/repo'), 'v0.1.6-alpha.1')


if __name__ == '__main__':
    unittest.main()
