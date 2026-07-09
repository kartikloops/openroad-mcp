# OpenROAD-MCP: v0.6.0 Release + Roadmap to v1.0

## Context

The `v0.6.0` tag is the first release that publishes the TypeScript port to npm
(`npx -y openroad-mcp`). The package name is still unclaimed on npm, so this
release claims it. The TS port (`typescript/`) is at full 1:1 parity with
Python: all 10 tools, PTY/session/buffer/ANSI internals, both stdio + Streamable
HTTP transports, enforced by golden-fixture tests against Python-generated JSON
in `tests/golden/`.

**v1.0 goal (per team decisions):** TypeScript-only server; Python kept as a
deprecated, unmaintained package. Theme: *Docker deployment, cross-platform
support, production-ready testing & QA*.

**Decisions made for this plan:**
- **Timeline:** v1.0 in late Aug / September 2026 (6 to 9 weeks).
- **SDK v2 package migration and 2026-07-28 protocol adoption are separate
  decisions.** For v1.0, the safe default is to migrate to the v2 packages and
  keep protocol behavior compatible with existing 2025-era clients. The team can
  enable the 2026-07-28 protocol revision later, or serve it alongside the older
  behavior, after mentor review.
- **In scope:** session persistence (#57), configurable Docker/CLI vars (#48).
  Flow orchestration (#95/#122) deferred to v1.x.
- **Runtime stays npm / Node 22 or newer**. Do not switch to Bun because
  node-pty/sharp prebuilds and ecosystem `npx` conventions matter here. SDK v2
  requires Node 20 or newer, so Node 22 is fine.

**Key upstream facts:** repo lives at `The-OpenROAD-Project/OpenROAD-MCP`;
releases already dual-publish PyPI + npm + GHCR + MCP Registry through `release.yml`;
issue #132 requests an official `openroad/openroad-mcp` Docker Hub image.

### SDK v2 and the 2026-07-28 protocol revision

These are not the same migration.

The MCP team says projects can move to SDK v2 first and enable the new protocol
revision when ready. That means OpenROAD-MCP can upgrade the TypeScript packages
before v1.0 without forcing every client onto the 2026-07-28 behavior.

For this roadmap, use this rule:

1. Move to the SDK v2 packages before v1.0 if the migration stays mechanical.
2. Keep existing client behavior working during the v1.0 release.
3. Treat the 2026-07-28 protocol revision as a separate product decision because
   it changes behavior, including stateless routing, `Mcp-Method` and `Mcp-Name`
   headers, `ttlMs`, and `cacheScope`.
4. Decide with mentors whether v1.0 freezes only the stable current behavior or
   also advertises the 2026-07-28 behavior alongside it.

This removes the contradiction: SDK v2 is planned before v1.0, but the new
protocol revision does not automatically become the v1.0 API contract.

---

## Phase 0: v0.6.0 (tonight, before tagging)

Split by whether the item can break the release.

### Release-blocking (verify FIRST)
1. **Confirm `NPM_TOKEN` secret exists** in the org repo. `release.yml`'s
   `publish-npm` job uses it. Missing token = the whole npm publish fails. First
   publish claims the name via token; switch to OIDC in Phase 1 (trusted
   publishing can't be used until the package exists).
2. **Add `mcpName` to `typescript/package.json`:**
   `"mcpName": "io.github.the-openroad-project/openroad-mcp"`. The MCP registry
   validates npm packages by matching this field against `server.json`'s `name`.
   Without it, npm/PyPI/Docker still publish, but the **registry publish of the
   npm entry fails validation**. (PyPI uses the README `<!-- mcp-name: ... -->`
   marker, already present at README line 3.)

### Cosmetic cleanups (ride along; do not block the tag)
3. **Fix stale namespace label in `Dockerfile`** (line 38):
   `LABEL io.modelcontextprotocol.server.name` still says
   `io.github.luarss/openroad-mcp`; everything else (server.json, Makefile,
   Dockerfile.ts) uses `the-openroad-project`.
4. **README Docker section** (line 730) still says "🚧 GHCR coming soon" though
   `docker-publish.yml` has published to `ghcr.io/the-openroad-project/openroad-mcp`
   since v0.3. Replace with real `docker` usage instructions.
5. **Remove unused `denque` dependency** from `typescript/package.json`
   (declared line 45, imported nowhere; confirmed by grep).
6. Run the existing `/release` skill flow for the version bump (pyproject,
   server.json x3, README pins, uv.lock, CHANGELOG; the `[Unreleased]` section
   already describes this branch's work).

---

## Phase 1: v0.7.0 (~late July): TypeScript becomes the primary artifact

### CI flip (TS into the required path)
- Promote TS testing from the path-filtered `ts-ci.yml` into the main required
  CI: run `typecheck` / `lint` / `test` / `test:integration` on every PR
  regardless of paths (a Python-only PR can still break golden parity).
- Add macOS (macos-14/15, arm64) runners for the TS suite. Currently TS is
  ubuntu-only while Python CI already covers macOS.
- Add an `npx` install smoke job: `npm pack` the tarball, install it fresh, run
  `openroad-mcp --help`. This validates node-pty/sharp prebuilt binary resolution on
  all OS runners.
- **Audit `scripts/fix-node-pty.cjs` (postinstall).** It runs on every
  `npx`/`npm ci`; a failure on one platform breaks install there. Confirm whether
  current node-pty prebuilds make the shim unnecessary; the smoke job is the gate.

### Docker: publish the TS image
- Extend `docker-publish.yml` to build & push the `Dockerfile.ts` `runtime`
  stage (currently a CI-only check, never published). Tag scheme: **TS image
  takes `latest` + semver; Python image keeps publishing under a `-python`
  suffix** during the transition.
- **Call out the `:latest` Python-to-TS swap in release notes as a deliberate,
  safe change**. It is safe *precisely because* of the golden wire-contract
  parity (byte-identical serialization), so `:latest` migrates transparently.
  Frame it as a feature, not a footnote.
- Update `server.json`'s `oci` package entry to the TS image once published.
- Add explicit `--platform linux/amd64` to all builds (`openroad/orfs` base is
  x86_64-only; prevents silent QEMU fallback on Apple Silicon).
- Implement **#48** (configurable Docker image / CLI variables). This is small and squarely
  in the Docker theme.
- **Start #132 (Docker Hub `openroad/openroad-mcp`). Mark it blocked on org
  coordination.** Requires org-level Docker Hub credentials/secrets that don't
  exist yet; must not stall v1.0 if creds lag. Add Docker Hub as a second push
  target in `docker-publish.yml` once available.

### Supply chain
- Switch npm publish from `NPM_TOKEN` to **npm trusted publishing (OIDC)**.
  configure on npmjs.com after the first publish exists; `id-token: write` is
  already in `release.yml`; provenance then comes automatically. Note:
  trusted-publisher configs created after 2026-05-20 must explicitly select
  allowed actions.
- Add a **post-publish smoke test** to the release workflow: `docker pull` the
  pushed image + `npx -y openroad-mcp@<ver> --help` (registry round-trip
  validation, currently missing).

### Docs
- TS-specific README section / restructure (npm/uvx stay side-by-side for now,
  per team decision); refresh `ROADMAP.md` (stale since March, still says
  "Phase 1 -> v0.5").

---

## Phase 2: v0.8.0 (~mid-August): SDK v2 packages + cross-platform

> Sequencing note: do the **golden canonicality flip as an isolated no-op step
> BEFORE the SDK migration** so wire diffs are attributable. See below.

### Step 2a: Flip golden canonicality Python-to-TS (no-op, still on SDK v1)
- Regenerate goldens against the **TS server while still on SDK v1**, so output
  is identical and the diff must be **zero**. This proves the canonicality
  conversion is clean and makes TS the reference implementation.
- Only after a zero-diff conversion is confirmed do you touch the SDK. Any
  subsequent wire change is then isolated and attributable to the SDK, not the
  reference flip.

### Step 2b: SDK v2 *package* migration (after v2 goes stable July 28)
- Migrate `@modelcontextprotocol/sdk` ^1.29 to the split v2 packages
  (`@modelcontextprotocol/server` + the Node adapter). Start with the official
  codemod, run at the **package root** (not `./src` because it rewrites `package.json`):
  `npx @modelcontextprotocol/codemod@beta v1-to-v2 .`
- v2 removed WebSocket transport, server auth, and Zod helpers, and moved tool
  schemas to **Standard Schema**. We're on `zod ^4.4.3` + StreamableHTTP, so we
  should be clean. Budget time to verify the Zod-helper removal doesn't hit
  the tool schemas.
- The current HTTP mode (`typescript/src/server.ts`) is already stateless
  per request, matching the new spec's model.

### Step 2c: 2026-07-28 protocol revision (independent, optional for v1.0)
- Do not treat this as part of the SDK package migration.
- Adopt the revision only after mentor review and compatibility testing. The
  behavior change includes `ttlMs` / `cacheScope` on `tools/list`, plus
  `Mcp-Method` / `Mcp-Name` header routing.
- Because SDK v2 can support both client eras, this does not need to gate v1.0.
  The v1.0 freeze can stay on the current stable behavior while the new revision
  is served alongside it later.

### Cross-platform (ROADMAP's unchecked "Ubuntu, macOS, Windows/WSL2")
- Extend the TS CI matrix: ubuntu-22.04/24.04, macos-14/15, **windows-latest**.
- **Native Windows is a boot smoke test only, not functional OpenROAD.** OpenROAD
  doesn't run natively on Windows, so `windows-latest` validates node-pty/ConPTY
  loading + `--help` + tool listing. It does **not** exercise real sessions.
  Real Windows usage is Docker Desktop or WSL2. Make this unambiguous in docs so
  "Windows validated" is never read as "sessions work on native Windows."
- Add a Windows/WSL2 section to `docs/CROSS_PLATFORM.md` (currently Ubuntu +
  macOS only) and a WSL2 validation job in `cross-platform.yml`.
- Document Apple Silicon behavior for the amd64-only image (Rosetta/QEMU);
  investigate whether an arm64 ORFS base exists upstream.

### Session persistence (#57)
- Implement in TS. PTY processes can't survive a restart, so define semantics
  explicitly: persist session **metadata + command history** to disk, restore on
  startup, optional auto-respawn flag. **Design the tool-schema additions before
  Phase 3's API freeze.**

---

## Phase 3: v0.9.0 = v1.0-rc (~late August): QA hardening + Python deprecation

### Production testing & QA (five gates: smoke / conformance / scenarios / load / security)
- **MCP Inspector CLI e2e in CI** (#60): tool discoverability + response-shape
  checks over real stdio transport; deterministic, runs on PRs.
- **Real-ORFS integration** (builds on PR #37): nightly job running the
  nangate45/gcd flow through the TS server inside the `Dockerfile.ts` test stage
  to exercise exec/query routing, report-image tools against real artifacts, and
  error-pattern detection against real OpenROAD output.
- **Performance benchmarks with thresholds** for TS (session-create latency,
  tool-call latency, PTY throughput), nightly with regression tracking; **load
  test** (50 concurrent sessions with lightweight stub processes) and
  memory-leak detection (vitest perf config already has `--expose-gc`).
- **Multi-client validation** (per team discussion): documented sanity pass on
  Claude Code, Gemini CLI, Cursor, VS Code Copilot + one cloud/remote HTTP
  deployment.
- **Security gate:** `npm audit` in CI, review of command whitelist +
  path-security against the frozen API, dependency pinning review.
- **Coverage:** target **90% or higher on core modules** (`manager`, `session`, `tools`,
  `pty_handler`) rather than a global 90% number. This is more meaningful and avoids
  gaming the last, most expensive 10%.

### Python deprecation (decision: keep deprecated, stop updating)
- v0.9: announce in README/CHANGELOG; add a startup/import `DeprecationWarning`
  to the Python package pointing at npm; last PyPI release ships this warning.
  **Do not yank or delete** the PyPI package (yanking breaks existing pins).
- Freeze Python: move `src/openroad_mcp` + Python tests out of the required CI
  path; keep the golden-parity job until v1.0 tags, then retire it.
- **Python-freeze cleanup checklist** (decide fate so it doesn't rot):
  `requirements.txt`, `requirements-test.txt`, `uv.lock`, `pyproject.toml`, and
  the `ci.yaml` matrix.

---

## Phase 4: v1.0.0 (early to mid September)

- **API freeze:** the 10 tool signatures + session-persistence additions frozen;
  documented semver commitment + deprecation policy. Decide (with mentors)
  whether the freeze includes the 2026-07-28 protocol behavior or only the
  current stable behavior. If the newer behavior is available, serve it alongside
  the current behavior instead of forcing clients to switch.
- **Docs completeness:** API reference for all tools, deployment guide
  (npx / Docker / cloud-HTTP), troubleshooting guide, updated ROADMAP.
- **Release:** npm (trusted publishing + provenance) + GHCR + Docker Hub
  `openroad/openroad-mcp` (if org coordination complete) + MCP Registry +
  GitHub Release, each with post-publish smoke tests.
- **server.json at v1.0:** drop the `pypi` package entry (npm + oci remain);
  PyPI project description updated to point at npm; Python source preserved on a
  `python-legacy` branch and removed from `main` after v1.0.
- **Stretch/after:** submit to the **Docker MCP Catalog** (containerized,
  sandboxed distribution; a good fit since the image bundles OpenROAD/ORFS).

---

## Critical files

- **Workflows:** `release.yml`, `docker-publish.yml`, `ci.yaml`, `ts-ci.yml`,
  `cross-platform.yml`
- **Docker/build:** `Dockerfile.ts` (becomes the published image), `Dockerfile`
  (Python, transition-only), `Makefile` (`IMAGE_NAME`, `ORFS_VERSION`, `test-all`)
- **Package/config:** `typescript/package.json`, `typescript/src/server.ts`,
  `server.json`, `README.md`, `docs/CROSS_PLATFORM.md`, `ROADMAP.md`
- **Reuse:** the `/release` skill (version-bump automation),
  `tests/golden/generate_golden.py` + `make golden`, existing in-memory transport
  tests in `typescript/__tests__/golden/tool_manifest.test.ts`

## Verification

- **Tonight:** after tagging, watch `release.yml` until all jobs are green; then
  `npx -y openroad-mcp@0.6.0 --help`,
  `docker pull ghcr.io/the-openroad-project/openroad-mcp:0.6.0`, and confirm the
  server appears/updates on the MCP registry with the npm package entry validated
  (this is what the `mcpName` field gates).
- **Each phase:** CI matrix green on all OS runners; `make test-all` (Python+TS
  aggregate) passes until Python freeze; golden parity green until the
  canonicality flip, then TS-golden green.
- **v1.0 gate:** Inspector e2e + nangate45/gcd nightly + load test + benchmarks
  all green for 2 consecutive weeks; fresh-machine install validated on Ubuntu,
  macOS (arm64), Windows (Docker & WSL2) following only the docs.
