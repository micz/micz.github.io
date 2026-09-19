# miczit_2027 — nuovo tema Hugo per micz.it

Documento di consegna. Data: 2026-09-19. Branch: `new_style`.

## Cos'è

`miczit_2027` è un tema Hugo **parallelo** al tema vendored `anubis`, attivabile senza
toccare `config.toml` né `themes/anubis/`. È dark di default con toggle (chiave
localStorage `user-color-scheme`, continuità con il sito attuale), tipografia self-hosted
(Newsreader + JetBrains Mono, OFL) e home full-bleed su foto B/N.

## Come si usa

- **Build di anteprima** (non tocca `docs/`):
  `hugo --config config.miczit_2027.toml --gc --minify -d docs_preview`
- **Dev server**: `hugo server --config config.miczit_2027.toml --port 1314`
- `config.miczit_2027.toml` usa `layoutDir = "layouts_2027"` (directory volutamente
  vuota, solo `.gitkeep`): neutralizza gli override in `layouts/` di progetto e fa
  risolvere gli shortcode al tema. `publishDir = "docs_preview"` (gitignored).
- **Switch a produzione** (decisione separata, NON eseguita): aggiornare `docs/` con
  `hugo --config config.miczit_2027.toml --gc --minify -d docs` e pubblicare. Il sito
  attuale continua a essere generato con `config.toml` + anubis finché non si decide.

## Struttura del tema

```
themes/miczit_2027/
├── theme.toml                  (min_version 0.157.0)
├── i18n/{en,it,de,fr,es}.yaml  (skipToContent, home, toggleTheme)
├── layouts/
│   ├── _default/{baseof,single,list,redirect}.html
│   ├── index.html              (home: hero su foto, niente .Content — stub legacy)
│   ├── robots.txt              (portato verbatim da anubis)
│   ├── partials/               head, head-extra, theme-init, header, footer,
│   │                           breadcrumb, lang-switcher, cookie-consent,
│   │                           theme-toggle, title-split
│   └── shortcodes/             i 10 shortcode del progetto; page_title e
│                               list-thunderbird-pages riscritti
└── static/
    ├── css/theme.css           (token dark :root + [data-theme="light"])
    └── fonts/                  Newsreader var + italic var, JetBrains Mono var, LICENSE
```

Note architetturali:
- `redirect.html` è portato **verbatim** dai layout di progetto: genera gli stub di
  redirect per le lingue e gli alias legacy.
- `title-split.html` parsa esattamente due pattern di titolo
  (`Thunderbird Addon: <Name>` e `"<Addon>" Thunderbird Addon - <Page>`) e passa
  attraverso tutto il resto (titoli guide tradotte, Donate, ecc.).
- Il breadcrumb usa `.Ancestors.Reverse`; **salta gli antenati senza titolo** (stub di
  redirect di lingua come `_index.it.html`, che non ha front matter Title) e mostra
  sempre la home come "Home" (i18n). Vedi la sezione bug sotto.

## Scelte e deviazioni dal piano

1. **Pagine status ThunderAI** (`status.html`, `status_archive.html`): il piano diceva di
   ripuntare i selettori inline `h1.post-title`/`h1.post_title` su `.page-title`. Fatto
   meglio: puntano a **`.title-block`** (centra insieme eyebrow e titolo — puntare solo
   all'h1 avrebbe lasciato l'eyebrow a sinistra con il titolo centrato). Il
   `font-size: 27px` dell'archivio è stato eliminato: nel nuovo markup sarebbe colpito
   solo l'eyebrow (l'h1 ha la sua dimensione da classe) e avrebbe reso il titolo
   incoerente col resto del sito.
2. **Mobile "390px"**: headless Edge ha una larghezza minima di layout di ~500px e
   ritaglia lo screenshot alla larghezza richiesta — il presunto overflow a 390px era
   questo artefatto (verificato: lo shot a 500px contiene esattamente la parte sinistra
   dello shot a 390px). A 390px reali il layout è a colonna singola (breakpoint 880px),
   larghezza interna 350px, nessun contenuto non spezzabile. Verificato a 500/1024/1440.
3. **Zone foto home indipendenti dal tema**: la home usa `--photo-ink` (fisso) su foto +
   scrim; il toggle non cambia la home. Il cookie banner invece segue il tema.

