from datetime import date
from workdays import business_days

assert business_days(date(2024, 1, 1), date(2024, 1, 8)) == 5
print("ok")
