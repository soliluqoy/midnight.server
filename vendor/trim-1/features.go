package trim

import (
	"math"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// FeatureNames lists the per-line features in the order LineFeatures writes
// them. The embedded model was trained on exactly this order; training and
// inference both call LineFeatures, so there is one code path.
var FeatureNames = []string{
	"bm25", "bm25_norm", "bm25_rank", "bm25_win_sum", "cover_win_sum", "bm25_tail_norm",
	"cover", "cover_idf", "cover_n", "cover_maxidf", "cover_rank", "cover_tail",
	"compound_hits", "compound_maxlen", "bigram_hits", "trigram_hits",
	"idf_mean", "idf_max", "uniq_frac",
	"k_error", "k_test", "k_path", "k_pathline", "k_heading", "k_diff", "k_section",
	"k_signature", "k_jsonkey", "k_separator", "k_frame", "k_kv", "k_bullet",
	"dup", "tmpl", "tmpl_first",
	"pos_rel", "pos_head", "pos_tail", "n_lines", "ctx_chars",
	"len_chars", "len_words", "alnum_frac", "upper_frac", "digit_frac",
	"indent", "indent_delta", "block_start", "header_dist", "header_bm25", "header_cover",
	"nb_bm25_max", "nb_bm25_mean", "nb_cover_max", "nb_compound_max", "prev_bm25", "next_bm25",
	"prev_blank", "next_blank",
	"q_words", "q_terms", "q_found", "ctx_bm25_max",
	"para_cover_max", "sec_cover", "prf_cover", "prf_compound",
}

// Feature indexes, in FeatureNames order.
const (
	fBm25 = iota
	fBm25Norm
	fBm25Rank
	fBm25WinSum
	fCoverWinSum
	fBm25TailNorm
	fCover
	fCoverIdf
	fCoverN
	fCoverMaxidf
	fCoverRank
	fCoverTail
	fCompoundHits
	fCompoundMaxlen
	fBigramHits
	fTrigramHits
	fIdfMean
	fIdfMax
	fUniqFrac
	fKError
	fKTest
	fKPath
	fKPathline
	fKHeading
	fKDiff
	fKSection
	fKSignature
	fKJsonkey
	fKSeparator
	fKFrame
	fKKv
	fKBullet
	fDup
	fTmpl
	fTmplFirst
	fPosRel
	fPosHead
	fPosTail
	fNLines
	fCtxChars
	fLenChars
	fLenWords
	fAlnumFrac
	fUpperFrac
	fDigitFrac
	fIndent
	fIndentDelta
	fBlockStart
	fHeaderDist
	fHeaderBm25
	fHeaderCover
	fNbBm25Max
	fNbBm25Mean
	fNbCoverMax
	fNbCompoundMax
	fPrevBm25
	fNextBm25
	fPrevBlank
	fNextBlank
	fQWords
	fQTerms
	fQFound
	fCtxBm25Max
	fParaCoverMax
	fSecCover
	fPrfCover
	fPrfCompound
	nFeatures
)

const (
	neighbourSpan = 3
	compoundSpan  = 5
	maxCompounds  = 64
)

// LineFeatures splits context at "\n" and returns its lines with one feature
// row per line, nFeatures wide. Only the query's last maxQueryBytes count.
// The result depends only on the inputs: map lookups never decide an order and
// every float sum runs in line order.
func LineFeatures(context, query string) ([]string, [][]float32) {
	if cut := len(query) - maxQueryBytes; cut > 0 {
		for cut < len(query) && !utf8.RuneStart(query[cut]) {
			cut++
		}
		query = query[cut:]
	}
	lines := strings.Split(context, "\n")
	n := len(lines)
	rows := make([][]float32, n)
	flat := make([]float32, n*nFeatures)
	for i := range rows {
		rows[i] = flat[i*nFeatures : (i+1)*nFeatures]
	}

	bm := bm25(query, lines)
	tail := queryTail(query)
	bmTail := bm
	if tail != strings.TrimSpace(query) {
		bmTail = bm25(tail, lines)
	}
	bmMax, tailMax := maxOf(bm), maxOf(bmTail)

	// Term index over the lines: each line's distinct terms (words plus their
	// camelCase, snake_case and digit parts) and how many lines hold each.
	ids := map[string]int32{}
	var df []int32
	lineTerms := make([][]int32, n)
	lineWords := make([][]string, n)
	for i, line := range lines {
		words, terms := tokenize(line)
		lineWords[i] = words
		set := make([]int32, 0, len(terms))
		for _, t := range terms {
			id, ok := ids[t]
			if !ok {
				id = int32(len(df))
				ids[t] = id
				df = append(df, 0)
			}
			set = append(set, id)
		}
		slices.Sort(set)
		set = slices.Compact(set)
		for _, id := range set {
			df[id]++
		}
		lineTerms[i] = set
	}
	idf := make([]float64, len(df))
	for id, d := range df {
		idf[id] = math.Log(1 + (float64(n)-float64(d)+0.5)/(float64(d)+0.5))
	}

	qWords, qTerms := tokenize(query)
	qTerms = dedupe(qTerms)
	inQuery := make([]bool, len(df))
	qIDFSum, found := 0.0, 0
	for _, t := range qTerms {
		if id, ok := ids[t]; ok {
			inQuery[id] = true
			qIDFSum += idf[id]
			found++
		}
	}
	_, tailTerms := tokenize(tail)
	inTail := make([]bool, len(df))
	tailIDFSum := 0.0
	for _, t := range dedupe(tailTerms) {
		if id, ok := ids[t]; ok {
			inTail[id] = true
			tailIDFSum += idf[id]
		}
	}
	bigrams, trigrams := ngrams(qWords)
	compounds := compoundTerms(query)

	blank := make([]bool, n)
	indent := make([]int, n)
	tmplKeys := make([]string, n)
	dupCount := map[string]int{}
	tmplCount := map[string]int{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		blank[i] = trimmed == ""
		indent[i] = indentOf(line)
		dupCount[trimmed]++
		tmplKeys[i] = template(trimmed)
		tmplCount[tmplKeys[i]]++
	}
	prevNB, nextNB := nonBlankNeighbours(blank)
	headers := blockHeaders(indent, blank)
	tmplSeen := map[string]bool{}
	cover := make([]float64, n)
	compound := make([]float64, n)

	for i, line := range lines {
		r := rows[i]
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		set := lineTerms[i]

		var cov, covIDF, covMax, idfSum, idfMax, uniq, tailIDF float64
		for _, id := range set {
			if inTail[id] {
				tailIDF += idf[id]
			}
			idfSum += idf[id]
			idfMax = max(idfMax, idf[id])
			if df[id] == 1 {
				uniq++
			}
			if inQuery[id] {
				cov++
				covIDF += idf[id]
				covMax = max(covMax, idf[id])
			}
		}
		var hits, longest float64
		for _, c := range compounds {
			if strings.Contains(lower, c) {
				hits++
				longest = max(longest, float64(len(c)))
			}
		}
		var bi, tri float64
		w := lineWords[i]
		for j := 0; j+1 < len(w); j++ {
			if bigrams[w[j]+" "+w[j+1]] {
				bi++
			}
			if j+2 < len(w) && trigrams[w[j]+" "+w[j+1]+" "+w[j+2]] {
				tri++
			}
		}
		cover[i] = ratio(covIDF, qIDFSum)
		compound[i] = hits

		r[fBm25] = f(bm[i])
		r[fBm25Norm] = f(ratio(bm[i], bmMax))
		r[fCoverTail] = f(ratio(tailIDF, tailIDFSum))
		r[fBm25TailNorm] = f(ratio(bmTail[i], tailMax))
		r[fCover] = f(ratio(cov, float64(found)))
		r[fCoverIdf] = f(cover[i])
		r[fCoverN] = f(cov)
		r[fCoverMaxidf] = f(covMax)
		r[fCompoundHits] = f(hits)
		r[fCompoundMaxlen] = f(math.Log1p(longest))
		r[fBigramHits] = f(bi)
		r[fTrigramHits] = f(tri)
		if len(set) > 0 {
			r[fIdfMean] = f(idfSum / float64(len(set)))
			r[fUniqFrac] = f(uniq / float64(len(set)))
		}
		r[fIdfMax] = f(idfMax)
		kinds := lineKinds(trimmed, lower)
		copy(r[fKError:fKBullet+1], kinds[:])
		r[fDup] = f(math.Log1p(float64(dupCount[trimmed] - 1)))
		r[fTmpl] = f(math.Log1p(float64(tmplCount[tmplKeys[i]] - 1)))
		if !tmplSeen[tmplKeys[i]] {
			tmplSeen[tmplKeys[i]] = true
			r[fTmplFirst] = 1
		}
		if n > 1 {
			r[fPosRel] = f(float64(i) / float64(n-1))
		}
		r[fPosHead] = f(math.Log1p(float64(i)))
		r[fPosTail] = f(math.Log1p(float64(n - 1 - i)))
		r[fNLines] = f(math.Log1p(float64(n)))
		r[fCtxChars] = f(math.Log1p(float64(len(context))))
		r[fLenChars] = f(math.Log1p(float64(len(line))))
		r[fLenWords] = f(math.Log1p(float64(len(strings.Fields(line)))))
		alnum, upper, digit, total := charMix(trimmed)
		if total > 0 {
			r[fAlnumFrac] = f(alnum / total)
			r[fUpperFrac] = f(upper / total)
			r[fDigitFrac] = f(digit / total)
		}
		r[fIndent] = f(math.Log1p(float64(indent[i])))
		if p := prevNB[i]; p >= 0 && !blank[i] {
			r[fIndentDelta] = f(float64(indent[i] - indent[p]))
		}
		if nx := nextNB[i]; nx >= 0 && !blank[i] && indent[nx] > indent[i] {
			r[fBlockStart] = 1
		}
		r[fQWords] = f(math.Log1p(float64(len(qWords))))
		r[fQTerms] = f(math.Log1p(float64(len(qTerms))))
		r[fQFound] = f(ratio(float64(found), float64(len(qTerms))))
		r[fCtxBm25Max] = f(bmMax)
	}

	// Paragraphs (runs of non-blank lines), the nearest earlier heading, and
	// feedback terms: rare terms of the three lines that cover the query best,
	// which name the next hop (an entity, a callee, a file) the query does not.
	paraMax := make([]float64, n)
	for i := 0; i < n; {
		j := i
		best := 0.0
		for j < n && !blank[j] {
			best = max(best, cover[j])
			j++
		}
		for k := i; k < j; k++ {
			paraMax[k] = best
		}
		i = max(j, i+1)
	}
	byCover := make([]int, n)
	for i := range byCover {
		byCover[i] = i
	}
	sort.SliceStable(byCover, func(a, b int) bool { return cover[byCover[a]] > cover[byCover[b]] })
	feedback := make([]bool, len(df))
	fbSum := 0.0
	for _, i := range byCover[:min(3, n)] {
		if cover[i] == 0 {
			break
		}
		for _, id := range lineTerms[i] {
			if !inQuery[id] && !feedback[id] && df[id] <= max(2, int32(n/50)) {
				feedback[id] = true
				fbSum += idf[id]
			}
		}
	}
	// Structured identifiers (paths, dotted names, ids like pg-cart-98) the
	// best lines name and the query does not: the next hop, verbatim.
	inCompounds := map[string]bool{}
	for _, c := range compounds {
		inCompounds[c] = true
	}
	var hops []string
	for _, i := range byCover[:min(3, n)] {
		if cover[i] == 0 {
			break
		}
		for _, c := range compoundTerms(lines[i]) {
			if !inCompounds[c] && len(hops) < maxCompounds {
				inCompounds[c] = true
				hops = append(hops, c)
			}
		}
	}
	heading := -1
	for i := range lines {
		r := rows[i]
		r[fParaCoverMax] = f(paraMax[i])
		if heading >= 0 {
			r[fSecCover] = f(cover[heading])
		}
		if rows[i][fKHeading] == 1 {
			heading = i
		}
		fb := 0.0
		for _, id := range lineTerms[i] {
			if feedback[id] {
				fb += idf[id]
			}
		}
		r[fPrfCover] = f(ratio(fb, fbSum))
		if len(hops) > 0 {
			lower := strings.ToLower(lines[i])
			hits := 0
			for _, c := range hops {
				if strings.Contains(lower, c) {
					hits++
				}
			}
			r[fPrfCompound] = f(float64(hits))
		}
	}

	bmRank := rankFrac(bm)
	covRank := rankFrac(cover)
	for i := range lines {
		r := rows[i]
		r[fBm25Rank] = f(bmRank[i])
		r[fCoverRank] = f(covRank[i])
		if h := headers[i]; h >= 0 {
			r[fHeaderDist] = f(math.Log1p(float64(i - h)))
			r[fHeaderBm25] = f(ratio(bm[h], bmMax))
			r[fHeaderCover] = f(cover[h])
		}
		var winBM, winCov float64
		for j := max(0, i-2); j <= min(n-1, i+2); j++ {
			winBM += ratio(bm[j], bmMax)
			winCov += cover[j]
		}
		r[fBm25WinSum] = f(winBM)
		r[fCoverWinSum] = f(winCov)
		var nbMax, nbSum, covNb, compNb float64
		cnt := 0
		for j := max(0, i-neighbourSpan); j <= min(n-1, i+neighbourSpan); j++ {
			if j == i {
				continue
			}
			v := ratio(bm[j], bmMax)
			nbMax = max(nbMax, v)
			nbSum += v
			covNb = max(covNb, cover[j])
			cnt++
		}
		for j := max(0, i-compoundSpan); j <= min(n-1, i+compoundSpan); j++ {
			if j != i {
				compNb = max(compNb, compound[j])
			}
		}
		r[fNbBm25Max] = f(nbMax)
		if cnt > 0 {
			r[fNbBm25Mean] = f(nbSum / float64(cnt))
		}
		r[fNbCoverMax] = f(covNb)
		r[fNbCompoundMax] = f(compNb)
		if i > 0 {
			r[fPrevBm25] = f(ratio(bm[i-1], bmMax))
			if blank[i-1] {
				r[fPrevBlank] = 1
			}
		}
		if i+1 < n {
			r[fNextBm25] = f(ratio(bm[i+1], bmMax))
			if blank[i+1] {
				r[fNextBlank] = 1
			}
		}
	}
	return lines, rows
}

func f(x float64) float32 { return float32(x) }

func ratio(a, b float64) float64 {
	if b <= 0 {
		return 0
	}
	return a / b
}

func maxOf(v []float64) float64 {
	m := 0.0
	for _, x := range v {
		m = max(m, x)
	}
	return m
}

// rankFrac gives each value the share of values strictly greater than it.
func rankFrac(v []float64) []float64 {
	order := make([]int, len(v))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return v[order[a]] > v[order[b]] })
	out := make([]float64, len(v))
	greater := 0
	for k, i := range order {
		if k > 0 && v[i] < v[order[k-1]] {
			greater = k
		}
		out[i] = float64(greater) / float64(max(1, len(v)))
	}
	return out
}

