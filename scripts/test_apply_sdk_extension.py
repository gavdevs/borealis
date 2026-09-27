import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('sdk_extension', Path(__file__).with_name('apply-sdk-extension.py'))
extension_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extension_module)


class ApplySdkExtensionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.extension = self.root / 'extension'
        self.sdk = self.root / 'sdk'
        self.extension.mkdir()
        (self.sdk / 'sdk/client').mkdir(parents=True)

    def add_source(self, relative='client/src/main/kotlin/com/example/SignIn.kt', contents=b'package com.example\n'):
        source = self.extension / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(contents)
        return source

    def apply(self):
        return extension_module.apply_extension(self.extension, self.sdk)

    def test_copies_main_and_test_sources_in_order(self):
        test_source = self.add_source('client/src/test/kotlin/com/example/SignInTest.kt')
        main_source = self.add_source()
        copied = self.apply()
        expected = [Path('sdk') / source.relative_to(self.extension) for source in (main_source, test_source)]
        self.assertEqual(expected, copied)
        for source, relative in zip((main_source, test_source), copied):
            self.assertEqual(source.read_bytes(), (self.sdk / relative).read_bytes())

    def test_refuses_existing_target_before_copying_any_files(self):
        self.add_source()
        source = self.add_source('client/src/test/kotlin/com/example/SignInTest.kt')
        target = self.sdk / 'sdk' / source.relative_to(self.extension)
        target.parent.mkdir(parents=True)
        target.write_text('existing source')
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            self.apply()
        self.assertEqual('existing source', target.read_text())
        self.assertFalse((self.sdk / 'sdk/client/src/main').exists())

    def test_rejects_unsupported_source_path(self):
        self.add_source('plugin/src/main/kotlin/Unsafe.kt')
        with self.assertRaisesRegex(ValueError, 'Unsupported extension directory'):
            self.apply()

    def test_rejects_non_kotlin_files(self):
        self.add_source('client/src/main/kotlin/unexpected.jar')
        with self.assertRaisesRegex(ValueError, 'Only Kotlin files'):
            self.apply()

    def test_rejects_source_file_symlink(self):
        source = self.add_source()
        source.with_name('Link.kt').symlink_to(source)
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            self.apply()

    def test_rejects_source_directory_symlink(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.extension / 'client').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            self.apply()

    def test_rejects_destination_directory_symlink(self):
        self.add_source()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.sdk / 'sdk/client/src').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            self.apply()
        self.assertEqual([], list(outside.iterdir()))

    def test_rejects_symlink_to_root(self):
        self.add_source()
        link = self.root / 'linked-extension'
        link.symlink_to(self.extension, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            extension_module.apply_extension(link, self.sdk)

    def test_rejects_empty_extension(self):
        with self.assertRaisesRegex(ValueError, 'No Kotlin'):
            self.apply()

    def test_rejects_oversized_source(self):
        self.add_source(contents=b'12345')
        with patch.object(extension_module, 'MAX_FILE_BYTES', 4):
            with self.assertRaisesRegex(ValueError, 'too large'):
                self.apply()

    def test_rejects_too_many_files_before_copying(self):
        self.add_source()
        self.add_source('client/src/test/kotlin/Test.kt')
        with patch.object(extension_module, 'MAX_FILES', 1):
            with self.assertRaisesRegex(ValueError, 'Too many'):
                self.apply()
        self.assertFalse((self.sdk / 'sdk/client/src').exists())

    def test_rejects_oversized_total(self):
        self.add_source(contents=b'123')
        self.add_source('client/src/test/kotlin/Test.kt', contents=b'456')
        with patch.object(extension_module, 'MAX_TOTAL_BYTES', 5):
            with self.assertRaisesRegex(ValueError, 'total size'):
                self.apply()

    def test_rejects_overlapping_roots(self):
        with self.assertRaisesRegex(ValueError, 'must not overlap'):
            extension_module.apply_extension(self.sdk / 'sdk', self.sdk)


if __name__ == '__main__':
    unittest.main()
