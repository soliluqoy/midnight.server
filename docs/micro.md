# Bundled Micro editor

The six executables in `vendor/micro/` are unmodified upstream Micro v2.0.15 release binaries from
https://github.com/zyedidia/micro/releases/tag/v2.0.15. Midnight ships them for offline use on
Windows, macOS and Linux on x64/ARM64. No install script, runtime download or shell invocation is
required. If an npm archive made on Windows loses Unix executable bits, the first launch copies
that binary to a private temporary directory and sets its execute bit; the installed package is
not modified. A `noexec` temporary filesystem can still prevent launch. `vendor/micro/LICENSE`
and `LICENSE-THIRD-PARTY` are copied from the upstream release.

Each upstream `.sha` file was fetched from the same release and checked against its archive before
extracting only the executable and common licenses. These are transfer/integrity checks of the
upstream release artifacts, **not** independent provenance or a code-signing attestation. A
release should additionally verify the executables on each OS/architecture, including macOS
quarantine/signing behavior and Windows console handoff. No such runtime validation is implied by
these hashes.

| Target | Upstream archive | Archive SHA-256 | Shipped executable SHA-256 |
| --- | --- | --- | --- |
| Windows x64 | `micro-2.0.15-win64.zip` | `90635c53c11aa2a0d997f5e3ed43528877740725500207640b29551cef18479b` | `77a8b925c885702b5605b4aebb8e77c7b15e5b03beeb14b7aa7e12b2b8d4ef3f` |
| Windows ARM64 | `micro-2.0.15-win-arm64.zip` | `c3d5acd5fc05afd65b7dcad3a18e0c08148e4885b4044be8d19e22a8efbf670b` | `b96b2edc75973caa4a44c5dc03e41dadd6c001c0e6c45eab508b501616ac61cf` |
| macOS x64 | `micro-2.0.15-osx.tar.gz` | `d765b9bdd6478c4f5a3cbd5a93ebe7bab2b9cec30b5350016975cf1045855cee` | `f3b5932edb0bfc0f442e4217659d36ada5f0942c91da20d97776c9d7472a28f1` |
| macOS ARM64 | `micro-2.0.15-macos-arm64.tar.gz` | `2ff285cc49f2ac3f7a6e9110e2dabd3c848b73eed56a8396d627c0af80a34624` | `3cce2e6e9e760c6d89889a0e029c71853b6b56cecbb31f0a43eeec35c027b347` |
| Linux x64 | `micro-2.0.15-linux64-static.tar.gz` | `267d238eac1e26ed053d13d4d48bd421b87f9eb538b604f0b2f74a85598b6cc2` | `2027f2e4698fa4e826523ad16b95c724bf808de479f10ec769cdd200437701b3` |
| Linux ARM64 | `micro-2.0.15-linux-arm64.tar.gz` | `5ca127857bf5500be3879f1a70b27556e737a49da04a1be5334de9e8e8781ad9` | `e0b4a8234f0432474e7ee28e12ffac0fe3bd31f030ba51dc059caa2f3d6d8bfc` |

Micro is an external process. In Windows Terminal, Midnight asks `wt.exe -w new new-tab` to
open Micro in a separate window; Pi remains in its original window. Windows Terminal controls
that window's size and placement. Paths are passed to PowerShell with `-NoProfile -EncodedCommand`
as encoded data (not shell-interpolated arguments) because Windows Terminal treats semicolons as
command separators. `wt.exe` returning success means only that it accepted the request: it does
not report whether Micro started, saved or exited. Return to Pi and run `/midnight refresh` after
saving; automatic focus return and file refresh are not provided.
Outside Windows Terminal, Midnight stops Pi's TUI, runs Micro with the file as a single argument
without a shell, then restarts and redraws Pi. The file's contents are never sent to an additional
service by Midnight. Micro handles its own unsaved-change prompts. The binaries increase the source checkout by about
73 MB uncompressed. An `npm pack --dry-run --json --ignore-scripts` run on this checkout
estimated 33,380,919 bytes for the whole compressed package; this is not a published artifact
or an install-time measurement.
