#!/bin/sh
cd "$(dirname "$0")"
exec npx wrangler@4 dev -c wrangler.local.jsonc --port 8787 --ip 127.0.0.1
