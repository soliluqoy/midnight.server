from config import parse_config

assert parse_config("a=1") == {"a": "1"}
print("ok")
