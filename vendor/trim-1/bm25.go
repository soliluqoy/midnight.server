package trim

import (
	"maps"
	"math"
	"slices"
	"strings"
	"unicode"
)

const (
	bm25K1 = 1.5
	bm25B  = 0.75
)

// bm25 scores each doc against the query. The scores are unnormalized and
// comparable only within the slice. The model was trained on exactly this
// implementation, so its tokenization, stopwords and term order are fixed.
func bm25(query string, docs []string) []float64 {
	queryTerms := bm25TermFreq(query)
	out := make([]float64, len(docs))
	if len(queryTerms) == 0 || len(docs) == 0 {
		return out
	}
	tfs := make([]map[string]int, len(docs))
	docLen := make([]int, len(docs))
	df := map[string]int{}
	totalLen := 0
	for i, doc := range docs {
		tf := bm25TermFreq(doc)
		tfs[i] = tf
		for _, count := range tf {
			docLen[i] += count
		}
		totalLen += docLen[i]
		for term := range tf {
			df[term]++
		}
	}
	avgdl := 1.0
	if totalLen > 0 {
		avgdl = float64(totalLen) / float64(len(docs))
	}
	// A fixed term order: float addition is not associative, and callers break
	// score ties with exact equality, so map order must not move a score.
	terms := slices.Sorted(maps.Keys(queryTerms))
	for i := range docs {
		for _, term := range terms {
			tf := float64(tfs[i][term])
			if tf == 0 {
				continue
			}
			idf := math.Log(1 + (float64(len(docs))-float64(df[term])+0.5)/(float64(df[term])+0.5))
			denom := tf + bm25K1*(1-bm25B+bm25B*float64(docLen[i])/avgdl)
			out[i] += idf * (tf * (bm25K1 + 1)) / denom
		}
	}
	return out
}

func bm25TermFreq(text string) map[string]int {
	freq := map[string]int{}
	var current strings.Builder
	flush := func() {
		tok := current.String()
		if len(tok) >= 2 && !bm25Stopwords[tok] {
			freq[tok]++
		}
		current.Reset()
	}
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			current.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return freq
}

var bm25Stopwords = map[string]bool{
	"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
	"be": true, "by": true, "for": true, "from": true, "how": true, "in": true,
	"is": true, "it": true, "of": true, "on": true, "or": true, "that": true,
	"the": true, "this": true, "to": true, "was": true, "what": true, "when": true,
	"where": true, "which": true, "who": true, "why": true, "with": true,
}
