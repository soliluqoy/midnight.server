package trim

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sync"
)

// model.bin holds the gradient-boosted trees trained with
// LightGBM. Layout, little endian: "KEEP", version
// uint32 (1), features, trees, nodes, leaves (uint32 each); then each feature
// name as uint16 length + bytes; tree roots []int32; node feature []int32,
// threshold []float64, left []int32, right []int32; leaf values []float64.
// A child or root below zero is the leaf ^index. A node sends a row left when
// float64(row[feature]) <= threshold, as LightGBM does with no missing values.
//
//go:embed model.bin
var modelBytes []byte

type forest struct {
	roots []int32
	nodes []node
	leaf  []float64
}

// node is one split. threshold is the largest float32 not above the
// model's float64 threshold, so row[feature] <= threshold decides exactly as
// float64(row[feature]) <= the float64 threshold does.
type node struct {
	threshold   float32
	feature     int32
	left, right int32
}

var (
	loadOnce  sync.Once
	loaded    *forest
	loadError error
)

func model() (*forest, error) {
	loadOnce.Do(func() { loaded, loadError = parseModel(modelBytes) })
	return loaded, loadError
}

func parseModel(b []byte) (*forest, error) {
	r := bytes.NewReader(b)
	var head struct {
		Magic                                   [4]byte
		Version, Features, Trees, Nodes, Leaves uint32
	}
	if err := binary.Read(r, binary.LittleEndian, &head); err != nil {
		return nil, fmt.Errorf("trim model header: %w", err)
	}
	if string(head.Magic[:]) != "KEEP" || head.Version != 1 {
		return nil, errors.New("trim model: bad magic or version")
	}
	if int(head.Features) != nFeatures || head.Trees == 0 || head.Nodes > 1<<24 || head.Leaves > 1<<24 {
		return nil, fmt.Errorf("trim model: %d features, %d trees, %d nodes, %d leaves (package computes %d features)",
			head.Features, head.Trees, head.Nodes, head.Leaves, nFeatures)
	}
	// Check the size the header implies before allocating anything it sizes.
	size := 24 + 4*uint64(head.Trees) + 20*uint64(head.Nodes) + 8*uint64(head.Leaves)
	for _, name := range FeatureNames {
		size += 2 + uint64(len(name))
	}
	if size != uint64(len(b)) {
		return nil, fmt.Errorf("trim model: header implies %d bytes, model has %d", size, len(b))
	}
	for i := range nFeatures {
		var n uint16
		if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
			return nil, fmt.Errorf("trim model feature names: %w", err)
		}
		name := make([]byte, n)
		if _, err := r.Read(name); err != nil || string(name) != FeatureNames[i] {
			return nil, fmt.Errorf("trim model feature %d is %q, package has %q", i, name, FeatureNames[i])
		}
	}
	roots := make([]int32, head.Trees)
	feature := make([]int32, head.Nodes)
	threshold := make([]float64, head.Nodes)
	left := make([]int32, head.Nodes)
	right := make([]int32, head.Nodes)
	leaf := make([]float64, head.Leaves)
	for _, part := range []any{roots, feature, threshold, left, right, leaf} {
		if err := binary.Read(r, binary.LittleEndian, part); err != nil {
			return nil, fmt.Errorf("trim model body: %w", err)
		}
	}
	if r.Len() != 0 {
		return nil, fmt.Errorf("trim model: %d trailing bytes", r.Len())
	}
	nodes, leaves := int32(head.Nodes), int32(head.Leaves)
	valid := func(c int32) bool { return c >= 0 && c < nodes || c < 0 && ^c < leaves }
	for _, c := range roots {
		if !valid(c) {
			return nil, errors.New("trim model: root out of range")
		}
	}
	m := &forest{roots: roots, nodes: make([]node, head.Nodes), leaf: leaf}
	for i := range feature {
		// Children point forward, so a walk always ends at a leaf.
		if feature[i] < 0 || int(feature[i]) >= nFeatures || !valid(left[i]) || !valid(right[i]) ||
			left[i] >= 0 && left[i] <= int32(i) || right[i] >= 0 && right[i] <= int32(i) ||
			math.IsNaN(threshold[i]) {
			return nil, fmt.Errorf("trim model: node %d out of range", i)
		}
		t := float32(threshold[i])
		if float64(t) > threshold[i] {
			t = math.Nextafter32(t, float32(math.Inf(-1)))
		}
		m.nodes[i] = node{threshold: t, feature: feature[i], left: left[i], right: right[i]}
	}
	return m, nil
}

