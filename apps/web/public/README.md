# Static files

Anything here is served from the site root: `public/robots.txt` becomes
`/robots.txt`. The panel ships nothing by default — the favicon is
`src/app/icon.svg`, which Next wires into the document head itself — but the
directory is kept because the web image copies it, and an operator branding
their own deployment usually starts here.
