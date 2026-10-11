# CLAUDE.md

Hugo source for the micz.it website (mostly Thunderbird add-on pages and ThunderAI docs).

**Keep this file up to date.** When a change makes something here wrong or incomplete (build steps,
config params, theme structure, conventions, quirks), update CLAUDE.md in the same change. Remove
notes that no longer apply instead of leaving them as history.

## Build and dev

- `hugo.exe` lives in `miczit/hugo` (the parent folder of this repo) and is not on PATH.
- Production build: `hugo --gc --minify` writes to `docs/`. `docs/` is committed and deployed to
  GitHub Pages by `.github/workflows/static.yml` on pushes to `master` that touch `docs/**`.
  Hugo does not delete stale files in `docs/`; use `--cleanDestinationDir` for a clean build.
- **`docs/` is the publish dir and only the user updates it.** Never build into it, edit it, or
  use it to check results. For every test, render the site into a temporary dir
  (`hugo -d <tmp>`, or `hugo server --renderToMemory`), check the output there, and delete the
  temp dir yourself when done.
- Dev server: `hugo server`.
- `CNAME` is in `static/`, so every build copies it into `docs/`.

## Site config (`config.toml`)

- Single theme: `themes/miczit_2027`.
- Languages: en (default, served at the root), it, de, fr, es. RSS, taxonomy and sitemap are disabled.
- `content/**/*.json` is excluded from rendering (`ignoreFiles`). Shortcodes read these files as data.
- `params.forceCSSReloadID` (YYYYMMDD) is the `?v=` cache-buster on `theme.css`. **Bump it whenever
  `theme.css` changes.**
- `params.goatcounterURL`: GoatCounter analytics, loaded in `partials/head-extra.html`. There is no
  Google Analytics and no cookie consent.
- `markup.highlight.noClasses = false`: Chroma outputs classes, and the `.chroma` rules in
  `theme.css` color them for both dark and light.

## Theme `miczit_2027`

A dark-first editorial theme. The light/dark toggle is saved in localStorage under the key
`user-color-scheme`. Fonts are self-hosted and OFL-licensed (`static/fonts/`). The home page is a
full-bleed black-and-white photo.

```
themes/miczit_2027/
├── i18n/{en,it,de,fr,es}.yaml
├── layouts/
│   ├── _default/{baseof,single,list,redirect}.html
│   ├── index.html          home hero on the photo (does not render .Content)
│   ├── robots.txt
│   ├── partials/           head, head-extra, theme-init, header, footer, lang-switcher,
│   │                       theme-toggle, doc-title, ph-list-script, addon-nav
│   └── shortcodes/         project shortcodes (page_title, list-thunderbird-pages, *_list, lang_*,
│                           ui_button, themed_screenshot)
└── static/
    ├── css/theme.css       dark tokens on :root, light tokens on [data-theme="light"]
    └── fonts/
```

- Font tokens: `--serif` (Newsreader), `--mono` (JetBrains Mono), `--text` (Inter, body text),
  `--display-sans` (Inter Tight, header breadcrumb).
- `_default/redirect.html` builds the language redirect stubs (`/it/`, `/de/`, `/fr/`, `/es/`, …)
  and the legacy `thunderdbird-addon-*` aliases. Do not change this behavior.
- Page titles are short: `Title` is the page's own name only ("Ollama", "Setup guides", "ThunderAI",
  "Donate"), with no add-on name or "Thunderbird Addon" in it. Breadcrumb, add-on cards and sidebar
  show it as is. `partials/doc-title.html` builds the `<title>` tag: the page, its ancestors up to
  the top-level page, then the site title ("Ollama - Setup guides - ThunderAI - Mic's"); the main
  page of an add-on also gets the i18n "Thunderbird Addon" ("ThunderAI - Thunderbird Addon - Mic's").
- Hugo sorts pages by `linkTitle` (after weight and date): `list-thunderbird-pages` sorts by
  `Title` explicitly, so the "Overview" linkTitle of ThunderAI does not move its card.
- `partials/header.html` shows the wordmark and then a breadcrumb:
  - it skips Home, because the wordmark already links there;
  - language stubs have no Title, so it takes the title from a translation;
  - add-on pages are siblings of `thunderbird-addons/` in `content/`, not children of it. So when
    the top-level ancestor has `addon_status`, the breadcrumb puts the `/thunderbird-addons` page
    in front. Another top-level page can name a parent with `breadcrumb_parent = "/<path>"` in its
    front matter (used by `thunderbird-addon-development-discontinued`): the parent goes in the
    breadcrumb and in the `<title>`.
- `baseof.html` adds `class="home"` to `<body>` on the home page. The photo background
  (`body.home .page-shell::before`) needs this class. Areas on the photo use the fixed
  `--photo-ink` color, so the theme toggle does not change the home page.
- Mobile breakpoint: 880px (one column below it).
- Add-on sidebar (`partials/addon-nav.html`, used by `single.html` and `list.html`): shown on every
  page of a top-level section that has `content/<section>/addon-nav.json` (today only ThunderAI),
  except the section's own page and redirect stubs. The JSON holds only the structure: groups (the
  title is an i18n key, e.g. `addonNavSetup`) and entries (`page` path relative to the section,
  optional `children` and `also` = other pages that mark the entry as current). An entry links the
  page in the current language, or the default-language page when there is no translation or it is
  a redirect stub, and shows that page's `LinkTitle`, i.e. its short `Title` (a `linkTitle` is set
  only where the entry differs: "Overview" on the ThunderAI page). So pages in English only show an
  English entry in every language. To add a page: list it in the JSON. The sidebar widens the
  layout, so the reading column keeps its width.
  At 1100px and below it becomes a collapsed box above the page. Do not use `merge` on a dict
  that holds a Page: the build hangs. The "Go back" / "Next" links at the bottom of the pages stay.
- Add-on screenshots come in two versions: the dark file, and the light one with the same name in a
  `light/` subfolder. The `only-dark` / `only-light` classes in `theme.css` show the one that matches
  the site theme. `ui_button` puts a button image in a line of text, at its real size (captured at 1x).
  `themed_screenshot` puts a screenshot linked to its full-size file.
- GitHub icon: `theme.css` puts the GitHub mark in front of every link whose `href` contains
  `//github.com/` (on `.doc-card` links it goes before `.doc-card-title`). It is a CSS mask filled
  with `currentColor`, so one icon works in both themes. No markup is needed in the content.

## Known quirks (not theme bugs)

- `content/_404.html` is bilingual (IT + EN) on purpose.
- The `ollama-cors-*` pages have inline `<style>` blocks for their tables. They are kept on purpose:
  overriding them breaks the borderless ollama-cors table layouts.
- ThunderAI setup guides (`guides/*`): the summary table at the top uses `class="guides"`, the
  same theme style as the comparison table in the guides index: one `<thead>` row with the labels
  and one body row with the values. Every table in the guides uses `class="guides"`, and the guides
  have no inline `<style>`.
- The ThunderAI status pages (`status.html`, `status_archive.html`) center their header with
  inline CSS on `.title-block`. Each issue notice is an `<h1>` that opens and closes with `<br>`.
  `.content h1` in `theme.css` styles these notices and hides those two `<br>`. The archive page
  sets a smaller size inline.
- Headless Edge has a minimum layout width of about 500px. A "390px" screenshot is a crop of a
  wider page, so overflow seen in it is not real.
