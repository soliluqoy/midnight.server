from email_norm import normalize_email

assert normalize_email("bob@Example.COM") == "bob@example.com"
assert normalize_email("Bob@Example.com") == "Bob@example.com"
print("ok")