// queryTail is the query's last three non-empty lines: in an agent turn the
// intent and the tool call that the context answers.
func queryTail(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	var tail []string
	for i := len(lines) - 1; i >= 0 && len(tail) < 3; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			tail = append(tail, t)
		}
	}
	slices.Reverse(tail)
	return strings.Join(tail, "\n")
}

// stopwords matches the engine's BM25 stop list.
var stopwords = map[string]bool{
	"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
	"be": true, "by": true, "for": true, "from": true, "how": true, "in": true,
	"is": true, "it": true, "of": true, "on": true, "or": true, "that": true,
	"the": true, "this": true, "to": true, "was": true, "what": true, "when": true,
	"where": true, "which": true, "who": true, "why": true, "with": true,
}

// tokenize returns the lowercased words of s (runs of letters, digits and
// underscores, two or more characters, stop words dropped) in order, and the
// words together with their camelCase, snake_case and letter/digit parts.
func tokenize(s string) (words, terms []string) {
	start := -1
	flush := func(end int) {
		if start < 0 {
			return
		}
		raw := s[start:end]
		start = -1
		word := strings.ToLower(raw)
		if len(word) < 2 || stopwords[word] {
			return
		}
		words = append(words, word)
		terms = append(terms, word)
		if !mayHaveParts(raw) {
			return
		}
		if parts := splitIdent([]rune(raw)); len(parts) > 1 {
			for _, p := range parts {
				if len(p) >= 2 && !stopwords[p] {
					terms = append(terms, p)
				}
			}
		}
	}
	for i, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			if start < 0 {
				start = i
			}
		} else {
			flush(i)
		}
	}
	flush(len(s))
	return words, terms
}

