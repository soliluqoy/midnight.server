package ranges

import (
	"reflect"
	"testing"
)

func TestBasic(t *testing.T) {
	got, err := ParseRanges("1-3,5-5")
	if err != nil || !reflect.DeepEqual(got, []int{1, 2, 3, 5}) {
		t.Fatalf("got %v %v", got, err)
	}
}
