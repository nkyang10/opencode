## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- The page and the API come from one compiled CLI. Do not use the official website.
- Build from `packages/opencode`: `OPENCODE_REQUIRE_EMBEDDED_WEB_UI=1 bun run script/build.ts --single`
- Run `dist\opencode-windows-x64\bin\opencode.exe web --port 4446 --hostname 127.0.0.1`
- Open `http://127.0.0.1:4446`. If 4446 is already taken, stop the process listening there and start again.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

### A JSX prop that reads state does not react — pass a getter

`icon={<Icon name={flag() ? "on" : "off"} />}` looks reactive and is not. The element
is built once, when the parent renders, so **anything read inside it is frozen** —
the button works and its glyph never moves. The same applies to any prop typed
`JSX.Element` whose value is meant to vary with state.

- If a component's prop allows it, pass a **getter**: `icon={() => <Icon … />}`.
  `IconButtonV2` accepts `JSX.Element | (() => JSX.Element)` for exactly this.
- Verify by reading the DOM after a real click, not by reading the code.

### Icons are a sprite, not inline paths

`Icon` renders `<svg><use href="#opencode-icon-NAME"></use></svg>` and injects the
sprite at mount. So:

- **`querySelectorAll("svg path")` finds nothing** — every icon has zero inline
  paths, which reads as "the icon did not render" and is not true.
- Assert on the `<use>` `href`, or on `data-component="icon"`.
- The sprite is **not in the served HTML**, so `curl` finds no `<symbol>`; you need
  a real browser.
- A glyph that differs from its sibling only by a small mark is unreadable at 20px.
  If two states must be told apart, change the whole silhouette, and give the
  control a pressed state as well.

## Localization

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for visible copy, placeholders, accessible labels, tooltips, menus, dialogs, toasts, empty states, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale complexity behind the shared typed i18n APIs. Feature and component code should use `language.t(...)` for ordinary copy and `language.plural(baseKey, count, params)` for count-sensitive copy. It must not inspect the locale, call `Intl.PluralRules`, construct or select plural-category keys such as `.one` or `.other`, or branch on locale-specific grammar.
- Prefer complete translated phrases. Do not concatenate grammatical fragments or make call sites assemble sentences. Keep placeholders to irreducible dynamic values such as names, paths, and counts.
- If a translation cannot be expressed by the current API, deepen the shared language/UI i18n module so one typed call owns locale selection, plural resolution, fallback, and interpolation. Do not leak that machinery into product code.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- For developer-facing terminology, prefer the words already used by the target language's developer community over literal dictionary translations. Cross-check maintained localized developer products such as Firefox, KDE, and VS Code; use at least two independent corpora when they are available. If established practice keeps an English loanword or acronym, keep it rather than inventing a translation.
- Translate complete UI phrases in context. A glossary hit is evidence, not permission to translate word-by-word. Check terse labels such as session, prompt, agent, model, fork, shell, terminal, workspace, and worktree in the same grammatical role before choosing a term.
- Before a locale is ready, audit recurring concepts for one consistent translation and review every value that still equals English. Classify retained English as a product name, provider/tool name, URL, code token, keyboard legend, acronym, asset name, or established borrowing; translate unexplained leftovers.
- In translation review notes, name the corpora used and call out uncertain or region-specific terminology so native speakers can focus review where it matters.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