// mayHaveParts is false only for words splitIdent leaves whole: all ASCII
// with no underscore, no capital and no letter/digit change.
func mayHaveParts(w string) bool {
	digits, others := false, false
	for i := 0; i < len(w); i++ {
		c := w[i]
		switch {
		case c >= 0x80 || c == '_' || c >= 'A' && c <= 'Z':
			return true
		case c >= '0' && c <= '9':
			digits = true
		default:
			others = true
		}
	}
	return digits && others
}

// splitIdent cuts an identifier at underscores, lower-to-upper case changes,
// the last capital of a capital run before a lowercase letter, and
// letter/digit changes, and lowercases the parts.
func splitIdent(w []rune) []string {
	var parts []string
	start := 0
	cut := func(end int) {
		if end > start {
			parts = append(parts, strings.ToLower(string(w[start:end])))
		}
		start = end
	}
	for i := 0; i < len(w); i++ {
		if w[i] == '_' {
			cut(i)
			start = i + 1
			continue
		}
		if i == start || i == 0 {
			continue
		}
		prev, r := w[i-1], w[i]
		switch {
		case unicode.IsLower(prev) && unicode.IsUpper(r):
			cut(i)
		case unicode.IsUpper(prev) && unicode.IsUpper(r) && i+1 < len(w) && unicode.IsLower(w[i+1]):
			cut(i)
		case unicode.IsDigit(prev) != unicode.IsDigit(r) && prev != '_':
			cut(i)
		}
	}
	cut(len(w))
	return parts
}

