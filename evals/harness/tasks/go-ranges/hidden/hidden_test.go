package ranges

import (
	"reflect"
	"testing"
)

func TestHiddenValid(t *testing.T) {
	cases := map[string][]int{
		"1-3,5":         {1, 2, 3, 5},
		" 1 - 3 , 5 ":   {1, 2, 3, 5},
		"7":             {7},
		"5,1-2":         {1, 2, 5},
		"1-4,3-6,2":     {1, 2, 3, 4, 5, 6},
		"10-10":         {10},
		"0-2":           {0, 1, 2},
	}
	for input, want := range cases {
		got, err := ParseRanges(input)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v %v, want %v", input, got, err, want)
		}
	}
}

func TestHiddenInvalid(t *testing.T) {
	for _, input := range []string{"", "a", "1-", "-3", "5-1", "1,,2", "1-2-3", "x-2"} {
		if _, err := ParseRanges(input); err == nil {
			t.Errorf("%q: expected an error", input)
		}
	}
}
