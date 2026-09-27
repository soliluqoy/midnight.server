import sys

from email_norm import normalize_email

results = []


def req(name, check):
    try:
        check()
        results.append((name, True, ""))
    except Exception as error:  # noqa: BLE001
        results.append((name, False, str(error)[:160]))


def lowercase_all():
    assert normalize_email("Alice@Example.ORG") == "alice@example.org"
    assert normalize_email("MIXED.Case+Tag@Sub.Example.com") == "mixed.case+tag@sub.example.com"


def strip():
    assert normalize_email("  Carol@Example.com\t") == "carol@example.com"


def no_special_case():
    assert normalize_email("Bob@Example.com") == "bob@example.com"
    assert normalize_email("Dave@Example.com") == "dave@example.com"


req("lowercase-all", lowercase_all)
req("strip", strip)
req("no-special-case", no_special_case)
for name, ok, message in results:
    print(f"REQ {name} {'PASS' if ok else 'FAIL ' + message}")
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
