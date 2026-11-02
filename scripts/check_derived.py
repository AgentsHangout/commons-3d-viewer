#!/usr/bin/env python3
"""Validate opt-in derived map fields and that the exporter keeps them opt-in.

Checks, all offline (never calls the live Agents Hangout API):

1. Every road in data/commons.json has road_mask, an integer 0..15
   (N=1, E=2, S=4, W=8; a tile off the map counts as no road).
2. Every place has door_side, present on the object, one of n, e, s, w, or null.
   null is legitimate on inner tiles of 2x2 parks and the square.
3. Re-running the exporter with --from FILE (no --derived) is byte-for-byte
   identical to the snapshot with derived keys stripped, and has no derived
   fields. Re-running with --from FILE --derived matches the committed snapshot.

door_side is an estimate from adjacent roads, not the game's ground truth.
"""
import json
import os
import subprocess
import sys
import tempfile
from copy import deepcopy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_PATH = os.path.join(ROOT, "data", "commons.json")
EXPORTER = os.path.join(ROOT, "exporter", "commons_export.py")

NOT_A_PLACE = frozenset({"road", "cleared"})
DOOR_SIDES = frozenset({"n", "e", "s", "w"})
DERIVED_KEYS = ("road_mask", "door_side")
MAX_ERRORS = 40


def rel(path):
    return os.path.relpath(path, ROOT)


def is_int(value):
    # bool is a subclass of int; reject true/false masquerading as 0/1
    return isinstance(value, int) and not isinstance(value, bool)


def loc(entry, index):
    return "built[%d] (x=%r, y=%r, kind=%r)" % (
        index,
        entry.get("x"),
        entry.get("y"),
        entry.get("kind"),
    )


def derived_keys_in(data):
    found = set()
    for entry in data.get("built") or []:
        if isinstance(entry, dict):
            found.update(k for k in DERIVED_KEYS if k in entry)
    return found


def strip_derived(data):
    stripped = deepcopy(data)
    for entry in stripped.get("built") or []:
        if isinstance(entry, dict):
            for key in DERIVED_KEYS:
                entry.pop(key, None)
    return stripped


def dump_compact(data, path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, separators=(",", ":"))


def first_byte_diff(left, right):
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            return index
    if len(left) != len(right):
        return limit
    return None


def validate_derived_fields(data, path):
    errors = []
    built = data.get("built")
    if not isinstance(built, list):
        return ["%s: built must be an array, got %s" % (path, type(built).__name__)]

    roads = places = 0
    for index, entry in enumerate(built):
        if not isinstance(entry, dict):
            errors.append(
                "%s %s: must be an object, got %s"
                % (path, "built[%d]" % index, type(entry).__name__)
            )
            continue
        kind = entry.get("kind")
        where = "%s %s" % (path, loc(entry, index))
        if kind == "road":
            roads += 1
            if "road_mask" not in entry:
                errors.append("%s: missing road_mask" % where)
            else:
                mask = entry["road_mask"]
                if not is_int(mask) or mask < 0 or mask > 15:
                    errors.append(
                        "%s: road_mask must be an integer 0..15 (N=1, E=2, S=4, W=8), got %r"
                        % (where, mask)
                    )
        elif kind not in NOT_A_PLACE:
            places += 1
            if "door_side" not in entry:
                errors.append("%s: missing door_side (field must be present on every place)" % where)
            else:
                side = entry["door_side"]
                if side is not None and side not in DOOR_SIDES:
                    errors.append(
                        "%s: door_side must be one of n, e, s, w, or null, got %r"
                        % (where, side)
                    )
    if not errors:
        print("%s: derived fields ok (%d roads, %d places)" % (path, roads, places))
    return errors


def run_exporter(source, dest, derived):
    cmd = [sys.executable, EXPORTER, "--from", source, "-o", dest]
    if derived:
        cmd.append("--derived")
    try:
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return "exporter timed out: %s" % " ".join(cmd), None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return "exporter failed (%d): %s%s" % (
            result.returncode,
            " ".join(cmd),
            ("\n" + detail) if detail else "",
        ), None
    return None, result


def check_exporter_opt_in(committed):
    """Re-derive from the committed snapshot with --from FILE; no live API."""
    errors = []
    if not os.path.isfile(EXPORTER):
        return ["%s does not exist; cannot check exporter --derived opt-in" % rel(EXPORTER)]

    expected_plain = strip_derived(committed)
    with tempfile.TemporaryDirectory(prefix="check-derived-") as tmp:
        plain_in = os.path.join(tmp, "plain.json")
        plain_out = os.path.join(tmp, "plain-out.json")
        derived_out = os.path.join(tmp, "derived-out.json")
        dump_compact(expected_plain, plain_in)

        err, _ = run_exporter(plain_in, plain_out, derived=False)
        if err:
            return [err]
        with open(plain_in, "rb") as handle:
            expected_plain_bytes = handle.read()
        with open(plain_out, "rb") as handle:
            actual_plain_bytes = handle.read()
        if actual_plain_bytes != expected_plain_bytes:
            offset = first_byte_diff(expected_plain_bytes, actual_plain_bytes)
            errors.append(
                "exporter without --derived is not byte-identical to the stripped snapshot "
                "(expected %d bytes, got %d, first difference at offset %s)"
                % (len(expected_plain_bytes), len(actual_plain_bytes), offset)
            )
        try:
            plain_data = json.loads(actual_plain_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors.append("exporter without --derived wrote invalid JSON: %s" % exc)
        else:
            leftover = derived_keys_in(plain_data)
            if leftover:
                errors.append(
                    "exporter without --derived must omit derived fields, found %s"
                    % ", ".join(sorted(leftover))
                )

        err, _ = run_exporter(plain_in, derived_out, derived=True)
        if err:
            errors.append(err)
        else:
            with open(MAP_PATH, "rb") as handle:
                committed_bytes = handle.read()
            with open(derived_out, "rb") as handle:
                actual_derived_bytes = handle.read()
            if actual_derived_bytes != committed_bytes:
                offset = first_byte_diff(committed_bytes, actual_derived_bytes)
                errors.append(
                    "exporter --from FILE --derived is not byte-identical to %s "
                    "(expected %d bytes, got %d, first difference at offset %s)"
                    % (rel(MAP_PATH), len(committed_bytes), len(actual_derived_bytes), offset)
                )

    if not errors:
        print(
            "exporter --from without --derived: byte-identical to stripped snapshot, no derived fields"
        )
        print("exporter --from --derived: byte-identical to %s" % rel(MAP_PATH))
    return errors


def main():
    map_rel = rel(MAP_PATH)
    if not os.path.isfile(MAP_PATH):
        print("%s does not exist" % map_rel, file=sys.stderr)
        return 1

    with open(MAP_PATH, encoding="utf-8") as handle:
        try:
            data = json.load(handle)
        except json.JSONDecodeError as exc:
            print("%s is not valid JSON: %s" % (map_rel, exc), file=sys.stderr)
            return 1

    if not isinstance(data, dict):
        print("%s must be a JSON object, got %s" % (map_rel, type(data).__name__), file=sys.stderr)
        return 1

    errors = []
    errors.extend(validate_derived_fields(data, map_rel))
    errors.extend(check_exporter_opt_in(data))
    if not errors:
        return 0

    print("%s failed derived-field checks:" % map_rel, file=sys.stderr)
    shown = errors[:MAX_ERRORS]
    for item in shown:
        print("  - %s" % item, file=sys.stderr)
    extra = len(errors) - len(shown)
    if extra:
        print("  - ... and %d more" % extra, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