// raw is the sum of the trees' leaf values for one row, trees in order.
func (m *forest) raw(row []float32) float64 {
	sum := 0.0
	for _, i := range m.roots {
		for i >= 0 {
			nd := &m.nodes[i]
			if row[nd.feature] <= nd.threshold {
				i = nd.left
			} else {
				i = nd.right
			}
		}
		sum += m.leaf[^i]
	}
	return sum
}

// Probability is the model's keep probability for one feature row.
func (m *forest) probability(row []float32) float64 {
	return 1 / (1 + exp(-m.raw(row)))
}

// exp and expmulti are math.Exp's portable code from Go's src/math/exp.go.
// math.Exp runs assembly on amd64 and arm64 and this code on wasm, and the
// results differ in the last bit; float64() around each product stops the
// compiler fusing a multiply-add, so every architecture rounds alike.
//
// Copyright 2009 The Go Authors. All rights reserved. Use of this source code
// is governed by a BSD-style license that can be found in the LICENSE-go file.
// From FreeBSD's e_exp.c: Copyright (C) 2004 by Sun Microsystems, Inc. All
// rights reserved. Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice is preserved.
func exp(x float64) float64 {
	const (
		Ln2Hi = 6.93147180369123816490e-01
		Ln2Lo = 1.90821492927058770002e-10
		Log2e = 1.44269504088896338700e+00

		Overflow  = 7.09782712893383973096e+02
		Underflow = -7.45133219101941108420e+02
		NearZero  = 1.0 / (1 << 28) // 2**-28
	)

	// special cases
	switch {
	case math.IsNaN(x):
		return x
	case x > Overflow: // handles case where x is +∞
		return math.Inf(1)
	case x < Underflow: // handles case where x is -∞
		return 0
	case -NearZero < x && x < NearZero:
		return 1 + x
	}

	// reduce; computed as r = hi - lo for extra precision.
	var k int
	switch {
	case x < 0:
		k = int(float64(Log2e*x) - 0.5)
	case x > 0:
		k = int(float64(Log2e*x) + 0.5)
	}
	hi := x - float64(float64(k)*Ln2Hi)
	lo := float64(k) * Ln2Lo

	// compute
	return expmulti(hi, lo, k)
}

// expmulti returns e**r × 2**k where r = hi - lo and |r| ≤ ln(2)/2.
func expmulti(hi, lo float64, k int) float64 {
	const (
		P1 = 1.66666666666666657415e-01  /* 0x3FC55555; 0x55555555 */
		P2 = -2.77777777770155933842e-03 /* 0xBF66C16C; 0x16BEBD93 */
		P3 = 6.61375632143793436117e-05  /* 0x3F11566A; 0xAF25DE2C */
		P4 = -1.65339022054652515390e-06 /* 0xBEBBBD41; 0xC5D26BF1 */
		P5 = 4.13813679705723846039e-08  /* 0x3E663769; 0x72BEA4D0 */
	)

	r := hi - lo
	t := r * r
	c := r - float64(t*(P1+float64(t*(P2+float64(t*(P3+float64(t*(P4+float64(t*P5)))))))))
	y := 1 - ((lo - float64(r*c)/(2-c)) - hi)
	return math.Ldexp(y, k)
}

// ModelInfo describes the embedded model for logs and reports.
func ModelInfo() (string, error) {
	m, err := model()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d trees, %d nodes, %d features, %d bytes", len(m.roots), len(m.nodes), nFeatures, len(modelBytes)), nil
}
