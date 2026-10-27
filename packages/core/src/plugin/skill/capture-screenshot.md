# Capturing a screenshot

Use this skill when the user wants to see, capture or visually check something. Pick the smallest
target that answers the request, save the result outside the repository, and show it with the
`show_image` tool.

## 1. Choose the target

- **Web page** — use a headless browser (the recipes below).
- **Existing artifact** — for example a Playwright `test-results/` image, a generated chart or a
  diagram — call `show_image` with its path.
- **Chart or diagram that does not exist yet** — render it to a PNG first, then call `show_image`.
- **Desktop or application window** — only if the `screenshot` tool is available in this session.
  When it is available, run `screenshot` with `action: "list"` first if the user names an
  application, then capture that window or display. If the tool is not available, say that desktop
  capture is unavailable here and offer the web-page or artifact route instead.

## 2. Capture web pages

Prefer the project's Playwright when it is installed:

```sh
npx playwright screenshot --viewport-size=1280,800 <url> {{screenshots_dir}}/<timestamp>-<slug>.png
```

Add `--full-page` when the user needs the whole page rather than the viewport. Otherwise use
headless Chrome or Chromium:

```sh
google-chrome --headless=new --hide-scrollbars --window-size=1280,800 --screenshot={{screenshots_dir}}/<timestamp>-<slug>.png <url>
```

Substitute `chromium`, `chromium-browser` or `chrome` for the available binary. Wait until the page
is ready before capturing (for example a short `sleep`, a dev-server ready line, or Playwright's
network-idle behavior). For mobile checks use a `390x844` viewport.

If neither browser is available and a configured Playwright or Chrome DevTools MCP server exists,
use that server; its images render through the normal image path.

## 3. Save outside the repository

Save captures under `{{screenshots_dir}}/<timestamp>-<slug>.png`. Never write into the repository
unless the user explicitly asks for a project copy (for example documentation images, bug-report
assets or visual test baselines), and never stage or commit an image unless asked.

## 4. Headless hosts

Web pages work through a headless browser on a machine without a display. For desktop applications
under Xvfb, start `xvfb-run -a` or `Xvfb :99`, then capture with `screenshot` using
`x_display: ":99"` when that tool is available.

## 5. Privacy

Capture the smallest target that answers the request — a window rather than the whole screen — and
avoid windows that show secrets. Never put credentials or tokens on a command line, because they
are visible in process lists and shell history. State what the image contains.

## 6. After showing the image

Tell the user what to look at. If the model cannot view images, say so instead of describing
content it cannot see.
