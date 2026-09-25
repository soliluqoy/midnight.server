# Third-party notices

midnight.server redistributes the following components. License texts are in `licenses/`.

| Component | Version / revision | License | Text |
| --- | --- | --- | --- |
| Pi (earendil-works/pi, via soliluqoy/pi fork) | fork base `36b60d2e8985899743c4cf5bd5f8929832a3f05d` | MIT | `licenses/pi-LICENSE.txt` |
| llama.cpp / ggml (`llama-server` and libraries in `engine/cpu`) | release `b11166`, commit `a72e04abe0fe9b36e203033ac71bd5f379c35bc5` | MIT | `licenses/llama.cpp-LICENSE.txt` |
| LLVM OpenMP runtime (`engine/cpu/libomp.dll`) | shipped in the llama.cpp `b11166` Windows CPU release | Apache-2.0 WITH LLVM-exception | `licenses/LLVM-OpenMP-LICENSE.txt` |
| MiniCPM5-2B Q8_0 GGUF (`models/MiniCPM5-2B-Q8_0.gguf`, offline bundle only) | `openbmb/MiniCPM5-2B-GGUF` @ `2079a22f3beaa4e306449978533478fe0522f4b3` | Apache-2.0 (declared on the model card; the repository has no license file) | `licenses/MiniCPM5-2B-Apache-2.0.txt` |
| Bun runtime (embedded in `midnight.server.exe`) | 1.3.14 | MIT (Bun), with bundled components under their own licenses | https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md |
| pi-mcp-adapter and its npm dependencies (`extensions/node_modules`) | 2.37.0, pinned by `packaging/extensions/package-lock.json` | MIT (pi-mcp-adapter); dependencies under their own licenses | `LICENSE` in each package directory |
| npm dependencies bundled into `midnight.server.exe` | see `package-lock.json` at the source commit in `release-manifest.json` | various (MIT, ISC, BSD, Apache-2.0) | package metadata in the source archive |

MiniCPM5-2B was developed by OpenBMB. The model card is at https://huggingface.co/openbmb/MiniCPM5-2B. midnight.server is not affiliated with or endorsed by OpenBMB, the ggml authors, or the Pi authors.

`midnight-host.exe` is built from `native/midnight-host/Program.cs` in this repository.