func dedupe(s []string) []string {
	seen := map[string]bool{}
	out := s[:0:0]
	for _, x := range s {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func ngrams(words []string) (bi, tri map[string]bool) {
	bi, tri = map[string]bool{}, map[string]bool{}
	for j := 0; j+1 < len(words); j++ {
		bi[words[j]+" "+words[j+1]] = true
		if j+2 < len(words) {
			tri[words[j]+" "+words[j+1]+" "+words[j+2]] = true
		}
	}
	return bi, tri
}

// compoundTerms returns the query's identifiers that carry structure (dotted
// names, paths, snake_case, camelCase, flags), lowercased, first 64 distinct.
func compoundTerms(query string) []string {
	fields := strings.FieldsFunc(query, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune("\"'`()[]{}<>,;=|", r)
	})
	var out []string
	seen := map[string]bool{}
	for _, fld := range fields {
		fld = strings.Trim(fld, ".:!?*#")
		if len(fld) < 4 || seen[fld] {
			continue
		}
		structured := strings.ContainsAny(fld, "._/:-\\")
		for i := 1; i < len(fld) && !structured; i++ {
			structured = fld[i-1] >= 'a' && fld[i-1] <= 'z' && fld[i] >= 'A' && fld[i] <= 'Z'
		}
		if !structured {
			continue
		}
		seen[fld] = true
		out = append(out, strings.ToLower(fld))
		if len(out) == maxCompounds {
			break
		}
	}
	return out
}

// template masks digit runs and long hex runs so repeated log lines that
// differ only in numbers, ids or timestamps share one key.
func template(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		if c >= '0' && c <= '9' {
			for i < len(s) && (isHex(s[i]) || s[i] == '.' || s[i] == ':') {
				i++
			}
			b.WriteByte('0')
			continue
		}
		if isHex(c) {
			j := i
			for j < len(s) && isHex(s[j]) {
				j++
			}
			if j-i >= 8 {
				b.WriteByte('0')
				i = j
				continue
			}
		}
		b.WriteByte(lowerASCII(c))
		i++
	}
	return b.String()
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

func indentOf(line string) int {
	n := 0
	for _, r := range line {
		switch r {
		case ' ':
			n++
		case '\t':
			n += 4
		default:
			return n
		}
	}
	return n
}

func nonBlankNeighbours(blank []bool) (prev, next []int) {
	prev, next = make([]int, len(blank)), make([]int, len(blank))
	last := -1
	for i := range blank {
		prev[i] = last
		if !blank[i] {
			last = i
		}
	}
	last = -1
	for i := len(blank) - 1; i >= 0; i-- {
		next[i] = last
		if !blank[i] {
			last = i
		}
	}
	return prev, next
}

// blockHeaders gives each non-blank line the nearest earlier non-blank line
// with a smaller indent (its enclosing block's header), or -1.
func blockHeaders(indent []int, blank []bool) []int {
	out := make([]int, len(indent))
	var stack []int
	for i := range indent {
		out[i] = -1
		if blank[i] {
			continue
		}
		for len(stack) > 0 && indent[stack[len(stack)-1]] >= indent[i] {
			stack = stack[:len(stack)-1]
		}
		if len(stack) > 0 {
			out[i] = stack[len(stack)-1]
		}
		stack = append(stack, i)
	}
	return out
}

func charMix(s string) (alnum, upper, digit, total float64) {
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		total++
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			alnum++
		}
		if unicode.IsUpper(r) {
			upper++
		}
		if unicode.IsDigit(r) {
			digit++
		}
	}
	return
}

