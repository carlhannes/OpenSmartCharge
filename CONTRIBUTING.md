# Contributing to OpenSmartCharge

Thanks for your interest in contributing! OSC is intentionally lean, so the best contributions tend to be focused on one thing, well-tested, and easy to understand.

## The best way to contribute: a new module

If you need a different charger type, tariff source, or vehicle integration, you can write a module without touching the OSC core at all. Modules live in the `./plugins/` directory and are auto-loaded at startup.

See **[docs/modules.md](docs/modules.md)** for the full guide, including a worked example and the TypeScript interfaces you need to implement.

## Other contributions

Before opening a pull request for anything else:

1. **Open an issue first** for non-trivial changes — describe what you want to add and why. We want to stay lean and will push back on features that belong in modules rather than core.
2. **Smaller is better.** One PR per concern.
3. **Follow the conventions.** See [AGENTS.md](AGENTS.md) for the full list — the short version: functional TypeScript (no classes), no speculative abstractions, no early optimization.
4. **Run the tools before pushing:**
   ```bash
   npm run format && npm run typecheck && npm run lint && npm test
   ```
   (`format`, `typecheck` and `lint` cover the UI in `src/ui2` as well — install its dependencies once with `npm --prefix src/ui2 install`; `npm test` is the backend suite.)
5. **Update docs** if your change affects any documented behavior.
6. **Check degradation** if the change touches a module, the SDK, a resolver, the control loop or the lifecycle: a lost dependency must land on a lower rung with more margin, never on 0 A. With Claude Code, run `/degradation-review`; otherwise walk the case matrix in [docs/degradation.md](docs/degradation.md) by hand.

## Bug reports

Open an issue with:
- What you expected
- What happened
- Your `osc.yaml` (redact credentials)
- Logs (with `LOG_LEVEL=debug`)

## License

All contributions are under the MIT license.
