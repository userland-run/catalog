#!/usr/bin/env node
// jfmt — pretty-print a JSON file with a 2-space indent. Zero dependencies;
// runs on the nano `node` runner (host Node engine). ESM so it stays
// format-unambiguous under Node's module-syntax detection.
//   usage: jfmt <file.json>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: jfmt <file.json>\n");
  process.exit(2);
}
try {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
} catch (e) {
  process.stderr.write(`jfmt: ${e.message}\n`);
  process.exit(1);
}
