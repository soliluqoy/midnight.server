from datetime import date, timedelta


def business_days(start: date, end: date) -> int:
    """Number of weekdays (Monday-Friday) in the half-open range [start, end)."""
    days = (end - start).days
    weeks, rest = divmod(days, 7)
    return weeks * 5 + min(rest, 5)