## Bug trovati e corretti durante la verifica

- `baseof.html`: `<body>` non aveva `class="home"` → la foto di sfondo home
  (`body.home .page-shell::before`) non veniva mai renderizzata. Corretto con
  `{{ if .IsHome }} class="home"{{ end }}`.
- Breadcrumb: crumb vuoto sulle pagine sotto gli stub di lingua (es.
  `Home / [vuoto] / Guide di configurazione / …` su `/it/…/guides/ollama/`) — gli stub
  (`_index.it.html` ecc.) non hanno Title. Il partial ora salta gli antenati senza
  titolo ma **non** la home.

## Verifica eseguita

- **anubis invariato**: `diff -r baseline vs rebuild` mostra differenze **solo** nelle
  29 pagine renderizzate dai contenuti modificati nel commit del passaggio contenuti
  (i contenuti sono condivisi tra le due configurazioni; il tema nuovo non è
  referenziato da `config.toml`, quindi non può influenzare la build anubis). Zero
  differenze altrove; `config.toml` e `themes/anubis/**` intoccati (verificato con
  `git diff`).
- Build nuova: 88 pagine, 105 file HTML (baseline 106: manca solo l'alias `/page/1/`,
  vedi sotto), **zero warning**.
- **18 alias legacy** `thunderdbird-addon-*` presenti e puntanti come la baseline.
- **Stub di redirect lingua**: `/it/ /de/ /fr/ /es/` + 4 `/xx/thunderbird-addon-thunderai/`
  rimandano agli URL EN assoluti, target identici alla baseline.
- **Visual check** (headless Edge su `hugo server`): home dark+light 1440, ThunderAI
  dark+light 1440, dynamic-menu, 404, guida IT tradotta; footer-on-photo leggibile
  (scrim 0.90 sul fondo → peggio caso ≈ 14:1, oltre il 4.5:1 richiesto).
- **Contenuti**: badge `active`/`discontinued` popolati, hero a 2 colonne con icona
  128px + box donazione, griglie "Documentation & support", callout discontinued, 14
  link "Go back to addon page" convertiti a `p.go-back`.

## Cose sapute (non bug del tema)

1. **Alias `/page/1/` assente** nella build nuova (19→18): era un artefatto della chiamata
   `.Paginate` nell'index di anubis; la nuova home non ha listing, quindi Hugo non lo
   genera. L'URL non esisteva come pagina reale.
2. **Link immagine rotto pre-esistente**: `docker_windows.png` in
   `ollama-cors-information.html` esiste solo in `docs/`, non in `static/` — nella build
   nuova (e in quella anubis di sviluppo) l'immagine è rotta. Da sistemare a monte
   (copiare l'immagine in `static/images/`), fuori dal perimetro del tema.
3. **404 bilingue**: `content/_404.html` ha già nel front matter
   `Title = "Pagina non trovata! / Page not found!"` e testo IT+EN nello stesso file.
   Il tema lo renderizza correttamente; è una peculiarità del contenuto condivisa con
   anubis, non toccata.
4. **Inline `<style>` lasciati**: le 30+ pagine `guides/*` e le 5 `ollama-cors-*` hanno
   blocchi `<style>` inline per le tabelle. Decisione: lasciati com'erano — lo stile
   tabelle del tema funziona in light, e in dark i bordi `#ccc` sono accettabili
   (comportamento identico al dark.css attuale). Forzare override avrebbe rotto i layout
   tabellari borderless di ollama-cors.
5. **Pagina addons**: la sezione "Discontinued addons" ora ha l'h2 separato dal link
   "Find out why" (prima il link era dentro l'h2).
6. **Versione CSS**: `head.html` referenzia `css/theme.css?v=20260918`; da incrementare
   ad ogni modifica futura di theme.css per invalidare la cache.

## Commits (branch `new_style`)

- `cf98c37` — tema: shortcode `page_title` + `list-thunderbird-pages` riscritti
- `0363207` — contenuti: hero addon, doc-grid, go-back, pulizia sotto-pagine (29 file)
- (questo commit) — tema: fix `body.home` + breadcrumb stub di lingua

Prima ancora: `4ad65d2` scaffold + architettura, `21d88dc` token/typography/theme-init,
`9905d47` site published (storia precedente).