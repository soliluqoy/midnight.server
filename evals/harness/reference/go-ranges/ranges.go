package ranges

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ParseRanges parses "1-3,5" into [1 2 3 5]: sorted, without duplicates.
// Spaces around numbers are allowed. Empty parts, non-numbers and reversed ranges are errors.
func ParseRanges(input string) ([]int, error) {
	seen := map[int]bool{}
	for _, part := range strings.Split(input, ",") {
		bounds := strings.Split(part, "-")
		if len(bounds) > 2 {
			return nil, fmt.Errorf("invalid range %q", part)
		}
		lo, err := strconv.Atoi(strings.TrimSpace(bounds[0]))
		if err != nil {
			return nil, fmt.Errorf("invalid range %q", part)
		}
		hi := lo
		if len(bounds) == 2 {
			hi, err = strconv.Atoi(strings.TrimSpace(bounds[1]))
			if err != nil {
				return nil, fmt.Errorf("invalid range %q", part)
			}
		}
		if hi < lo {
			return nil, fmt.Errorf("reversed range %q", part)
		}
		for i := lo; i <= hi; i++ {
			seen[i] = true
		}
	}
	out := make([]int, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Ints(out)
	return out, nil
}
