# Exa Web

Adds two Exa-powered tools to Pi:

- `exa_search` for web search
- `exa_get_contents` for extracting text, highlights, or summaries from URLs

## Install

Clone the repository, copy `.env.example` to `.env` in `pi/pi-extensions/pi-exa-web`, set `EXA_API_KEY`, and run `pi install ./pi/pi-extensions/pi-exa-web` from the repository root. Pi installs the declared `dotenv` runtime dependency automatically. A shell-provided `EXA_API_KEY` takes precedence over the package's `.env` file.

Get an API key from <https://dashboard.exa.ai/api-keys>.

## Notes

Large API responses are truncated for model context and written in full to a temporary JSON file. The tools support Exa search categories, domain filters, publication dates, contents options, and cache-age controls.
