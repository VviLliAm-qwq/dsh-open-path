# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-09-13

### Added

- **Bilingual output.** Every string the command renders — replies, errors, the
  candidate list, the picker's title, the directory tag and the list separator —
  now follows the host's language, resolved through the same chain dsh-TUI uses:
  `DSH_TUI_LANG` → the live `dsh-tui` settings namespace → `~/.dsh-tui/lang.json`
  → the OS locale → Chinese. A locale that exists but is unsupported reads as
  English; a *missing* locale keeps Chinese, so a Chinese host that never wrote
  a preference renders exactly as before.
- The command definition now carries a `descriptions { zh, en }` map for the host
  to localize, and the input hint is rendered in the resolved language.
- `src/i18n.ts` exports the resolution chain (`resolveLang`, `normalizeLang`,
  `langFilePath`) and the dictionary (`t`, `STRING_KEYS`).
- `README.zh.md`, and a test suite for the dictionaries and the resolution chain
  (key parity between the two languages, precedence, unknown-key behaviour).

### Changed

- The language is re-resolved on every invocation, so a `/lang` switch reaches
  the next reply without a restart.

### Notes

- The modules under `lib/` are build output (`tsc`): change `src/` and rebuild.
