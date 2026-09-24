# midnight.server

A planned standalone Windows coding harness built by modifying Pi, with MiniCPM5-2B Q8_0 as a bundled local helper model.

**Status: research and implementation planning. No application binary is available yet.**

Read the [complete implementation plan](IMPLEMENTATION_PLAN.md) for the architecture, source changes, Windows build toolchain, model packaging, implementation phases, evaluation gates, and research sources.

The proposed default inference engine is a bundled build of llama.cpp. SGLang is a benchmark candidate for optional GPU serving; it has Q8_0 support in source, but its suitability and performance for this exact model still need testing.

Upstream inputs: [Pi fork](https://github.com/soliluqoy/pi), [MiniCPM fork](https://github.com/soliluqoy/MiniCPM), and [llama.cpp](https://github.com/ggml-org/llama.cpp).
