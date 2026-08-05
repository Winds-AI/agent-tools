# Exa Web

Adds two Exa-powered tools to Pi:

- `exa_search` for web search
- `exa_get_contents` for extracting text, highlights, or summaries from URLs

## Install

Clone the collection, install this package's dependency, and add it to Pi by local path:

```bash
git clone https://github.com/Winds-AI/pi-extensions.git
cd pi-extensions/exa-web
npm install
cp .env.example .env
# Edit .env and set EXA_API_KEY
pi install "$PWD"
```

Restart Pi after installation. A shell-provided `EXA_API_KEY` takes precedence over the package's `.env` file.

Get an API key from <https://dashboard.exa.ai/api-keys>.

## Notes

Large API responses are truncated for model context and written in full to a temporary JSON file. The tools support Exa search categories, domain filters, publication dates, contents options, and cache-age controls.
