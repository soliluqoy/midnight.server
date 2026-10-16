

package trim

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const (

	maxContextBytes = 8 << 20

	maxContextLines = 200_000

	maxQueryBytes = 8 << 10
)

const MaxContextBytes = maxContextBytes

type Policy struct {

	Floor float64

	TopK int

	Context int

	Headers int

	Gap int

	MinChars int

	MinCut float64
}

var Points = map[string]Policy{
	"conservative": {Floor: 0.0035, TopK: 3, Context: 1, Headers: 1, Gap: 2, MinChars: 2000, MinCut: 0.1},
	"balanced":     {Floor: 0.008, TopK: 3, Context: 1, Headers: 1, Gap: 2, MinChars: 2000, MinCut: 0.1},
	"aggressive":   {Floor: 0.035, TopK: 3, Context: 1, Headers: 1, Gap: 2, MinChars: 2000, MinCut: 0.1},
}

const DefaultPoint = "balanced"

type Options struct {

	Point string

	Policy *Policy
}

type Result struct {

	Output string

	KeptLines, RemovedLines int

	Point  string
	Policy Policy

	Unchanged bool
	Reason    string
}

func Compress(context, query string, opts Options) Result {
	name, policy := opts.Point, Policy{}
	if opts.Policy != nil {
		name, policy = "custom", *opts.Policy
	} else {
		if name == "" {
			name = DefaultPoint
		}
		p, ok := Points[name]
		if !ok {
			return unchanged(context, name, policy, "unknown operating point")
		}
		policy = p
	}
	switch {
	case strings.TrimSpace(query) == "":
		return unchanged(context, name, policy, "no query")
	case len(context) < policy.MinChars:
		return unchanged(context, name, policy, "context below the minimum size")
	case len(context) > maxContextBytes:
		return unchanged(context, name, policy, "context over 8 MiB")
	case lineCount(context) > maxContextLines:
		return unchanged(context, name, policy, "context over 200,000 lines")
	case strings.Contains(context, "…") && markerLine.MatchString(context):
		return unchanged(context, name, policy, "context has a line that reads as an elision marker")
	}
	lines, scores, err := Score(context, query)
	if err != nil {
		return unchanged(context, name, policy, err.Error())
	}
	out, kept := policy.Apply(lines, scores)
	if float64(len(out)) > float64(len(context))*(1-policy.MinCut) {
		return unchanged(context, name, policy, "cut below the minimum")
	}
	return Result{Output: out, KeptLines: kept, RemovedLines: lineCount(context) - kept, Point: name, Policy: policy}
}

func Score(context, query string) ([]string, []float64, error) {
	m, err := model()
	if err != nil {
		return nil, nil, err
	}
	lines, rows := LineFeatures(context, query)
	scores := make([]float64, len(lines))
	for i, line := range lines {
		if strings.TrimSpace(line) != "" {
			scores[i] = m.probability(rows[i])
		}
	}
	return lines, scores, nil
}

func (p Policy) Apply(lines []string, scores []float64) (string, int) {
	final := len(lines) > 1 && lines[len(lines)-1] == ""
	if final {
		lines, scores = lines[:len(lines)-1], scores[:len(scores)-1]
	}
	blank := make([]bool, len(lines))
	indent := make([]int, len(lines))
	section := make([]int, len(lines))
	open := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		blank[i] = trimmed == ""
		indent[i] = indentOf(line)
		section[i] = open
		if hasAnyPrefix(trimmed, sectionPrefixes) || len(trimmed) < 120 && strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			open = i
		}
	}
	out, kept := render(lines, selectLines(scores, blank, indent, section, p))
	if final {
		out += "\n"
	}
	return out, kept
}

func unchanged(context, name string, policy Policy, reason string) Result {
	return Result{Output: context, KeptLines: lineCount(context), Point: name, Policy: policy, Unchanged: true, Reason: reason}
}

func lineCount(context string) int {
	return strings.Count(strings.TrimSuffix(context, "\n"), "\n") + 1
}

var markerLine = regexp.MustCompile(`(?m)^[ \t]*… \d+ lines? …[ \t\r]*$`)

func selectLines(score []float64, blank []bool, indent, section []int, p Policy) []bool {
	n := len(score)
	order := make([]int, 0, n)
	for i := range score {
		if !blank[i] {
			order = append(order, i)
		}
	}
	slices.SortStableFunc(order, func(a, b int) int {
		switch {
		case score[a] > score[b]:
			return -1
		case score[a] < score[b]:
			return 1
		}
		return 0
	})
	seed := make([]bool, n)
	for k, i := range order {
		seed[i] = k < p.TopK || score[i] >= p.Floor*score[order[0]]
	}

	keep := slices.Clone(seed)
	headers := blockHeaders(indent, blank)
	for i := range seed {
		if !seed[i] {
			continue
		}
		for j := max(0, i-p.Context); j <= min(n-1, i+p.Context); j++ {
			keep[j] = true
		}
		for h, k := headers[i], 0; h >= 0 && k < p.Headers; h, k = headers[h], k+1 {
			keep[h] = true
		}
		if p.Headers > 0 && section[i] >= 0 {
			keep[section[i]] = true
		}
	}

	last := -1
	for i := range keep {
		if !keep[i] {
			continue
		}
		if gap := blank[last+1 : i]; last >= 0 && len(gap) > 0 && (len(gap) <= p.Gap || allBlank(gap)) {
			for j := last + 1; j < i; j++ {
				keep[j] = true
			}
		}
		last = i
	}
	return keep
}

var sectionPrefixes = []string{"# ", "## ", "### ", "#### ", "[start of ", "==> ", "diff --git ", "File: "}

func allBlank(b []bool) bool {
	for _, x := range b {
		if !x {
			return false
		}
	}
	return true
}

func render(lines []string, keep []bool) (string, int) {
	var b strings.Builder
	kept := 0
	for i := 0; i < len(lines); {
		if i > 0 {
			b.WriteByte('\n')
		}
		if keep[i] {
			b.WriteString(lines[i])
			kept++
			i++
			continue
		}
		j := i
		for j < len(lines) && !keep[j] {
			j++
		}
		b.WriteString(marker(j - i))
		i = j
	}
	return b.String(), kept
}

func marker(n int) string {
	if n == 1 {
		return "… 1 line …"
	}
	return fmt.Sprintf("… %d lines …", n)
}