var (
	errorWords   = []string{"error", "exception", "traceback", "fatal", "panic", "fail", "assert", "warning", "denied", "refused", "not found", "cannot", "unable to", "invalid", "segmentation", "undefined", "unexpected", "errno", "critical"}
	testWords    = []string{" passed", " failed", " skipped", "xfail", "test session", "test summary"}
	testPrefixes = []string{"ok ", "fail", "pass", "=== run", "--- pass", "--- fail", "ran "}
	sigWords     = []string{"def ", "async def ", "class ", "func ", "function ", "fn ", "pub ", "struct ", "interface ", "type ", "impl ", "public ", "private ", "protected ", "static ", "export ", "module ", "package ", "import ", "from ", "#include", "const ", "var ", "let ", "@"}
)

// lineKinds returns the k_* flags, fKError through fKBullet.
func lineKinds(trimmed, lower string) [fKBullet - fKError + 1]float32 {
	var k [fKBullet - fKError + 1]float32
	set := func(i int, ok bool) {
		if ok {
			k[i-fKError] = 1
		}
	}
	if trimmed == "" {
		return k
	}
	body := stripLineNumber(lower)
	set(fKError, containsAny(lower, errorWords))
	set(fKTest, containsAny(body, testWords) || hasAnyPrefix(body, testPrefixes))
	set(fKPath, hasPath(trimmed))
	set(fKPathline, hasPathLine(trimmed))
	set(fKHeading, strings.HasPrefix(body, "#") && strings.HasPrefix(strings.TrimLeft(body, "#"), " "))
	set(fKDiff, strings.HasPrefix(body, "diff --git") || strings.HasPrefix(body, "@@") ||
		strings.HasPrefix(body, "+++ ") || strings.HasPrefix(body, "--- a/") || strings.HasPrefix(body, "index "))
	set(fKSection, isSection(body, trimmed))
	set(fKSignature, hasAnyPrefix(body, sigWords))
	set(fKJsonkey, strings.HasPrefix(body, `"`) && strings.Contains(body, `":`))
	set(fKSeparator, len(body) >= 3 && strings.IndexFunc(body, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) < 0)
	set(fKFrame, strings.Contains(lower, `file "`) && strings.Contains(lower, ", line ") ||
		strings.HasPrefix(body, "at ") && strings.Contains(body, "(") || strings.HasPrefix(body, "goroutine "))
	set(fKKv, isKeyValue(body))
	set(fKBullet, hasAnyPrefix(body, []string{"- ", "* ", "• ", "+ "}) || numbered(body))
	return k
}

