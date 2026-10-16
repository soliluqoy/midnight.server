//go:build js && wasm

package main

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"syscall/js"

	trim "github.com/caveman-ai/trim-1"
)

var marker = regexp.MustCompile(`^… (\d+) lines? …$`)

func run(_ js.Value, args []js.Value) any {
	var request struct {
		Text  string `json:"text"`
		Query string `json:"query"`
		Mode  string `json:"mode"`
	}
	if len(args) != 1 || json.Unmarshal([]byte(args[0].String()), &request) != nil {
		return `{"error":"invalid request"}`
	}
	if len(request.Text) > 1<<20 || strings.Count(request.Text, "\n") >= 20000 || len(request.Query) > 8192 {
		return `{"error":"input limit"}`
	}
	var result any
	if request.Mode == "rank" {
		_, scores, err := trim.Score(request.Text, request.Query)
		if err != nil {
			return `{"error":"scoring unavailable"}`
		}
		result = map[string]any{"scores": scores}
	} else if request.Mode == "trim" {
		compressed := trim.Compress(request.Text, request.Query, trim.Options{Point: "balanced"})
		kept := []int{}
		if !compressed.Unchanged {
			index := 0
			for _, line := range strings.Split(strings.TrimSuffix(compressed.Output, "\n"), "\n") {
				if match := marker.FindStringSubmatch(line); match != nil {
					count, _ := strconv.Atoi(match[1])
					index += count
				} else {
					kept = append(kept, index)
					index++
				}
			}
		}
		result = map[string]any{"kept": kept, "unchanged": compressed.Unchanged}
	} else {
		return `{"error":"unknown mode"}`
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return `{"error":"encoding unavailable"}`
	}
	return string(encoded)
}

func main() {
	js.Global().Set("midnightTrim", js.FuncOf(run))
	select {}
}
