package ranges

import (
	"strconv"
	"strings"
)

// ParseRanges parses "1-3,5" into [1 2 3 5].
func ParseRanges(input string) ([]int, error) {
	var out []int
	for _, part := range strings.Split(input, ",") {
		bounds := strings.Split(part, "-")
		lo, _ := strconv.Atoi(bounds[0])
		hi, _ := strconv.Atoi(bounds[1])
		for i := lo; i <= hi; i++ {
			out = append(out, i)
		}
	}
	return out, nil
}