// stripLineNumber drops a leading "123 ", "123:" or "123|" line-number prefix
// as tools print it.
func stripLineNumber(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 || i == len(s) || !strings.ContainsRune(" \t:|", rune(s[i])) {
		return s
	}
	return strings.TrimSpace(s[i+1:])
}

func containsAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func hasPath(s string) bool {
	if !strings.ContainsAny(s, "/\\") {
		return false
	}
	for _, fld := range strings.Fields(s) {
		fld = strings.Trim(fld, "\"'`(),;:[]")
		slash := strings.LastIndexAny(fld, "/\\")
		if slash >= 0 && slash < len(fld)-1 && strings.Contains(fld[slash:], ".") && strings.IndexFunc(fld, unicode.IsLetter) >= 0 {
			return true
		}
	}
	return false
}

// hasPathLine finds "name.ext:123", the way compilers, tests and grep cite a
// line.
func hasPathLine(s string) bool {
	for i := 1; i+1 < len(s); i++ {
		if s[i] != ':' || s[i+1] < '0' || s[i+1] > '9' {
			continue
		}
		j := i
		for j > 0 && i-j < 6 && (s[j-1] >= 'a' && s[j-1] <= 'z' || s[j-1] >= 'A' && s[j-1] <= 'Z') {
			j--
		}
		if j < i && j >= 2 && s[j-1] == '.' && s[j-2] != '.' && s[j-2] != ' ' {
			return true
		}
	}
	return false
}

