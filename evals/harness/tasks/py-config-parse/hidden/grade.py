from config import parse_config

text = """
# database settings
host = db.local
port=5432

; legacy comment style
name = "my app"
url = postgres://u:p@h/db?sslmode=require
empty =
host = db.prod
"""
assert parse_config(text) == {
    "host": "db.prod",
    "port": "5432",
    "name": "my app",
    "url": "postgres://u:p@h/db?sslmode=require",
    "empty": "",
}, parse_config(text)
assert parse_config("") == {}
assert parse_config("a = 'single quoted'") == {"a": "single quoted"}
assert parse_config("  spaced   =   value with spaces  ") == {"spaced": "value with spaces"}
try:
    parse_config("this line has no equals sign")
except ValueError:
    pass
else:
    raise AssertionError("a line without = must raise ValueError")
print("pass")
