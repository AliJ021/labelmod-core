#!/usr/bin/env python3
"""Fixture-only regression checks; never reads or writes the host APT config."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_browser_apt", Path(__file__).with_name("prepare-browser-apt.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

OLD = "http://azure.archive.ubuntu.com/ubuntu"
NEW = "https://archive.ubuntu.com/ubuntu"


class BrowserAptPreparation(unittest.TestCase):
    def test_deb822_preserves_suites_components_and_signing(self):
        source = f"Types: deb deb-src\nURIs: {OLD}/\nSuites: noble noble-updates noble-backports noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        self.assertEqual(module.rewrite_sources(source, True), source.replace(OLD, NEW))

    def test_legacy_with_options_and_crlf(self):
        source = f"deb [arch=amd64 signed-by=/keys/ubuntu.gpg] {OLD} noble main\r\ndeb-src https://azure.archive.ubuntu.com/ubuntu/ noble-updates universe\r\n"
        expected = source.replace(OLD, NEW).replace("https://azure.archive.ubuntu.com/ubuntu/", NEW + "/")
        self.assertEqual(module.rewrite_sources(source, False), expected)

    def test_uri_continuation_leaves_security_and_third_party_intact(self):
        source = f"Types: deb\nURIs: https://example.test/repo\n {OLD}\n https://security.ubuntu.com/ubuntu\nSuites: noble-security\nSigned-By: {OLD}\n\nTypes: deb\nURIs: https://packages.microsoft.com/repos/azure-cli\n"
        self.assertEqual(module.rewrite_sources(source, True), source.replace(" " + OLD + "\n", " " + NEW + "\n", 1))

    def test_comments_unknown_hosts_and_lookalikes_unchanged(self):
        uris = ["http://azure.archive.ubuntu.com.evil/ubuntu", OLD + "-other", OLD + "/pool", OLD + "?query=1", "http://example.test/ubuntu", "http://security.ubuntu.com/ubuntu"]
        for deb822 in (False, True):
            prefix = "URIs: " if deb822 else "deb "
            source = f"# {OLD}\n" + "\n".join(prefix + uri for uri in uris) + f"\n# {prefix}{OLD}\n"
            self.assertEqual(module.rewrite_sources(source, deb822), source)

    def test_filesystem_only_known_source_files_and_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            apt = Path(temporary)
            directory = apt / "sources.list.d"
            directory.mkdir()
            intended = apt / "sources.list"
            intended.write_bytes(f"deb {OLD} noble main\n".encode())
            third_party = directory / "vendor.sources"
            third_party.write_bytes(b"Types: deb\nURIs: https://example.test/repo\nSuites: stable\n")
            ignored = directory / "backup.sources.save"
            ignored.write_bytes(f"URIs: {OLD}\n".encode())
            before = third_party.read_bytes(), third_party.stat().st_mtime_ns
            self.assertEqual(module.prepare(apt), 1)
            self.assertEqual(intended.read_bytes(), f"deb {NEW} noble main\n".encode())
            self.assertEqual((third_party.read_bytes(), third_party.stat().st_mtime_ns), before)
            self.assertEqual(ignored.read_bytes(), f"URIs: {OLD}\n".encode())
            self.assertEqual(module.prepare(apt), 0)

    def test_deb822_file_preserves_other_fields_and_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            apt = Path(temporary)
            directory = apt / "sources.list.d"
            directory.mkdir()
            source = f"Types: deb\r\nURIs: {OLD}/\r\nSuites: noble noble-security\r\nComponents: main universe\r\nSigned-By: /keys/ubuntu.gpg\r\n".encode()
            path = directory / "ubuntu.sources"
            path.write_bytes(source)
            self.assertEqual(module.prepare(apt), 1)
            self.assertEqual(path.read_bytes(), source.replace(OLD.encode(), NEW.encode()))


if __name__ == "__main__":
    unittest.main()
