#!/usr/bin/env python3
"""Read-only verification of one in-memory passphrase against SQLCipher 4 pages.

The PBKDF2/page-one HMAC algorithm is adapted from wcdb-key-tool, MIT licensed:
https://github.com/TANGandXUE/wcdb-key-tool/blob/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa/wcdb_key_tool_macos.py
See THIRD_PARTY_NOTICES/WcdbKeyTool/LICENSE and NOTICE.

This module never attaches to a process, decrypts messages, writes keys, or
loads user configuration. Importing it has no side effects. CLI output contains
only aggregate counts; neither exception messages nor paths are printed.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import stat
import struct
import sys

PAGE_SIZE = 4096
KEY_SIZE = 32
SALT_SIZE = 16
SQLITE_HEADER = b"SQLite format 3\x00"
MAX_CANDIDATE_BYTES = 4096
CORE_DATABASE = re.compile(r"^(?:session|contact|message_.+)\.db$", re.IGNORECASE)


class VerificationError(Exception):
    """A fixed, non-sensitive error code suitable for CLI output."""


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("INVALID_CANDIDATE")
        result[key] = value
    return result


def load_candidate(candidate_file: str | os.PathLike) -> bytes:
    """Read {\"passphrase\": \"64 hexadecimal characters\"} from a 0600 file.

    O_NOFOLLOW and O_NONBLOCK reject symlinks and avoid waiting on a FIFO.
    Validate the opened descriptor, not a separate stat that can race open().
    """
    fd = None
    try:
        fd = os.open(candidate_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise VerificationError("CANDIDATE_REQUIRES_REGULAR_0600_FILE")
        if metadata.st_size > MAX_CANDIDATE_BYTES:
            raise VerificationError("INVALID_CANDIDATE")
        raw = os.read(fd, MAX_CANDIDATE_BYTES + 1)
        if len(raw) > MAX_CANDIDATE_BYTES:
            raise VerificationError("INVALID_CANDIDATE")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(value, dict) or set(value) != {"passphrase"}:
            raise VerificationError("INVALID_CANDIDATE")
        encoded = value["passphrase"]
        if not isinstance(encoded, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", encoded):
            raise VerificationError("INVALID_CANDIDATE")
        return bytes.fromhex(encoded)
    except VerificationError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError):
        raise VerificationError("CANDIDATE_UNREADABLE_OR_INVALID") from None
    finally:
        if fd is not None:
            os.close(fd)


def verify_enc_key(enc_key: bytes, page: bytes) -> bool:
    """Authenticate exactly one complete 4096-byte SQLCipher 4 first page.

    Fixed compatibility: 16-byte salt, SHA-512, 80 reserved bytes and a
    little-endian page number. A negative result is not a claim that other
    SQLCipher settings or versions would also fail.
    """
    if len(enc_key) != KEY_SIZE or len(page) != PAGE_SIZE or page.startswith(SQLITE_HEADER):
        return False
    mac_salt = bytes(value ^ 0x3A for value in page[:SALT_SIZE])
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SIZE)
    expected = hmac.new(mac_key, page[SALT_SIZE:PAGE_SIZE - 64] + struct.pack("<I", 1), hashlib.sha512).digest()
    return hmac.compare_digest(expected, page[PAGE_SIZE - 64:])


def _empty_report() -> dict[str, bool | int]:
    return {"success": False, "total": 0, "verified": 0, "coreTotal": 0, "coreVerified": 0}


def verify_database_dir(database_dir: str | os.PathLike, passphrase: bytes) -> dict[str, bool | int]:
    """Read only the first page of .db files below the explicit directory.

    Plaintext SQLite files are excluded. Truncated encrypted .db files count
    as failed candidates. Symbolic links are never followed. Unreadable files
    and traversal errors fail closed rather than silently inflating success.
    Success requires at least one core database and every discovered core
    database to verify. Non-core verification remains visible in the totals.
    No result includes filenames, salts, keys, account names, or page contents.
    """
    if not isinstance(passphrase, bytes) or len(passphrase) != KEY_SIZE:
        raise VerificationError("INVALID_CANDIDATE")
    report = _empty_report()
    derived: dict[bytes, bytes] = {}
    root_fd = None

    def walk_error(_error: OSError) -> None:
        raise VerificationError("DATABASE_DIRECTORY_UNREADABLE")

    try:
        root_fd = os.open(database_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for _root, dirs, files, directory_fd in os.fwalk(".", dir_fd=root_fd, follow_symlinks=False, onerror=walk_error):
            dirs.sort()
            for filename in sorted(files):
                if not filename.lower().endswith(".db"):
                    continue
                fd = None
                try:
                    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        raise VerificationError("DATABASE_REQUIRES_REGULAR_FILE")
                    page = os.read(fd, PAGE_SIZE)
                finally:
                    if fd is not None:
                        os.close(fd)
                if page.startswith(SQLITE_HEADER):
                    continue
                core = bool(CORE_DATABASE.fullmatch(filename))
                report["total"] += 1
                report["coreTotal"] += int(core)
                if len(page) != PAGE_SIZE:
                    continue
                salt = page[:SALT_SIZE]
                if salt not in derived:
                    derived[salt] = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=KEY_SIZE)
                if verify_enc_key(derived[salt], page):
                    report["verified"] += 1
                    report["coreVerified"] += int(core)
        report["success"] = report["coreTotal"] > 0 and report["coreVerified"] == report["coreTotal"]
        return report
    except VerificationError:
        raise
    except OSError:
        raise VerificationError("DATABASE_UNREADABLE") from None
    finally:
        derived.clear()
        if root_fd is not None:
            os.close(root_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only SQLCipher 4 first-page verification; aggregate results only.")
    parser.add_argument("--database-dir", required=True)
    parser.add_argument("--candidate-file", required=True)
    args = parser.parse_args(argv)
    try:
        report = verify_database_dir(args.database_dir, load_candidate(args.candidate_file))
    except VerificationError as error:
        print(json.dumps(_empty_report(), separators=(",", ":")))
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        # Do not expose paths or native exception text through a debug traceback.
        print(json.dumps(_empty_report(), separators=(",", ":")))
        print("VERIFICATION_FAILED", file=sys.stderr)
        return 2
    print(json.dumps(report, separators=(",", ":")))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
