from __future__ import annotations


def _require_non_negative_int(name: str, value: int) -> None:
    if not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if value < 0:
        raise ValueError(f"{name} must be non-negative")


def fibonacci(n: int) -> list[int]:
    """Return the first n Fibonacci numbers, starting from 0."""
    _require_non_negative_int("n", n)
    seq: list[int] = []
    a, b = 0, 1
    for _ in range(n):
        seq.append(a)
        a, b = b, a + b
    return seq


def factorial(n: int) -> int:
    """Return n!."""
    _require_non_negative_int("n", n)
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


def is_prime(n: int) -> bool:
    """Return whether n is prime."""
    if not isinstance(n, int):
        raise TypeError("n must be an integer")
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False
    factor = 3
    while factor * factor <= n:
        if n % factor == 0:
            return False
        factor += 2
    return True


def primes_up_to(limit: int) -> list[int]:
    """Return all primes <= limit."""
    _require_non_negative_int("limit", limit)
    return [n for n in range(2, limit + 1) if is_prime(n)]


def quick_sort(values: list[int]) -> list[int]:
    """Return a sorted copy of values."""
    if len(values) <= 1:
        return values[:]
    pivot = values[len(values) // 2]
    left = [x for x in values if x < pivot]
    middle = [x for x in values if x == pivot]
    right = [x for x in values if x > pivot]
    return quick_sort(left) + middle + quick_sort(right)


def binary_search(values: list[int], target: int) -> int:
    """Return index of target in sorted values, or -1."""
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] == target:
            return mid
        if values[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1


def combination(n: int, k: int) -> int:
    """Return C(n, k)."""
    _require_non_negative_int("n", n)
    _require_non_negative_int("k", k)
    if k > n:
        return 0
    k = min(k, n - k)
    result = 1
    for i in range(1, k + 1):
        result = result * (n - k + i) // i
    return result


if __name__ == "__main__":
    print("fibonacci(20)=", fibonacci(20))
