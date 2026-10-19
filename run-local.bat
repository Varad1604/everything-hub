@echo off
cd /d "%~dp0"
npx wrangler@4 dev -c wrangler.local.jsonc --port 8787 --ip 127.0.0.1