func isSection(body, trimmed string) bool {
	if strings.HasPrefix(body, "[") && strings.HasSuffix(body, "]") || strings.HasPrefix(body, "==>") || strings.HasPrefix(body, "file:") {
		return true
	}
	if len(body) < 80 && strings.HasSuffix(body, ":") && !strings.ContainsAny(body, "(){}=") {
		return true
	}
	letters, uppers := 0, 0
	for _, r := range trimmed {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				uppers++
			}
		}
	}
	return letters >= 4 && letters == uppers && len(trimmed) < 60
}

func isKeyValue(body string) bool {
	i := 0
	for i < len(body) && (body[i] == '_' || body[i] == '.' || body[i] == '-' || body[i] >= 'a' && body[i] <= 'z' || body[i] >= '0' && body[i] <= '9') {
		i++
	}
	if i == 0 {
		return false
	}
	for i < len(body) && body[i] == ' ' {
		i++
	}
	return i+1 < len(body) && (body[i] == ':' || body[i] == '=') && body[i+1] != '='
}

func numbered(body string) bool {
	i := 0
	for i < len(body) && body[i] >= '0' && body[i] <= '9' {
		i++
	}
	return i > 0 && i+1 < len(body) && (body[i] == '.' || body[i] == ')') && body[i+1] == ' '
}
