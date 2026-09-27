def parse_config(text):
    """Parse "key = value" lines into a dict of strings.

    Blank lines and lines starting with # or ; are ignored. Keys and values are stripped,
    matching quotes around a value are removed, the first "=" separates key from value,
    and a later duplicate key wins. A line without "=" raises ValueError.
    """
    result = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if "=" not in line:
            raise ValueError(f"line {number}: expected key = value")
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key.strip()] = value
    return result
