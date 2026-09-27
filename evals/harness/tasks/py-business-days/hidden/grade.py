from datetime import date, timedelta
from workdays import business_days


def brute(start, end):
    return sum(1 for i in range((end - start).days) if (start + timedelta(i)).weekday() < 5)


base = date(2024, 2, 20)
for offset in range(0, 21):
    for length in range(0, 40):
        start = base + timedelta(offset)
        end = start + timedelta(length)
        assert business_days(start, end) == brute(start, end), (start, end)
assert business_days(date(2024, 1, 10), date(2024, 1, 5)) == 0
print("pass")
