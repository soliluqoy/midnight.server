def parse_config(text):
    """Parse "key = value" lines into a dict of strings."""
    result = {}
    for line in text.split("\n"):
        key, value = line.split("=")
        result[key] = value
    return result
