# Vendored from userland-run/nano

These files are copied verbatim from the nano runtime so the conformance runner
reuses the exact MemFS + FS_PENDING bridge nano ships. Re-sync on every nano
release and bump `tools/nano-syscalls.json` to match.

| file | source | nano version |
|------|--------|--------------|
| memfs.mjs | nano/test/memfs.mjs | 0.1.0 |
