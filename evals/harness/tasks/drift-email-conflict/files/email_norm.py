def normalize_email(address):
    """Lowercase the domain part of an email address."""
    local, _, domain = address.partition("@")
    return f"{local}@{domain.lower()}"
