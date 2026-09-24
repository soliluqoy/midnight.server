# MiniCPM model lock

`minicpm5-2b-q8_0.lock.json` pins the final post-trained `openbmb/MiniCPM5-2B-GGUF` Q8_0 file at a fixed Hugging Face revision, by size and SHA-256. The same values are compiled into the CLI (`packages/coding-agent/src/midnight/pins.ts`); a test keeps the two equal.

Get the model in one of these ways (each resumes interrupted downloads and verifies before use):

```text
midnight.server model fetch                 # installed app: into %LOCALAPPDATA%\midnight.server\models
.\scripts\fetch-model.ps1                   # source checkout: into models\cache (ignored by Git)
node scripts/verify-model.mjs <file.gguf>   # verify an existing file
```

Source URL:

```text
https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q8_0.gguf
```

The CLI refuses to load a file that does not match the lock. A successful verification is cached per file (path, size, modification time), so later startups do not re-hash 2.5 GiB. `midnight.server model verify` forces a full re-check. GGUF files are excluded from Git by `.gitignore`.
