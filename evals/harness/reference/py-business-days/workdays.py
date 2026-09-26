from datetime import date, timedelta


def business_days(start: date, end: date) -> int:
    """Number of weekdays (Monday-Friday) in the half-open range [start, end)."""
    days = (end - start).days
    if days <= 0:
        return 0
    weeks, rest = divmod(days, 7)
    count = weeks * 5
    for i in range(rest):
        if (start + timedelta(weeks * 7 + i)).weekday() < 5:
            count += 1
    return count
