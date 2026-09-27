# Third-party notices

midnight.server redistributes the following components. License texts are in `licenses/`.

| Component | Version / revision | License | Text |
| --- | --- | --- | --- |
| Pi (earendil-works/pi, via soliluqoy/pi fork) | fork base `36b60d2e8985899743c4cf5bd5f8929832a3f05d` | MIT | `licenses/pi-LICENSE.txt` |
| Bun runtime (embedded in `midnight.server.exe`) | 1.3.14 | MIT (Bun), with bundled components under their own licenses | https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md |
| pi-mcp-adapter and its npm dependencies (`extensions/node_modules`) | 2.37.0, pinned by `packaging/extensions/package-lock.json` | MIT (pi-mcp-adapter); dependencies under their own licenses | `LICENSE` in each package directory |
| npm dependencies bundled into `midnight.server.exe` | see `package-lock.json` at the source commit in `release-manifest.json` | various (MIT, ISC, BSD, Apache-2.0) | package metadata in the source archive |

midnight.server is not affiliated with or endorsed by the Pi authors.
