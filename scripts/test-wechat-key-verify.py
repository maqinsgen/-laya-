#!/usr/bin/env python3
"""Synthetic-only tests: no process access, user database, or network calls."""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

# Loading our pure verifier does not import or execute the upstream program.
sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("wechat_key_verify.py")
SPEC = importlib.util.spec_from_file_location("wechat_key_verify", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
PASSPHRASE = bytes(range(32))
SALT = bytes(range(16))


def synthetic_page(passphrase=PASSPHRASE, salt=SALT):
    key = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, 32)
    # Synthetic ciphertext/IV authenticate without decrypting any real content.
    ciphertext = bytes((index * 13 + 7) % 256 for index in range(4000))
    iv = bytes(range(16, 32))
    auth_key = hashlib.pbkdf2_hmac("sha512", key, bytes(byte ^ 58 for byte in salt), 2, 32)
    tag = hmac.digest(auth_key, ciphertext + iv + struct.pack("<I", 1), "sha512")
    return key, salt + ciphertext + iv + tag


class VerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key, cls.page = synthetic_page()
        cls.other_key, cls.other_page = synthetic_page(bytes(reversed(PASSPHRASE)))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="notewake-synthetic-verify-")
        self.root = Path(self.temp.name)
        self.databases = self.root / "synthetic-databases"
        self.databases.mkdir()
        self.candidate = self.root / "candidate.json"
        self.candidate.write_text(json.dumps({"passphrase": PASSPHRASE.hex()}))
        self.candidate.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def database(self, relative, data=None):
        path = self.databases / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.page if data is None else data)
        return path

    def report(self):
        return VERIFY.verify_database_dir(self.databases, PASSPHRASE)

    def cli(self, candidate=None, database_dir=None):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--database-dir", str(database_dir or self.databases),
             "--candidate-file", str(candidate or self.candidate)],
            capture_output=True, text=True, timeout=15, check=False,
        )

    def test_hmac_authenticates_salt_ciphertext_iv_and_tag(self):
        self.assertTrue(VERIFY.verify_enc_key(self.key, self.page))
        self.assertFalse(VERIFY.verify_enc_key(self.other_key, self.page))
        for position in (0, 15, 16, 4015, 4016, 4031, 4032, 4095):
            changed = bytearray(self.page)
            changed[position] ^= 1
            self.assertFalse(VERIFY.verify_enc_key(self.key, bytes(changed)), position)

    def test_exact_page_and_key_sizes_required(self):
        for data in (b"", self.page[:-1], self.page + b"extra", b"SQLite format 3\0" + self.page[16:]):
            self.assertFalse(VERIFY.verify_enc_key(self.key, data))
        for key in (b"", self.key[:-1], self.key + b"x"):
            self.assertFalse(VERIFY.verify_enc_key(key, self.page))

    def test_success_counts_all_core_names_and_ignores_wal_plaintext(self):
        for name in ("session/session.db", "contact/contact.db", "message/message_0.db", "other.db"):
            self.database(name)
        self.database("message/message_0.db-wal", b"not a database")
        self.database("plain.db", b"SQLite format 3\0" + bytes(4080))
        self.assertEqual(self.report(), {"success": True, "total": 4, "verified": 4, "coreTotal": 3, "coreVerified": 3})

    def test_wrong_passphrase_fails_core(self):
        self.database("session.db", self.other_page)
        self.assertEqual(self.report(), {"success": False, "total": 1, "verified": 0, "coreTotal": 1, "coreVerified": 0})

    def test_partial_core_success_is_not_success(self):
        self.database("session.db")
        self.database("contact.db", self.other_page)
        self.assertEqual(self.report(), {"success": False, "total": 2, "verified": 1, "coreTotal": 2, "coreVerified": 1})

    def test_non_core_failure_visible_but_not_required(self):
        self.database("session.db")
        self.database("other.db", self.other_page)
        self.assertEqual(self.report(), {"success": True, "total": 2, "verified": 1, "coreTotal": 1, "coreVerified": 1})

    def test_no_core_or_empty_directory_is_not_success(self):
        self.assertFalse(self.report()["success"])
        self.database("other.db")
        self.assertEqual(self.report(), {"success": False, "total": 1, "verified": 1, "coreTotal": 0, "coreVerified": 0})

    def test_truncated_encrypted_core_counts_as_failed(self):
        self.database("session.db")
        self.database("contact.db", self.page[:300])
        self.assertEqual(self.report(), {"success": False, "total": 2, "verified": 1, "coreTotal": 2, "coreVerified": 1})

    def test_reads_only_first_page_and_preserves_file(self):
        path = self.database("session.db", self.page + b"UNREAD_SYNTHETIC_TAIL" * 1000)
        before = path.read_bytes()
        original_read = os.read
        requests = []
        def tracked_read(fd, size):
            requests.append(size)
            return original_read(fd, size)
        with mock.patch.object(VERIFY.os, "read", side_effect=tracked_read):
            self.assertTrue(self.report()["success"])
        self.assertEqual(requests, [4096])
        self.assertEqual(path.read_bytes(), before)

    def test_reuses_derivation_for_same_salt(self):
        self.database("session.db")
        self.database("contact.db")
        with mock.patch.object(VERIFY.hashlib, "pbkdf2_hmac", wraps=hashlib.pbkdf2_hmac) as derive:
            self.assertTrue(self.report()["success"])
        self.assertEqual(sum(call.args[3] == 256000 for call in derive.call_args_list), 1)

    def test_candidate_requires_exact_32_bytes_and_json_schema(self):
        self.assertEqual(VERIFY.load_candidate(self.candidate), PASSPHRASE)
        for value in ([], {"passphrase": None}, {"passphrase": 1}, {"passphrase": "aa" * 31},
                      {"passphrase": "gg" * 32}, {"passphrase": "aa " * 32},
                      {"passphrase": "aa" * 32, "account": "private"}):
            self.candidate.write_text(json.dumps(value))
            with self.assertRaises(VERIFY.VerificationError):
                VERIFY.load_candidate(self.candidate)
        for raw in ('{"passphrase":"' + "aa" * 32 + '","passphrase":"' + "bb" * 32 + '"}',
                    "broken json", "x" * 4097):
            self.candidate.write_text(raw)
            with self.assertRaises(VERIFY.VerificationError):
                VERIFY.load_candidate(self.candidate)

    def test_candidate_rejects_permissions_symlink_and_fifo(self):
        for mode in (0o644, 0o400, 0o660):
            self.candidate.chmod(mode)
            with self.assertRaises(VERIFY.VerificationError):
                VERIFY.load_candidate(self.candidate)
        self.candidate.chmod(0o600)
        link = self.root / "candidate-link"
        link.symlink_to(self.candidate)
        with self.assertRaises(VERIFY.VerificationError):
            VERIFY.load_candidate(link)
        fifo = self.root / "candidate-fifo"
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(VERIFY.VerificationError):
            VERIFY.load_candidate(fifo)

    def test_does_not_follow_database_links(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "session.db").write_bytes(self.page)
        (self.databases / "linked-directory").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.report()["total"], 0)
        (self.databases / "session.db").symlink_to(outside / "session.db")
        with self.assertRaises(VERIFY.VerificationError):
            self.report()
        with self.assertRaises(VERIFY.VerificationError):
            VERIFY.verify_database_dir(self.databases / "linked-directory", PASSPHRASE)

    def test_cli_outputs_only_aggregates_on_success(self):
        self.database("private-account/session.db")
        result = self.cli()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {"success": True, "total": 1, "verified": 1, "coreTotal": 1, "coreVerified": 1})
        for secret in (PASSPHRASE.hex(), self.key.hex(), SALT.hex(), "private-account", str(self.root)):
            self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertEqual(stat.S_IMODE(self.candidate.stat().st_mode), 0o600)

    def test_cli_mismatch_and_io_errors_fail_closed_without_paths(self):
        self.database("session.db", self.other_page)
        result = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["success"])
        self.assertEqual(result.stderr, "")
        for result in (self.cli(candidate=self.root / "private-account-missing"),
                       self.cli(database_dir=self.root / "private-account-missing")):
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {"success": False, "total": 0, "verified": 0, "coreTotal": 0, "coreVerified": 0})
            self.assertNotIn("private-account", result.stderr)
            self.assertNotIn(str(self.root), result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
